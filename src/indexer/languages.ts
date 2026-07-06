// 各语言的 tree-sitter 节点类型表。加新语言 = 加一条 spec + copy-wasm.js 里加对应 grammar。

export interface LanguageSpec {
  id: string;
  wasm: string;
  extensions: string[];
  /** 定义函数/方法的节点类型 */
  functionNodes: string[];
  /** 定义类/接口等容器的节点类型 */
  classNodes: string[];
  /** 调用点节点类型 */
  callNodes: string[];
  /** 是否识别 `const f = () => {}` 式的函数赋值（JS/TS 系） */
  arrowAssignments?: boolean;
}

export const LANGUAGES: LanguageSpec[] = [
  {
    id: 'javascript',
    wasm: 'tree-sitter-javascript.wasm',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    functionNodes: ['function_declaration', 'generator_function_declaration', 'method_definition'],
    classNodes: ['class_declaration'],
    callNodes: ['call_expression', 'new_expression'],
    arrowAssignments: true,
  },
  {
    id: 'typescript',
    wasm: 'tree-sitter-typescript.wasm',
    extensions: ['.ts', '.mts', '.cts'],
    functionNodes: ['function_declaration', 'generator_function_declaration', 'method_definition'],
    classNodes: ['class_declaration', 'interface_declaration'],
    callNodes: ['call_expression', 'new_expression'],
    arrowAssignments: true,
  },
  {
    id: 'tsx',
    wasm: 'tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
    functionNodes: ['function_declaration', 'generator_function_declaration', 'method_definition'],
    classNodes: ['class_declaration', 'interface_declaration'],
    callNodes: ['call_expression', 'new_expression'],
    arrowAssignments: true,
  },
  {
    id: 'python',
    wasm: 'tree-sitter-python.wasm',
    extensions: ['.py'],
    functionNodes: ['function_definition'],
    classNodes: ['class_definition'],
    callNodes: ['call'],
  },
  {
    id: 'java',
    wasm: 'tree-sitter-java.wasm',
    extensions: ['.java'],
    functionNodes: ['method_declaration', 'constructor_declaration'],
    classNodes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodes: ['method_invocation', 'object_creation_expression'],
  },
  {
    id: 'go',
    wasm: 'tree-sitter-go.wasm',
    extensions: ['.go'],
    functionNodes: ['function_declaration', 'method_declaration'],
    classNodes: [],
    callNodes: ['call_expression'],
  },
  {
    id: 'php',
    wasm: 'tree-sitter-php.wasm',
    extensions: ['.php'],
    functionNodes: ['function_definition', 'method_declaration'],
    classNodes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
    callNodes: [
      'function_call_expression',
      'member_call_expression',
      'scoped_call_expression',
      'object_creation_expression',
    ],
  },
  {
    id: 'c',
    wasm: 'tree-sitter-c.wasm',
    extensions: ['.c', '.h'],
    functionNodes: ['function_definition'],
    classNodes: [],
    callNodes: ['call_expression'],
  },
  {
    id: 'cpp',
    wasm: 'tree-sitter-cpp.wasm',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
    functionNodes: ['function_definition'],
    classNodes: ['class_specifier', 'struct_specifier'],
    callNodes: ['call_expression', 'new_expression'],
  },
  {
    id: 'csharp',
    wasm: 'tree-sitter-c_sharp.wasm',
    extensions: ['.cs'],
    functionNodes: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    classNodes: ['class_declaration', 'interface_declaration', 'struct_declaration'],
    callNodes: ['invocation_expression', 'object_creation_expression'],
  },
];

const byExtension = new Map<string, LanguageSpec>();
for (const spec of LANGUAGES) {
  for (const ext of spec.extensions) {
    byExtension.set(ext, spec);
  }
}

export function specForFile(filePath: string): LanguageSpec | undefined {
  const m = filePath.match(/(\.[^./\\]+)$/);
  return m ? byExtension.get(m[1].toLowerCase()) : undefined;
}
