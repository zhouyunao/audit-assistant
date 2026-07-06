// 跨模块共享的数据模型。.audit/ 目录中的落盘格式也以此为准。

/** 索引出的符号（函数/方法/类） */
export interface SymbolInfo {
  /** 唯一 id：<relPath>#<name>@<startLine> */
  id: string;
  name: string;
  kind: 'function' | 'method' | 'class';
  /** 所属类/容器名（如有） */
  container?: string;
  file: string;
  /** 0-based */
  startLine: number;
  endLine: number;
  /** 参数列表原文（截断），帮助 LLM/人识别重载 */
  signature?: string;
}

/** 索引出的调用点 */
export interface CallSite {
  /** 被调名（近似，如 exec、query） */
  callee: string;
  /** 0-based 行号 */
  line: number;
  file: string;
  /** 发起调用的符号 id（顶层代码则为 undefined） */
  fromSymbol?: string;
  /** 调用点原文（截断） */
  text?: string;
}

/** 单文件索引结果 */
export interface FileIndex {
  file: string;
  contentHash: string;
  languageId: string;
  /** 文件总行数（LOC） */
  lines: number;
  symbols: SymbolInfo[];
  calls: CallSite[];
  /** 原始 import 目标（模块路径/包名，未解析） */
  imports: string[];
}

// ---------- 项目结构图（.audit/architecture.json） ----------

export interface ArchModule {
  name: string;
  fileCount: number;
  /** 模块内代码总行数 */
  loc: number;
  description?: string;
  /** 代表文件（跳转用） */
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
  /** 带注释的纯文本目录树 */
  tree: string;
}

// ---------- 文件分析（.audit/files/<hash>.json） ----------

export interface FunctionSummary {
  name: string;
  /** 1-based，锚定后的行号 */
  line: number;
  description: string;
}

export interface IssueFinding {
  title: string;
  /** 如 CWE-89，可为空 */
  cwe?: string;
  severity: 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  /** 1-based 闭区间 */
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
  /** 相对工作区根的路径（/ 分隔） */
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

// ---------- source/sink 标记（.audit/marks.json，M5 使用，先定格式） ----------

export interface Mark {
  id: string;
  kind: 'source' | 'sink';
  status: 'candidate' | 'confirmed' | 'excluded';
  file: string;
  symbol?: string;
  /** 1-based */
  line: number;
  category?: string;
  cwe?: string;
  note?: string;
  author: string;
  time: string;
}

// ---------- 调用链结论（.audit/findings/<id>.json，M6 使用，先定格式） ----------

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
