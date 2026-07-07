import { Node } from 'web-tree-sitter';
import { LanguageSpec } from './languages';

/** Node types for import/include/using declarations across languages */
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

/** Child node types within an import target that can serve as the module name */
const TARGET_TYPES = ['dotted_name', 'relative_import', 'scoped_identifier', 'qualified_name', 'identifier', 'asterisk'];

function stripQuotes(s: string): string {
  return s.replace(/^["'<]+|[">']+$/g, '');
}

/** Extract a file's raw import targets (unresolved; path resolution happens in architecture). */
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
    // java import a.b.C; / python import a.b / c# using A.B; / php use A\\B;
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

  // JS-family require('x') / dynamic import('x'); PHP include/require 'x'
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
 * Resolve a raw import target to a file within the workspace (best-effort; returns undefined
 * for unresolvable targets, treated as external dependencies).
 * allFiles is the set of all indexed files' relative paths (/ separated).
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

  // Relative path (js/ts/php/c include)
  if (imp.startsWith('.')) {
    return tryCandidates(normalize(`${dir}/${imp}`));
  }
  // c include "a/b.h": try relative to the current dir first, then match by basename globally
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
  // Dot/backslash separated (java, python, c#, php namespace) -> convert to a path and match by suffix
  const asPath = imp.replace(/\./g, '/').replace(/\\/g, '/').replace(/\/\*$/, '');
  for (const f of allFiles) {
    const noExt = f.replace(/\.[^./]+$/, '');
    if (noExt === asPath || noExt.endsWith(`/${asPath}`)) {
      return f;
    }
    // python: package directory __init__.py
    if (f === `${asPath}/__init__.py` || f.endsWith(`/${asPath}/__init__.py`)) {
      return f;
    }
  }
  // go: an import path suffix is a directory -> left to directory-level aggregation; return undefined
  return undefined;
}
