// Verify that esbuild-bundled web-tree-sitter initializes correctly (regression for the import.meta.url bundling issue).
// Bundle an entry that uses ParserPool with the same esbuild config as dist, then run it in plain Node.
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function main() {
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-bundle-smoke-'));
  const entry = path.join(tmp, 'entry.ts');
  const outfile = path.join(tmp, 'bundle.js');

  fs.writeFileSync(
    entry,
    `
import { ParserPool } from '${path.join(root, 'src/indexer/parser').replace(/\\/g, '/')}';
import { ProjectIndex } from '${path.join(root, 'src/indexer/indexer').replace(/\\/g, '/')}';

async function run() {
  const pool = new ParserPool('${path.join(root, 'grammars').replace(/\\/g, '/')}');
  const index = new ProjectIndex(pool);
  const fi = await index.indexFile('a.js', 'function f(x) { return eval(x); }');
  if (!fi || fi.symbols[0]?.name !== 'f' || fi.calls[0]?.callee !== 'eval') {
    throw new Error('unexpected index result: ' + JSON.stringify(fi));
  }
  console.log('bundle smoke OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
`,
  );

  // key config kept in sync with esbuild.js
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    external: ['vscode'],
    define: { 'import.meta.url': '__esbuild_import_meta_url' },
    banner: {
      js: "const __esbuild_import_meta_url = require('node:url').pathToFileURL(__filename).href;",
    },
  });

  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [outfile], { encoding: 'utf8' });
  process.stdout.write(out);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
