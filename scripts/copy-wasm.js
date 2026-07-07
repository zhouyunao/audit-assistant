// Copy the tree-sitter runtime and per-language grammar wasm files into grammars/, bundled with the extension.
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

// web-tree-sitter runtime wasm
const runtime = path.join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
fs.copyFileSync(runtime, path.join(outDir, 'tree-sitter.wasm'));

console.log(`[copy-wasm] copied ${copied} grammars + runtime -> grammars/`);
