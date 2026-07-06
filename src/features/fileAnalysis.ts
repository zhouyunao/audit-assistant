import { LlmClient } from '../llm/client';
import { ProjectIndex, contentHash } from '../indexer/indexer';
import { AuditStore } from '../store/auditStore';
import { AttentionSpan, FileAnalysis, FunctionSummary, IssueFinding, SymbolInfo } from '../types';

/** 单次请求携带的代码上限（字符）。超过则按符号边界分块。 */
const CHUNK_CHARS = 20000;

interface RawFunction {
  name?: string;
  line?: number;
  description?: string;
}
interface RawIssue {
  title?: string;
  cwe?: string;
  severity?: string;
  confidence?: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
  advice?: string;
}
interface RawAttention {
  startLine?: number;
  endLine?: number;
  note?: string;
}
interface RawAnalysis {
  summary?: string;
  functions?: RawFunction[];
  issues?: RawIssue[];
  attention?: RawAttention[];
}

export interface AnalyzeOptions {
  author: string;
  outputLanguage: string;
  onProgress?: (message: string) => void;
}

function systemPrompt(outputLanguage: string): string {
  const lang = outputLanguage === 'en' ? 'English' : '简体中文';
  return [
    '你是资深的代码安全审计专家，正在辅助人工审计。你的输出必须是一个 JSON 对象，不要输出任何其他文字。',
    'JSON 结构：',
    '{',
    '  "summary": "该文件/代码段的整体功能说明，2~4 句",',
    '  "functions": [{"name": "函数名", "line": 起始行号, "description": "一句话功能说明"}],',
    '  "issues": [{"title": "问题标题", "cwe": "CWE-89（没有合适编号可留空）", "severity": "high|medium|low",',
    '              "confidence": "high|medium|low", "startLine": 1, "endLine": 3,',
    '              "reason": "判断依据（引用代码事实）", "advice": "修复/复核建议"}],',
    '  "attention": [{"startLine": 1, "endLine": 5, "note": "人工审计时需要注意的原因"}]',
    '}',
    '要求：',
    '- 行号使用代码里标注的行号，必须准确。',
    '- functions 覆盖代码中出现的每个函数/方法，description 说明它实际做什么（读代码得出，不要猜测命名含义）。',
    '- issues 只报告有代码依据的常见漏洞：注入（SQL/命令/模板）、路径穿越、SSRF、不安全反序列化、XXE、XSS、',
    '  不安全的加密/随机数、硬编码凭据、越权/缺失鉴权、危险函数（eval 等）。不确定就用低 confidence，不要编造。',
    '- attention 列出处理外部输入、认证鉴权、文件/网络/进程操作、敏感数据的代码段（即使没有明确漏洞）。',
    `- 所有说明文字使用${lang}。`,
  ].join('\n');
}

function numberLines(lines: string[], startLine: number): string {
  // startLine 为 1-based 的首行行号；始终展示绝对行号，让 LLM 直接引用
  return lines.map((l, i) => `${String(startLine + i).padStart(5)}| ${l}`).join('\n');
}

function symbolListText(symbols: SymbolInfo[]): string {
  if (!symbols.length) {
    return '（无静态符号信息）';
  }
  return symbols
    .map((s) => `- ${s.kind} ${s.container ? s.container + '.' : ''}${s.name}${s.signature ?? ''}  第${s.startLine + 1}~${s.endLine + 1}行`)
    .join('\n');
}

/** 按符号边界把文件切成若干行区间（1-based 闭区间） */
export function splitChunks(lines: string[], symbols: SymbolInfo[], chunkChars = CHUNK_CHARS): Array<{ start: number; end: number }> {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= chunkChars) {
    return [{ start: 1, end: lines.length }];
  }
  // 符号起始行是优先断点
  const breakpoints = new Set(symbols.map((s) => s.startLine)); // 0-based
  const chunks: Array<{ start: number; end: number }> = [];
  let start = 0;
  let size = 0;
  let lastBreak = -1;
  for (let i = 0; i < lines.length; i++) {
    if (breakpoints.has(i)) {
      lastBreak = i;
    }
    size += lines[i].length + 1;
    if (size > chunkChars && i > start) {
      // 尽量在最近的符号边界断开
      const cut = lastBreak > start ? lastBreak : i;
      chunks.push({ start: start + 1, end: cut });
      start = cut;
      size = lines.slice(start, i + 1).reduce((n, l) => n + l.length + 1, 0);
      lastBreak = -1;
    }
  }
  if (start < lines.length) {
    chunks.push({ start: start + 1, end: lines.length });
  }
  return chunks;
}

function clampLine(n: unknown, max: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 1;
  return Math.min(Math.max(1, v), max);
}

function pickEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback;
}

/** 把 LLM 输出规范化 + 行号锚定到符号表 */
function normalize(raw: RawAnalysis, lineCount: number, symbols: SymbolInfo[]): Pick<FileAnalysis, 'functions' | 'issues' | 'attention'> {
  const symbolByName = new Map<string, SymbolInfo>();
  for (const s of symbols) {
    if (!symbolByName.has(s.name)) {
      symbolByName.set(s.name, s);
    }
  }
  const functions: FunctionSummary[] = [];
  for (const f of raw.functions ?? []) {
    if (!f?.name || !f.description) {
      continue;
    }
    const sym = symbolByName.get(f.name);
    functions.push({
      name: f.name,
      // 有符号表时以静态解析的行号为准，消除 LLM 幻觉行号
      line: sym ? sym.startLine + 1 : clampLine(f.line, lineCount),
      description: f.description,
    });
  }
  const issues: IssueFinding[] = [];
  for (const i of raw.issues ?? []) {
    if (!i?.title || !i.reason) {
      continue;
    }
    const startLine = clampLine(i.startLine, lineCount);
    issues.push({
      title: i.title,
      cwe: i.cwe || undefined,
      severity: pickEnum(i.severity, ['high', 'medium', 'low'], 'medium'),
      confidence: pickEnum(i.confidence, ['high', 'medium', 'low'], 'medium'),
      startLine,
      endLine: Math.max(startLine, clampLine(i.endLine, lineCount)),
      reason: i.reason,
      advice: i.advice || undefined,
    });
  }
  const attention: AttentionSpan[] = [];
  for (const a of raw.attention ?? []) {
    if (!a?.note) {
      continue;
    }
    const startLine = clampLine(a.startLine, lineCount);
    attention.push({ startLine, endLine: Math.max(startLine, clampLine(a.endLine, lineCount)), note: a.note });
  }
  return { functions, issues, attention };
}

export async function analyzeFileContent(
  relPath: string,
  content: string,
  client: LlmClient,
  index: ProjectIndex,
  store: AuditStore,
  opts: AnalyzeOptions,
): Promise<FileAnalysis> {
  const fileIndex = await index.indexFile(relPath, content);
  const symbols = fileIndex?.symbols ?? [];
  const lines = content.split(/\r?\n/);
  const system = systemPrompt(opts.outputLanguage);
  const chunks = splitChunks(lines, symbols);

  const partials: RawAnalysis[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const { start, end } = chunks[c];
    if (chunks.length > 1) {
      opts.onProgress?.(`分析第 ${c + 1}/${chunks.length} 段（第 ${start}~${end} 行）…`);
    }
    const chunkSymbols = symbols.filter((s) => s.startLine + 1 >= start && s.startLine + 1 <= end);
    const user = [
      `文件：${relPath}`,
      `语言：${fileIndex?.languageId ?? '（未识别，按内容判断）'}`,
      chunks.length > 1 ? `注意：这是文件的第 ${c + 1}/${chunks.length} 段（第 ${start}~${end} 行），行号为全文件绝对行号。` : '',
      '',
      '静态解析出的符号（行号可信）：',
      symbolListText(chunkSymbols),
      '',
      '代码：',
      numberLines(lines.slice(start - 1, end), start),
    ]
      .filter(Boolean)
      .join('\n');
    partials.push(await client.completeJson<RawAnalysis>(system, user));
  }

  // 合并分块结果
  const merged: RawAnalysis = {
    functions: partials.flatMap((p) => p.functions ?? []),
    issues: partials.flatMap((p) => p.issues ?? []),
    attention: partials.flatMap((p) => p.attention ?? []),
    summary: partials.length === 1 ? partials[0].summary : undefined,
  };

  let summary = merged.summary ?? '';
  if (!summary) {
    opts.onProgress?.('汇总文件总结…');
    const sectionSummaries = partials.map((p, i) => `第${i + 1}段：${p.summary ?? '（无）'}`).join('\n');
    const res = await client.completeJson<{ summary?: string }>(
      systemPrompt(opts.outputLanguage),
      `以下是文件 ${relPath} 各段代码的功能概述，请综合成 2~4 句的整体功能说明，输出 JSON：{"summary": "..."}\n\n${sectionSummaries}`,
    );
    summary = res.summary ?? sectionSummaries;
  }

  const normalized = normalize(merged, lines.length, symbols);
  const analysis: FileAnalysis = {
    path: relPath.replace(/\\/g, '/'),
    contentHash: contentHash(content),
    analyzedAt: new Date().toISOString(),
    author: opts.author,
    model: client.model,
    summary,
    ...normalized,
  };
  store.saveFileAnalysis(analysis);
  return analysis;
}
