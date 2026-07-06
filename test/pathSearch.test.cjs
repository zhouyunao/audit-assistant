const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ParserPool } = require('../out/indexer/parser');
const { ProjectIndex } = require('../out/indexer/indexer');
const { searchChainsFromSink } = require('../out/features/taint/pathSearch');

const grammars = path.join(__dirname, '..', 'grammars');
const pool = new ParserPool(grammars);

const ROUTES = ['const handler = (req) => {', '  const id = req.query.id;', '  service(id);', '};'].join('\n');
const SERVICE = ['function service(x) {', '  dao(x);', '}'].join('\n');
const DAO = ['function dao(v) {', '  db.query("select * from t where id=" + v);', '}'].join('\n');

async function buildIndex() {
  const index = new ProjectIndex(pool);
  await index.indexFile('routes.js', ROUTES);
  await index.indexFile('service.js', SERVICE);
  await index.indexFile('dao.js', DAO);
  return index;
}

test('reverse search reaches source across files', async () => {
  const index = await buildIndex();
  const sinkLine = 2; // db.query 行（1-based）
  const sourceMarks = [{ id: 'src1', kind: 'source', status: 'candidate', file: 'routes.js', line: 2 }];
  const chains = searchChainsFromSink(index, 'dao.js', sinkLine, { sourceMarks });

  assert.ok(chains.length >= 1);
  const best = chains[0];
  const names = best.hops.map((h) => h.name);
  assert.deepEqual(names, ['handler', 'service', 'dao'], 'entry→sink order');
  assert.equal(best.reachedSourceMarkId, 'src1', 'source mark detected');
  // sink 跳锚定到 sink 行
  assert.equal(best.hops[best.hops.length - 1].line, sinkLine);
});

test('without source marks, terminates at entry (no callers)', async () => {
  const index = await buildIndex();
  const chains = searchChainsFromSink(index, 'dao.js', 2, {});
  assert.ok(chains.length >= 1);
  const best = chains[0];
  assert.equal(best.hops[0].name, 'handler');
  assert.ok(best.entryReason, 'entryReason set when reaching a caller-less function');
});

test('entry-name heuristic (doGet) recognized', async () => {
  const index = new ProjectIndex(pool);
  await index.indexFile('C.java', ['class C {', '  public void doGet(HttpServletRequest r) { sink(r); }', '  void sink(Object o) { Runtime.getRuntime().exec(o.toString()); }', '}'].join('\n'));
  const chains = searchChainsFromSink(index, 'C.java', 3, {});
  const withEntry = chains.find((c) => /doGet/.test(c.entryReason || ''));
  assert.ok(withEntry, 'doGet recognized as entry');
});

test('cycle guard: recursive calls do not hang and are bounded', async () => {
  const index = new ProjectIndex(pool);
  await index.indexFile('r.js', ['function a() { b(); danger(); }', 'function b() { a(); }'].join('\n'));
  const chains = searchChainsFromSink(index, 'r.js', 1, { maxDepth: 8 });
  assert.ok(chains.length >= 1);
  for (const c of chains) {
    const ids = c.hops.filter((h) => h.symbolId).map((h) => h.symbolId);
    assert.equal(new Set(ids).size, ids.length, 'no repeated symbol within a path');
  }
});

test('sink at top-level returns single-hop chain', async () => {
  const index = new ProjectIndex(pool);
  await index.indexFile('top.js', ['db.query("x")'].join('\n'));
  const chains = searchChainsFromSink(index, 'top.js', 1, {});
  assert.equal(chains.length, 1);
  assert.equal(chains[0].hops.length, 1);
});
