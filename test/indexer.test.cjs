const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ParserPool } = require('../out/indexer/parser');
const { ProjectIndex } = require('../out/indexer/indexer');
const { splitChunks } = require('../out/features/fileAnalysis');
const { tryParseJson } = require('../out/llm/client');

const grammars = path.join(__dirname, '..', 'grammars');
const pool = new ParserPool(grammars);
const index = new ProjectIndex(pool);

function names(fi) {
  return fi.symbols.map((s) => s.name);
}
function callees(fi) {
  return fi.calls.map((c) => c.callee);
}

test('javascript: functions, arrow assignments, classes, calls', async () => {
  const fi = await index.indexFile(
    'src/app.js',
    [
      'function readInput(req) { return req.query.q; }',
      'const handler = (req, res) => {',
      '  const q = readInput(req);',
      '  db.query("select * from t where x=" + q);',
      '};',
      'exports.main = () => handler();',
      'class Service {',
      '  run() { return new Service(); }',
      '}',
    ].join('\n'),
  );
  assert.ok(fi, 'js should be indexed');
  for (const n of ['readInput', 'handler', 'main', 'Service', 'run']) {
    assert.ok(names(fi).includes(n), `missing symbol ${n}`);
  }
  for (const c of ['readInput', 'query', 'handler', 'Service']) {
    assert.ok(callees(fi).includes(c), `missing call ${c}`);
  }
  // 调用点归属：db.query 发生在 handler 内
  const queryCall = fi.calls.find((c) => c.callee === 'query');
  assert.match(queryCall.fromSymbol, /#handler@/);
});

test('typescript: symbols and calls', async () => {
  const fi = await index.indexFile(
    'src/svc.ts',
    [
      'export function parse(input: string): string { return input; }',
      'export const handle = async (req: any) => { eval(parse(req.body)); };',
      'interface Repo { find(id: string): void }',
    ].join('\n'),
  );
  assert.ok(names(fi).includes('parse'));
  assert.ok(names(fi).includes('handle'));
  assert.ok(names(fi).includes('Repo'));
  assert.ok(callees(fi).includes('eval'));
  assert.ok(callees(fi).includes('parse'));
});

test('python: class methods, functions, attribute calls', async () => {
  const fi = await index.indexFile(
    'app/main.py',
    ['import os', 'class App:', '    def run(self, cmd):', '        os.system(cmd)', '', 'def main():', '    App().run("ls")'].join(
      '\n',
    ),
  );
  assert.ok(names(fi).includes('App'));
  assert.ok(names(fi).includes('run'));
  assert.ok(names(fi).includes('main'));
  const run = fi.symbols.find((s) => s.name === 'run');
  assert.equal(run.kind, 'method');
  assert.equal(run.container, 'App');
  assert.ok(callees(fi).includes('system'));
  assert.ok(callees(fi).includes('run'));
});

test('java: methods with container, invocations', async () => {
  const fi = await index.indexFile(
    'src/UserDao.java',
    [
      'public class UserDao {',
      '  public Object find(String id) throws Exception {',
      '    Statement stmt = conn.createStatement();',
      '    return stmt.executeQuery("select * from users where id=" + id);',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.ok(names(fi).includes('UserDao'));
  const find = fi.symbols.find((s) => s.name === 'find');
  assert.equal(find.container, 'UserDao');
  assert.ok(callees(fi).includes('createStatement'));
  assert.ok(callees(fi).includes('executeQuery'));
});

test('go: funcs and selector calls', async () => {
  const fi = await index.indexFile(
    'cmd/main.go',
    [
      'package main',
      'import "os/exec"',
      'func run(cmd string) { exec.Command("sh", "-c", cmd).Run() }',
      'func main() { run("ls") }',
    ].join('\n'),
  );
  assert.ok(names(fi).includes('run'));
  assert.ok(names(fi).includes('main'));
  assert.ok(callees(fi).includes('Command'));
  assert.ok(callees(fi).includes('run'));
});

test('php: functions, methods, member calls', async () => {
  const fi = await index.indexFile(
    'web/api.php',
    [
      '<?php',
      'class Api {',
      '  public function handle($input) { return $this->exec($input); }',
      '}',
      'function run_cmd($c) { system($c); }',
    ].join('\n'),
  );
  assert.ok(names(fi).includes('Api'));
  assert.ok(names(fi).includes('handle'));
  assert.ok(names(fi).includes('run_cmd'));
  assert.ok(callees(fi).includes('system'));
  assert.ok(callees(fi).includes('exec'));
});

test('c: function definitions and calls', async () => {
  const fi = await index.indexFile(
    'src/util.c',
    ['#include <stdlib.h>', 'int run(char *cmd) { return system(cmd); }'].join('\n'),
  );
  assert.ok(names(fi).includes('run'));
  assert.ok(callees(fi).includes('system'));
});

test('cpp: class methods and field calls', async () => {
  const fi = await index.indexFile(
    'src/runner.cpp',
    [
      'class Runner {',
      'public:',
      '  int go(const char* cmd) { return system(cmd); }',
      '};',
      'int use() { Runner r; return r.go("ls"); }',
    ].join('\n'),
  );
  assert.ok(names(fi).includes('Runner'));
  assert.ok(names(fi).includes('go'));
  assert.ok(names(fi).includes('use'));
  assert.ok(callees(fi).includes('system'));
  assert.ok(callees(fi).includes('go'));
});

test('csharp: methods, object creation, invocations', async () => {
  const fi = await index.indexFile(
    'src/Svc.cs',
    [
      'class Svc {',
      '  public string Get(string id) {',
      '    var cmd = new SqlCommand("select " + id);',
      '    return cmd.ExecuteScalar().ToString();',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.ok(names(fi).includes('Svc'));
  assert.ok(names(fi).includes('Get'));
  assert.ok(callees(fi).includes('SqlCommand'));
  assert.ok(callees(fi).includes('ExecuteScalar'));
});

test('cross-file callersOf and symbolsByName', async () => {
  await index.indexFile('lib/db.js', 'function rawQuery(sql) { return driver.exec(sql); }');
  await index.indexFile('routes/user.js', 'const get = (req) => rawQuery(req.query.id);');
  const callers = index.callersOf('rawQuery');
  assert.ok(callers.some((c) => c.file === 'routes/user.js'));
  const defs = index.symbolsByName('rawQuery', 'routes/user.js');
  assert.equal(defs[0].file, 'lib/db.js');
});

test('index cache hit: same content returns same object', async () => {
  const a = await index.indexFile('src/util.c', '#include <stdlib.h>\nint run(char *cmd) { return system(cmd); }');
  const b = await index.indexFile('src/util.c', '#include <stdlib.h>\nint run(char *cmd) { return system(cmd); }');
  assert.equal(a, b);
});

test('unsupported extension returns undefined', async () => {
  assert.equal(await index.indexFile('README.md', '# hi'), undefined);
});

test('splitChunks: covers all lines contiguously and breaks at symbols', () => {
  const lines = Array.from({ length: 100 }, (_, i) => 'x'.repeat(50) + i);
  const symbols = [10, 30, 50, 70, 90].map((l) => ({
    id: `f#s@${l}`,
    name: `s${l}`,
    kind: 'function',
    file: 'f',
    startLine: l,
    endLine: l + 5,
  }));
  const chunks = splitChunks(lines, symbols, 1500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].start, 1);
  assert.equal(chunks[chunks.length - 1].end, 100);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].start, chunks[i - 1].end + 1, 'chunks must be contiguous');
  }
});

test('tryParseJson: fences and surrounding prose', () => {
  assert.deepEqual(tryParseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(tryParseJson('结果如下：\n{"a": {"b": 2}}\n以上。'), { a: { b: 2 } });
  assert.equal(tryParseJson('not json at all'), undefined);
});
