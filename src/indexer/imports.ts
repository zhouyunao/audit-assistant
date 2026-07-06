import { Node } from 'web-tree-sitter';
import { LanguageSpec } from './languages';

/** 各语言 import/include/using 声明的节点类型 */
const IMPORT_NODE_TYPES = [
  'import_statement', // js/ts/python
  'import_from_statement', // python
  'import_declaration', // java
  'import_spec', // go
  'namespace_use_declaration', // php use
  'preproc_include', // c/cpp
  'using_directive', // c#
  'export_statement', // js/ts re-export
];

/** import 目标里可作为模块名的子节点类型 */
const TARGET_TYPES = ['dotted_name', 'relative_import', 'scoped_identifier', 'qualified_name', 'identifier', 'asterisk'];

function stripQuotes(s: string): string {
  return s.replace(/^["'<]+|[">']+$/g, '');
}

/** 提取文件的原始 import 目标（不解析成路径，解析在 architecture 里做） */
export function extractImports(root: Node, spec: LanguageSpec): string[] {
  const imports = new Set<string>();

  for (const node of root.descendantsOfType(IMPORT_NODE_TYPES)) {
    if (!node) {
      continue;
    }
    const byField =
      node.childForFieldName('source') ?? // js/ts import ... from 'x' / export ... from 'x'
      node.childForFieldName('path') ?? // go import_spec / c preproc_include
      node.childForFieldName('module_name'); // python from X import
    if (byField) {
      const v = stripQuotes(byField.text);
      if (v) {
        imports.add(v);
      }
      continue;
    }
    // java import a.b.C; / python import a.b / c# using A.B; / php use A\B;
    for (const child of node.namedChildren) {
      if (child && TARGET_TYPES.includes(child.type)) {
        imports.add(child.text);
      } else if (child && child.type === 'namespace_use_clause') {
        const name = child.namedChildren[0]?.text;
        if (name) {
          imports.add(name);
        }
      }
    }
  }

  // JS 系的 require('x') / 动态 import('x')；PHP 的 include/require 'x'
  if (spec.arrowAssignments || spec.id === 'php') {
    const extra = root.descendantsOfType(['call_expression', 'include_expression', 'require_expression', 'include_once_expression', 'require_once_expression']);
    for (const node of extra) {
      if (!node) {
        continue;
      }
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function')?.text;
        if (fn !== 'require' && fn !== 'import') {
          continue;
        }
      }
      const str = node.descendantsOfType('string')[0] ?? node.descendantsOfType('string_literal')[0];
      const v = str ? stripQuotes(str.text) : '';
      if (v) {
        imports.add(v);
      }
    }
  }

  return [...imports];
}

const EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'py', 'java', 'go', 'php', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs'];

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/**
 * 把原始 import 目标解析成工作区内的文件（尽力而为，解析不了视为外部依赖返回 undefined）。
 * allFiles 为工作区内全部已索引文件的相对路径（/ 分隔）。
 */
export function resolveImport(fromFile: string, imp: string, allFiles: Set<string>): string | undefined {
  const dir = fromFile.includes('/') ? fromFile.replace(/\/[^/]*$/, '') : '';

  const tryCandidates = (base: string): string | undefined => {
    const cands = [base];
    for (const ext of EXTENSIONS) {
      cands.push(`${base}.${ext}`, `${base}/index.${ext}`, `${base}/__init__.py`);
    }
    for (const c of cands) {
      if (allFiles.has(c)) {
        return c;
      }
    }
    return undefined;
  };

  // 相对路径（js/ts/php/c include）
  if (imp.startsWith('.')) {
    return tryCandidates(normalize(`${dir}/${imp}`));
  }
  // c include "a/b.h"：先相对当前目录，再全局 basename 匹配
  if (/\.(h|hpp|hh|c|cpp|php)$/.test(imp)) {
    const rel = tryCandidates(normalize(`${dir}/${imp}`));
    if (rel) {
      return rel;
    }
    const suffix = normalize(imp);
    for (const f of allFiles) {
      if (f === suffix || f.endsWith(`/${suffix}`)) {
        return f;
      }
    }
    return undefined;
  }
  // 点/反斜杠分隔（java、python、c#、php namespace）→ 转路径后按后缀匹配
  const asPath = imp.replace(/\./g, '/').replace(/\\/g, '/').replace(/\/\*$/, '');
  for (const f of allFiles) {
    const noExt = f.replace(/\.[^./]+$/, '');
    if (noExt === asPath || noExt.endsWith(`/${asPath}`)) {
      return f;
    }
    // python: 包目录 __init__.py
    if (f === `${asPath}/__init__.py` || f.endsWith(`/${asPath}/__init__.py`)) {
      return f;
    }
  }
  // go：import 路径后缀是目录 → 记到该目录下任意文件？留给目录级聚合，返回 undefined
  return undefined;
}
