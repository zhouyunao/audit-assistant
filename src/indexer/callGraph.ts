import { Node } from 'web-tree-sitter';
import { LanguageSpec } from './languages';
import { CallSite, SymbolInfo } from '../types';

const CALLEE_ID_TYPES = [
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'name',
];

/**
 * 提取被调名（近似）：取调用目标里最右侧的标识符。
 * a.b.c(x) -> c；new Foo() -> Foo；query(sql) -> query
 */
function calleeName(node: Node): string | undefined {
  const target =
    node.childForFieldName('name') ??
    node.childForFieldName('function') ??
    node.childForFieldName('constructor') ??
    node.childForFieldName('type');
  if (!target) {
    return undefined;
  }
  if (CALLEE_ID_TYPES.includes(target.type)) {
    return target.text;
  }
  const ids = target.descendantsOfType(CALLEE_ID_TYPES);
  const last = ids.length ? ids[ids.length - 1] : undefined;
  return last?.text;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

export function extractCalls(root: Node, spec: LanguageSpec, file: string, symbols: SymbolInfo[]): CallSite[] {
  const calls: CallSite[] = [];
  const callNodes = root.descendantsOfType(spec.callNodes);
  for (const node of callNodes) {
    if (!node) {
      continue;
    }
    const callee = calleeName(node);
    if (!callee) {
      continue;
    }
    const line = node.startPosition.row;
    calls.push({
      callee,
      line,
      file,
      fromSymbol: enclosingSymbol(symbols, line)?.id,
      text: truncate(node.text, 120),
    });
  }
  return calls;
}

/** 包含该行的最小符号（函数/方法优先于类） */
export function enclosingSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}
