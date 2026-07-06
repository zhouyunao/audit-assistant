const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    // web-tree-sitter 是 ESM 包，内部用 import.meta.url 定位自身；
    // 打成 CJS 后该值会变成 undefined，导致 createRequire/fileURLToPath 报
    // "filename must be a file URL ... Received undefined"。用 __filename 补上。
    define: { 'import.meta.url': '__esbuild_import_meta_url' },
    banner: {
      js: "const __esbuild_import_meta_url = require('node:url').pathToFileURL(__filename).href;",
    },
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
