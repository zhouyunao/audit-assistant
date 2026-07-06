import { ProjectIndex } from '../../indexer/indexer';
import { enclosingSymbol } from '../../indexer/callGraph';
import { Mark, SymbolInfo } from '../../types';

/**
 * 调用链候选搜索：在近似调用图上从 sink 反向 BFS/DFS 到调用入口/source。
 * 结果是「过近似」的候选链（同名≠真调用），精度由后续 LLM 逐跳取证弥补。
 */

export interface ChainNode {
  /** 符号 id；模块顶层/无法解析时为 undefined */
  symbolId?: string;
  name: string;
  file: string;
  /** 1-based：该跳把数据传向下一跳（更靠近 sink）的位置；sink 跳为 sink 本身 */
  line: number;
}

export interface ChainCandidate {
  /** 入口 → … → sink 顺序 */
  hops: ChainNode[];
  /** 命中的 source 标记 id（如有） */
  reachedSourceMarkId?: string;
  /** 终点被判定为入口的原因（启发式命中的函数名 / 无调用者） */
  entryReason?: string;
  score: number;
}

export interface SearchOptions {
  maxDepth?: number;
  maxCallersPerNode?: number;
  maxChains?: number;
  /** 已确认/候选的 source 标记，命中即视为完整链 */
  sourceMarks?: Mark[];
}

const DEFAULTS = { maxDepth: 8, maxCallersPerNode: 8, maxChains: 20 };

// 入口函数名：只收几乎必然是框架入口、且很少被应用代码自身调用的固定签名，
// 避免 service/handle 这类通用业务方法名导致向上追溯提前终止。
const ENTRY_NAMES = new Set(['main', 'doGet', 'doPost', 'doPut', 'doDelete', 'doHead', 'ServeHTTP']);

function isEntryName(name: string): boolean {
  return ENTRY_NAMES.has(name);
}

function terminalReason(node: SymbolInfo, hadCallers: boolean): string {
  if (isEntryName(node.name)) {
    return `入口函数 ${node.name}`;
  }
  return hadCallers ? '达到深度上限' : '无调用者（可能为框架入口）';
}

function sourceMarkIn(sym: SymbolInfo, marks: Mark[] | undefined): string | undefined {
  if (!marks) {
    return undefined;
  }
  const hit = marks.find(
    (m) => m.kind === 'source' && m.status !== 'excluded' && m.file === sym.file && m.line - 1 >= sym.startLine && m.line - 1 <= sym.endLine,
  );
  return hit?.id;
}

function scoreOf(hops: ChainNode[], reachedSource: boolean, entry: boolean): number {
  return (reachedSource ? 100 : 0) + (entry ? 40 : 0) + Math.max(0, 20 - hops.length);
}

/**
 * 从 sink 位置反向搜索候选链。sinkLine 为 1-based。
 */
export function searchChainsFromSink(
  index: ProjectIndex,
  sinkFile: string,
  sinkLine: number,
  options: SearchOptions = {},
): ChainCandidate[] {
  const opts = { ...DEFAULTS, ...options };
  const fi = index.getFile(sinkFile);
  const s0 = fi ? enclosingSymbol(fi.symbols, sinkLine - 1) : undefined;

  // sink 不在任何函数内（顶层语句）：无法反向，返回单跳链
  if (!s0) {
    const name = sinkFile.split('/').pop() ?? sinkFile;
    return [{ hops: [{ name, file: sinkFile, line: sinkLine }], entryReason: '顶层代码', score: 0 }];
  }

  const sinkHop: ChainNode = { symbolId: s0.id, name: s0.name, file: s0.file, line: sinkLine };
  const results: ChainCandidate[] = [];
  const visited = new Set<string>([s0.id]);

  const finalize = (hops: ChainNode[], reachedSourceMarkId?: string, entryReason?: string) => {
    results.push({
      hops,
      reachedSourceMarkId,
      entryReason,
      score: scoreOf(hops, !!reachedSourceMarkId, !!entryReason),
    });
  };

  const dfs = (node: SymbolInfo, pathTail: ChainNode[], depth: number) => {
    if (results.length >= opts.maxChains) {
      return;
    }
    // 收集调用者，按（同文件优先、去重 fromSymbol）整理
    const callers = index.callersOf(node.name);
    const seen = new Set<string>();
    const entries: { callerSym?: SymbolInfo; callLine: number }[] = [];
    for (const c of callers) {
      const key = c.fromSymbol ?? `__top__:${c.file}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const callerSym = c.fromSymbol ? index.symbolById(c.fromSymbol) : undefined;
      entries.push({ callerSym, callLine: c.line + 1 });
    }
    entries.sort((a, b) => {
      const af = a.callerSym?.file === node.file ? 0 : 1;
      const bf = b.callerSym?.file === node.file ? 0 : 1;
      return af - bf;
    });

    // 没有调用者 → 当前节点是入口，收尾（用 node.name 判断是否框架入口）
    if (entries.length === 0) {
      finalize(pathTail, undefined, terminalReason(node, false));
      return;
    }
    // 到达深度上限 → 就地收尾
    if (depth >= opts.maxDepth) {
      finalize(pathTail, undefined, terminalReason(node, true));
      return;
    }

    let expanded = 0;
    for (const e of entries) {
      if (results.length >= opts.maxChains || expanded >= opts.maxCallersPerNode) {
        break;
      }
      // 顶层调用（不在函数内）：视为模块入口
      if (!e.callerSym) {
        finalize([{ name: `${node.file} 顶层`, file: node.file, line: e.callLine }, ...pathTail], undefined, '模块顶层调用');
        expanded++;
        continue;
      }
      if (visited.has(e.callerSym.id)) {
        continue; // 环：跳过，不计入 expanded
      }
      const hop: ChainNode = { symbolId: e.callerSym.id, name: e.callerSym.name, file: e.callerSym.file, line: e.callLine };
      const newPath = [hop, ...pathTail];
      const srcId = sourceMarkIn(e.callerSym, opts.sourceMarks);
      if (srcId) {
        finalize(newPath, srcId); // 命中 source，完整链
        expanded++;
        continue;
      }
      visited.add(e.callerSym.id);
      dfs(e.callerSym, newPath, depth + 1);
      visited.delete(e.callerSym.id);
      expanded++;
    }

    // 所有调用者都因成环被跳过 → 就地收尾，避免该分支丢失
    if (expanded === 0) {
      finalize(pathTail, undefined, '调用链在此成环');
    }
  };

  dfs(s0, [sinkHop], 0);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, opts.maxChains);
}
