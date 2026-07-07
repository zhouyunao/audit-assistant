import { ProjectIndex } from '../../indexer/indexer';
import { enclosingSymbol } from '../../indexer/callGraph';
import { Mark, SymbolInfo } from '../../types';

/**
 * Call-chain candidate search: reverse BFS/DFS on the approximate call graph from a sink back
 * to a call entry / source. Results are "over-approximate" candidate chains (same name != real
 * call); precision is compensated by subsequent per-hop LLM evidence-gathering.
 */

export interface ChainNode {
  /** Symbol id; undefined for module top-level / unresolvable nodes */
  symbolId?: string;
  name: string;
  file: string;
  /** 1-based: where this hop passes data to the next hop (closer to the sink); the sink hop is the sink itself */
  line: number;
}

export interface ChainCandidate {
  /** entry -> ... -> sink order */
  hops: ChainNode[];
  /** Id of the matched source mark (if any) */
  reachedSourceMarkId?: string;
  /** Why the terminal was judged an entry (heuristic function name / no callers) */
  entryReason?: string;
  score: number;
}

export interface SearchOptions {
  maxDepth?: number;
  maxCallersPerNode?: number;
  maxChains?: number;
  /** Confirmed/candidate source marks; a hit means a complete chain */
  sourceMarks?: Mark[];
}

const DEFAULTS = { maxDepth: 8, maxCallersPerNode: 8, maxChains: 20 };

// Entry function names: only fixed signatures that are almost always framework entry points and
// rarely called by application code itself, to avoid generic business method names like
// service/handle causing premature termination while walking upward.
const ENTRY_NAMES = new Set(['main', 'doGet', 'doPost', 'doPut', 'doDelete', 'doHead', 'ServeHTTP']);

function isEntryName(name: string): boolean {
  return ENTRY_NAMES.has(name);
}

function terminalReason(node: SymbolInfo, hadCallers: boolean): string {
  if (isEntryName(node.name)) {
    return `entry function ${node.name}`;
  }
  return hadCallers ? 'reached depth limit' : 'no callers (possible framework entry)';
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
 * Reverse-search candidate chains from a sink location. sinkLine is 1-based.
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

  // Sink is not inside any function (top-level statement): can't walk back, return a single-hop chain
  if (!s0) {
    const name = sinkFile.split('/').pop() ?? sinkFile;
    return [{ hops: [{ name, file: sinkFile, line: sinkLine }], entryReason: 'top-level code', score: 0 }];
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
    // Collect callers, deduped by fromSymbol and preferring same-file
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

    // No callers -> this node is an entry; finalize (use node.name to decide if it's a framework entry)
    if (entries.length === 0) {
      finalize(pathTail, undefined, terminalReason(node, false));
      return;
    }
    // Reached depth limit -> finalize in place
    if (depth >= opts.maxDepth) {
      finalize(pathTail, undefined, terminalReason(node, true));
      return;
    }

    let expanded = 0;
    for (const e of entries) {
      if (results.length >= opts.maxChains || expanded >= opts.maxCallersPerNode) {
        break;
      }
      // Top-level call (not inside a function): treat as a module entry
      if (!e.callerSym) {
        finalize([{ name: `${node.file} (top level)`, file: node.file, line: e.callLine }, ...pathTail], undefined, 'module top-level call');
        expanded++;
        continue;
      }
      if (visited.has(e.callerSym.id)) {
        continue; // cycle: skip, don't count toward expanded
      }
      const hop: ChainNode = { symbolId: e.callerSym.id, name: e.callerSym.name, file: e.callerSym.file, line: e.callLine };
      const newPath = [hop, ...pathTail];
      const srcId = sourceMarkIn(e.callerSym, opts.sourceMarks);
      if (srcId) {
        finalize(newPath, srcId); // source hit, complete chain
        expanded++;
        continue;
      }
      visited.add(e.callerSym.id);
      dfs(e.callerSym, newPath, depth + 1);
      visited.delete(e.callerSym.id);
      expanded++;
    }

    // All callers were skipped due to cycles -> finalize in place so this branch isn't lost
    if (expanded === 0) {
      finalize(pathTail, undefined, 'chain cycles here');
    }
  };

  dfs(s0, [sinkHop], 0);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, opts.maxChains);
}
