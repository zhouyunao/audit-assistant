import { Node } from 'web-tree-sitter';
import { LanguageSpec } from './languages';
import { SymbolInfo } from '../types';

const IDENTIFIER_TYPES = new Set([
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'qualified_identifier',
  'scoped_identifier',
  'name',
]);

/** Name of a function/class definition node: prefer the `name` field, else descend the declarator chain (C/C++). */
function definitionName(node: Node): string | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return nameNode.text;
  }
  let decl = node.childForFieldName('declarator');
  while (decl) {
    if (IDENTIFIER_TYPES.has(decl.type)) {
      return decl.text;
    }
    const inner = decl.childForFieldName('declarator') ?? decl.childForFieldName('name');
    if (!inner) {
      break;
    }
    decl = inner;
  }
  return undefined;
}

/** Walk up to find the nearest enclosing class container name. */
function containerName(node: Node, spec: LanguageSpec): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (spec.classNodes.includes(cur.type)) {
      return cur.childForFieldName('name')?.text;
    }
    cur = cur.parent;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

function makeSymbol(
  file: string,
  name: string,
  kind: SymbolInfo['kind'],
  node: Node,
  container?: string,
): SymbolInfo {
  const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter_list');
  return {
    id: `${file}#${name}@${node.startPosition.row}`,
    name,
    kind,
    container,
    file,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: params ? truncate(params.text, 80) : undefined,
  };
}

/** Whether the node is a function value (JS/TS arrow function or function expression). */
function isFunctionValue(node: Node | null): boolean {
  return !!node && ['arrow_function', 'function_expression', 'function', 'generator_function'].includes(node.type);
}

export function extractSymbols(root: Node, spec: LanguageSpec, file: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();

  const push = (sym: SymbolInfo) => {
    if (!seen.has(sym.id)) {
      seen.add(sym.id);
      symbols.push(sym);
    }
  };

  const visit = (node: Node) => {
    if (spec.functionNodes.includes(node.type)) {
      const name = definitionName(node);
      if (name) {
        const container = containerName(node, spec);
        const kind = container || node.type.includes('method') ? 'method' : 'function';
        push(makeSymbol(file, name, kind, node, container));
      }
    } else if (spec.classNodes.includes(node.type)) {
      const name = definitionName(node);
      if (name) {
        push(makeSymbol(file, name, 'class', node));
      }
    } else if (spec.arrowAssignments && node.type === 'variable_declarator') {
      // const handler = async (req, res) => {...}
      if (isFunctionValue(node.childForFieldName('value'))) {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          push(makeSymbol(file, name, 'function', node));
        }
      }
    } else if (spec.arrowAssignments && node.type === 'assignment_expression') {
      // exports.handler = (req) => {...}
      if (isFunctionValue(node.childForFieldName('right'))) {
        const left = node.childForFieldName('left')?.text;
        if (left) {
          const name = left.split('.').pop()!;
          push(makeSymbol(file, name, 'function', node));
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child) {
        visit(child);
      }
    }
  };

  visit(root);
  return symbols;
}
