// 把 tree-sitter 运行时和各语言 grammar 的 wasm 拷贝到 grammars/，随扩展打包。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'grammars');
fs.mkdirSync(outDir, { recursive: true });

const grammars = [
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-php.wasm',
  'tree-sitter-c.wasm',
  'tree-sitter-cpp.wasm',
  'tree-sitter-c_sharp.wasm',
];

const wasmSrc = path.join(root, 'node_modules', 'tree-sitter-wasms', 'out');
let copied = 0;
for (const name of grammars) {
  const src = path.join(wasmSrc, name);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-wasm] missing grammar: ${name}`);
    continue;
  }
  fs.copyFileSync(src, path.join(outDir, name));
  copied++;
}

// web-tree-sitter 的运行时 wasm
const runtime = path.join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
fs.copyFileSync(runtime, path.join(outDir, 'tree-sitter.wasm'));

console.log(`[copy-wasm] copied ${copied} grammars + runtime -> grammars/`);
