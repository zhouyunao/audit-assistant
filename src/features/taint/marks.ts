import { Mark, SymbolInfo } from '../../types';

/** 标记 id 按位置定：同一 (kind, file, line) 唯一，人工标记与扫描候选可自然合并/升级 */
export function markId(kind: 'source' | 'sink', file: string, line1: number): string {
  return `${kind}:${file}:${line1}`;
}

export interface ManualMarkInput {
  kind: 'source' | 'sink';
  file: string;
  /** 1-based */
  line: number;
  symbol?: string;
  anchor?: string;
  author: string;
}

/**
 * 人工标记：若该位置已有扫描候选则升级为已确认（保留 category/cwe/ruleId），否则新建。
 */
export function applyManualMark(existing: Mark[], input: ManualMarkInput, now: string): Mark {
  const id = markId(input.kind, input.file, input.line);
  const prior = existing.find((m) => m.id === id);
  return {
    id,
    kind: input.kind,
    status: 'confirmed',
    origin: 'manual',
    file: input.file,
    symbol: input.symbol ?? prior?.symbol,
    line: input.line,
    anchor: input.anchor ?? prior?.anchor,
    category: prior?.category,
    cwe: prior?.cwe,
    ruleId: prior?.ruleId,
    note: prior?.note,
    author: input.author,
    time: now,
  };
}

export function symbolAt(symbols: SymbolInfo[] | undefined, line0: number): SymbolInfo | undefined {
  if (!symbols) {
    return undefined;
  }
  let best: SymbolInfo | undefined;
  for (const s of symbols) {
    if (s.startLine <= line0 && line0 <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}
