const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ParserPool } = require('../out/indexer/parser');
const { ProjectIndex } = require('../out/indexer/indexer');
const { TAINT_RULES } = require('../out/features/taint/rules');
const { compileRules, scanFile, mergeCandidates } = require('../out/features/taint/candidates');
const { applyManualMark, markId } = require('../out/features/taint/marks');

const grammars = path.join(__dirname, '..', 'grammars');
const pool = new ParserPool(grammars);
const compiled = compileRules(TAINT_RULES);
const NOW = '2026-07-06T00:00:00.000Z';

async function scan(file, code) {
  const index = new ProjectIndex(pool);
  const fi = await index.indexFile(file, code);
  const lines = code.split(/\r?\n/);
  return scanFile({ file, languageId: fi.languageId, lines, calls: fi.calls, symbols: fi.symbols }, compiled, NOW);
}

function has(marks, kind, predicate) {
  return marks.some((m) => m.kind === kind && predicate(m));
}

test('java: sink executeQuery + source getParameter', async () => {
  const marks = await scan(
    'src/UserDao.java',
    [
      'public class UserDao {',
      '  public Object find(HttpServletRequest req) throws Exception {',
      '    String id = req.getParameter("id");',
      '    return stmt.executeQuery("select * from users where id=" + id);',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.ok(has(marks, 'sink', (m) => m.category === 'SQL Execution' && m.line === 4), 'executeQuery sink');
  assert.ok(has(marks, 'source', (m) => m.category === 'HTTP Input' && m.line === 3), 'getParameter source');
  // the enclosing function should be anchored to find
  assert.equal(marks.find((m) => m.kind === 'sink').symbol, 'find');
});

test('python: subprocess sink + request source + os.environ', async () => {
  const marks = await scan(
    'app/views.py',
    ['import subprocess', 'def run(request):', '    cmd = request.args.get("c")', '    subprocess.run(cmd, shell=True)', '    token = os.environ["T"]'].join('\n'),
  );
  assert.ok(has(marks, 'sink', (m) => m.category === 'Command Execution'), 'subprocess.run sink');
  assert.ok(has(marks, 'source', (m) => m.category === 'HTTP Input'), 'request.args source');
  assert.ok(has(marks, 'source', (m) => m.line === 5), 'os.environ source');
});

test('php: superglobal source + system sink + unserialize', async () => {
  const marks = await scan(
    'web/api.php',
    ['<?php', '$cmd = $_GET["c"];', 'system($cmd);', '$obj = unserialize($_POST["data"]);'].join('\n'),
  );
  assert.ok(has(marks, 'source', (m) => m.line === 2), '$_GET source');
  assert.ok(has(marks, 'sink', (m) => m.category === 'Command Execution' && m.line === 3), 'system sink');
  assert.ok(has(marks, 'sink', (m) => m.category === 'Unsafe Deserialization' && m.line === 4), 'unserialize sink');
});

test('js: eval sink + req.query source + innerHTML text sink', async () => {
  const marks = await scan(
    'src/app.js',
    ['const handler = (req, res) => {', '  const q = req.query.id;', '  eval(q);', '  el.innerHTML = q;', '};'].join('\n'),
  );
  assert.ok(has(marks, 'source', (m) => m.line === 2), 'req.query source');
  assert.ok(has(marks, 'sink', (m) => m.category === 'Code Execution' && m.line === 3), 'eval sink');
  assert.ok(has(marks, 'sink', (m) => m.category === 'XSS' && m.line === 4), 'innerHTML sink');
});

test('go: exec.Command sink + FormValue source', async () => {
  const marks = await scan(
    'main.go',
    ['package main', 'import "os/exec"', 'func h(r *http.Request) {', '  c := r.FormValue("c")', '  exec.Command("sh", "-c", c).Run()', '}'].join('\n'),
  );
  assert.ok(has(marks, 'sink', (m) => m.category === 'Command Execution'), 'exec.Command sink');
  assert.ok(has(marks, 'source', (m) => m.category === 'HTTP Input'), 'FormValue source');
});

test('language filtering: php superglobal pattern does not fire in python', async () => {
  const marks = await scan('x.py', 'x = "$_GET is just text here"');
  assert.equal(marks.length, 0);
});

test('dedup: one candidate per (kind, line)', async () => {
  const marks = await scan('a.py', 'subprocess.run(request.args.get("c"))');
  const sinkLines = marks.filter((m) => m.kind === 'sink').map((m) => m.line);
  assert.equal(new Set(sinkLines).size, sinkLines.length, 'no duplicate sink on same line');
});

test('mergeCandidates: preserves user decisions, drops stale candidates', () => {
  const confirmed = { id: markId('sink', 'a.js', 3), kind: 'sink', status: 'confirmed', origin: 'manual', file: 'a.js', line: 3, author: 'me', time: NOW };
  const excluded = { id: markId('sink', 'a.js', 5), kind: 'sink', status: 'excluded', origin: 'scan', file: 'a.js', line: 5, author: '', time: NOW };
  const staleCandidate = { id: markId('sink', 'a.js', 9), kind: 'sink', status: 'candidate', origin: 'scan', file: 'a.js', line: 9, author: '', time: NOW };
  const existing = [confirmed, excluded, staleCandidate];

  const rescan = [
    { id: markId('sink', 'a.js', 3), kind: 'sink', status: 'candidate', origin: 'scan', file: 'a.js', line: 3, author: '', time: NOW },
    { id: markId('sink', 'a.js', 12), kind: 'sink', status: 'candidate', origin: 'scan', file: 'a.js', line: 12, author: '', time: NOW },
  ];

  const merged = mergeCandidates(existing, rescan);
  const byId = new Map(merged.map((m) => [m.id, m]));
  assert.equal(byId.get(markId('sink', 'a.js', 3)).status, 'confirmed', 'confirmed not overwritten by candidate');
  assert.ok(byId.has(markId('sink', 'a.js', 5)), 'excluded kept');
  assert.ok(!byId.has(markId('sink', 'a.js', 9)), 'stale candidate dropped');
  assert.ok(byId.has(markId('sink', 'a.js', 12)), 'new candidate added');
});

test('applyManualMark: upgrades scan candidate to confirmed, keeps category', () => {
  const candidate = { id: markId('sink', 'a.js', 3), kind: 'sink', status: 'candidate', origin: 'scan', file: 'a.js', line: 3, category: 'SQL Execution', cwe: 'CWE-89', author: '', time: NOW };
  const mark = applyManualMark([candidate], { kind: 'sink', file: 'a.js', line: 3, symbol: 'find', author: 'alice' }, NOW);
  assert.equal(mark.status, 'confirmed');
  assert.equal(mark.origin, 'manual');
  assert.equal(mark.category, 'SQL Execution', 'inherits category from prior candidate');
  assert.equal(mark.author, 'alice');
});
