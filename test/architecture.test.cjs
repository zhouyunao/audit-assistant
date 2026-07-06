const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ParserPool } = require('../out/indexer/parser');
const { ProjectIndex } = require('../out/indexer/indexer');
const { resolveImport } = require('../out/indexer/imports');
const { buildModuleGraph, renderTree, makeModuleAssigner } = require('../out/features/architecture');

const grammars = path.join(__dirname, '..', 'grammars');
const pool = new ParserPool(grammars);

test('imports: javascript import/require', async () => {
  const index = new ProjectIndex(pool);
  const fi = await index.indexFile(
    'src/api/user.js',
    ["import db from '../db/conn';", "const util = require('./util');", "export { x } from './x';"].join('\n'),
  );
  assert.deepEqual(fi.imports.sort(), ['../db/conn', './util', './x']);
});

test('imports: python / java / go / c', async () => {
  const index = new ProjectIndex(pool);
  const py = await index.indexFile('app/views.py', 'import os\nfrom app.models import User');
  assert.ok(py.imports.includes('os'));
  assert.ok(py.imports.includes('app.models'));

  const java = await index.indexFile('src/Main.java', 'import com.foo.Bar;\nclass Main {}');
  assert.ok(java.imports.includes('com.foo.Bar'));

  const go = await index.indexFile('cmd/main.go', 'package main\nimport "myapp/util"\nfunc main() {}');
  assert.ok(go.imports.includes('myapp/util'));

  const c = await index.indexFile('src/a.c', '#include "util.h"\n#include <stdio.h>\nint f() { return 0; }');
  assert.ok(c.imports.includes('util.h'));
  assert.ok(c.imports.includes('stdio.h'));
});

test('resolveImport: relative, dotted, header basename', () => {
  const files = new Set([
    'src/api/user.js',
    'src/db/conn.js',
    'src/api/util/index.js',
    'app/models.py',
    'app/pkg/__init__.py',
    'src/main/java/com/foo/Bar.java',
    'include/util.h',
  ]);
  assert.equal(resolveImport('src/api/user.js', '../db/conn', files), 'src/db/conn.js');
  assert.equal(resolveImport('src/api/user.js', './util', files), 'src/api/util/index.js');
  assert.equal(resolveImport('app/views.py', 'app.models', files), 'app/models.py');
  assert.equal(resolveImport('app/views.py', 'app.pkg', files), 'app/pkg/__init__.py');
  assert.equal(resolveImport('src/Main.java', 'com.foo.Bar', files), 'src/main/java/com/foo/Bar.java');
  assert.equal(resolveImport('src/a.c', 'util.h', files), 'include/util.h');
  assert.equal(resolveImport('src/api/user.js', 'express', files), undefined);
});

test('module assigner: expands dominant top dir', () => {
  const assign = makeModuleAssigner(['src/api/a.js', 'src/api/b.js', 'src/db/c.js', 'scripts/x.js']);
  assert.equal(assign('src/api/a.js'), 'src/api');
  assert.equal(assign('src/db/c.js'), 'src/db');
  assert.equal(assign('scripts/x.js'), 'scripts');
  assert.equal(assign('README.js'), '(root)');
});

test('buildModuleGraph + renderTree: import and call edges aggregate to modules', async () => {
  const index = new ProjectIndex(pool);
  await index.indexFile('src/db/conn.js', 'function rawQuery(sql) { return driver.exec(sql); }');
  await index.indexFile(
    'src/api/user.js',
    ["import conn from '../db/conn';", 'const get = (req) => rawQuery(req.query.id);'].join('\n'),
  );
  await index.indexFile('src/api/order.js', "import conn from '../db/conn';");

  const graph = buildModuleGraph(index.allFiles(), index);
  const names = graph.modules.map((m) => m.name).sort();
  assert.deepEqual(names, ['src/api', 'src/db']);
  const edge = graph.edges.find((e) => e.from === 'src/api' && e.to === 'src/db');
  assert.ok(edge, 'api -> db edge expected');
  assert.ok(edge.weight >= 2, 'two imports + one call edge should aggregate');

  const api = graph.modules.find((m) => m.name === 'src/api');
  api.description = '对外 HTTP 接口';
  assert.equal(api.loc, 3, 'src/api 两个文件共 3 行');
  const tree = renderTree(index.allFiles(), graph.modules, graph.edges);
  assert.match(tree, /^\.\/ \(共 3 个文件, 4 行\)/);
  assert.match(tree, /└── src\/ \(3 个文件, 4 行\)/);
  assert.match(tree, /api\/ \(2 个文件, 3 行\) — 对外 HTTP 接口/);
  assert.match(tree, /\[依赖 → src\/db\]/);
});

test('renderTree: depth cap, child cap, LOC aggregation', () => {
  const files = [];
  for (let d = 0; d < 40; d++) {
    files.push({ file: `top/dir${d}/deep/deeper/deepest/f.js`, lines: 10 });
  }
  const tree = renderTree(files, [], [], 3);
  assert.match(tree, /^\.\/ \(共 40 个文件, 400 行\)/);
  assert.match(tree, /… 其余 10 个目录/);
  assert.ok(!tree.includes('deepest'), 'depth beyond cap should be elided');
  assert.match(tree, /deep\/ \(1 个文件, 10 行\) …/);
});
