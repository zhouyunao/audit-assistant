// Data models shared across modules. Also the on-disk format for the .audit/ directory.

/** An indexed symbol (function/method/class) */
export interface SymbolInfo {
  /** Unique id: <relPath>#<name>@<startLine> */
  id: string;
  name: string;
  kind: 'function' | 'method' | 'class';
  /** Enclosing class/container name (if any) */
  container?: string;
  file: string;
  /** 0-based */
  startLine: number;
  endLine: number;
  /** Parameter list text (truncated), helps LLM/humans distinguish overloads */
  signature?: string;
}

/** An indexed call site */
export interface CallSite {
  /** Callee name (approximate, e.g. exec, query) */
  callee: string;
  /** 0-based line number */
  line: number;
  file: string;
  /** Id of the symbol making the call (undefined for top-level code) */
  fromSymbol?: string;
  /** Call-site text (truncated) */
  text?: string;
}

/** Per-file index result */
export interface FileIndex {
  file: string;
  contentHash: string;
  languageId: string;
  /** Total line count (LOC) */
  lines: number;
  symbols: SymbolInfo[];
  calls: CallSite[];
  /** Raw import targets (module paths/package names, unresolved) */
  imports: string[];
}

// ---------- Project structure (.audit/architecture.json) ----------

export interface ArchModule {
  name: string;
  fileCount: number;
  /** Total lines of code in the module */
  loc: number;
  description?: string;
  /** Representative files (for navigation) */
  sampleFiles: string[];
}

export interface ArchEdge {
  from: string;
  to: string;
  weight: number;
}

export interface Architecture {
  generatedAt: string;
  model?: string;
  overview?: string;
  modules: ArchModule[];
  edges: ArchEdge[];
  /** Annotated plain-text directory tree */
  tree: string;
}

// ---------- File analysis (.audit/files/<hash>.json) ----------

export interface FunctionSummary {
  name: string;
  /** 1-based, anchored line number */
  line: number;
  description: string;
}

export interface IssueFinding {
  title: string;
  /** e.g. CWE-89, may be empty */
  cwe?: string;
  severity: 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  /** 1-based, inclusive range */
  startLine: number;
  endLine: number;
  reason: string;
  advice?: string;
}

export interface AttentionSpan {
  startLine: number;
  endLine: number;
  note: string;
}

export interface FileAnalysis {
  /** Path relative to the workspace root (/ separated) */
  path: string;
  contentHash: string;
  analyzedAt: string;
  author: string;
  model: string;
  summary: string;
  functions: FunctionSummary[];
  issues: IssueFinding[];
  attention: AttentionSpan[];
}

// ---------- source/sink marks (.audit/marks.json) ----------

export interface Mark {
  id: string;
  kind: 'source' | 'sink';
  status: 'candidate' | 'confirmed' | 'excluded';
  /** Candidates come from rule scanning; `manual` are hand-marked (never removed by re-scan) */
  origin: 'scan' | 'manual';
  file: string;
  symbol?: string;
  /** 1-based */
  line: number;
  /** Matched call name or text (for quick human identification) */
  anchor?: string;
  category?: string;
  cwe?: string;
  ruleId?: string;
  note?: string;
  author: string;
  time: string;
}

// ---------- Call-chain findings (.audit/findings/<id>.json) ----------

export interface ChainHop {
  file: string;
  symbol: string;
  /** 1-based */
  line: number;
  evidence: string;
}

export interface Finding {
  id: string;
  title: string;
  sourceMarkId?: string;
  sinkMarkId?: string;
  chain: ChainHop[];
  verdict: 'reachable' | 'unreachable' | 'undetermined';
  analysis: string;
  author: string;
  time: string;
}
