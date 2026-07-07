import { LlmProvider } from '../llm/client';
import { ProjectIndex, contentHash } from '../indexer/indexer';
import { AuditStore } from '../store/auditStore';
import { AttentionSpan, FileAnalysis, FunctionSummary, IssueFinding, SymbolInfo } from '../types';

/** Max code per request (characters). Larger files are chunked at symbol boundaries. */
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
  const lang = outputLanguage === 'zh' ? 'Simplified Chinese' : outputLanguage === 'ja' ? 'Japanese' : 'English';
  return [
    'You are a senior code-security auditor assisting a human audit. Your output must be a single JSON object, with no other text.',
    'JSON shape:',
    '{',
    '  "summary": "overall description of this file/snippet, 2-4 sentences",',
    '  "functions": [{"name": "function name", "line": start line, "description": "one-line description of what it does"}],',
    '  "issues": [{"title": "issue title", "cwe": "CWE-89 (leave empty if none fits)", "severity": "high|medium|low",',
    '              "confidence": "high|medium|low", "startLine": 1, "endLine": 3,',
    '              "reason": "the basis (cite code facts)", "advice": "fix/review advice"}],',
    '  "attention": [{"startLine": 1, "endLine": 5, "note": "why an auditor should pay attention here"}]',
    '}',
    'Requirements:',
    '- Use the line numbers annotated in the code; they must be accurate.',
    '- functions must cover every function/method in the code; description states what it actually does (derived from reading the code, do not guess from the name).',
    '- issues should only report common vulnerabilities with a code basis: injection (SQL/command/template), path traversal, SSRF, unsafe deserialization, XXE, XSS,',
    '  insecure crypto/randomness, hardcoded credentials, broken/missing authorization, dangerous functions (eval, etc.). Use low confidence when unsure; do not fabricate.',
    '- attention should list code handling external input, authentication/authorization, file/network/process operations, or sensitive data (even without a clear vulnerability).',
    `- Write all prose in ${lang}.`,
  ].join('\n');
}

function numberLines(lines: string[], startLine: number): string {
  // startLine is the 1-based line number of the first line; always show absolute line numbers so the LLM can cite them directly
  return lines.map((l, i) => `${String(startLine + i).padStart(5)}| ${l}`).join('\n');
}

function symbolListText(symbols: SymbolInfo[]): string {
  if (!symbols.length) {
    return '(no static symbol information)';
  }
  return symbols
    .map((s) => `- ${s.kind} ${s.container ? s.container + '.' : ''}${s.name}${s.signature ?? ''}  lines ${s.startLine + 1}-${s.endLine + 1}`)
    .join('\n');
}

/** Split a file into line ranges at symbol boundaries (1-based, inclusive) */
export function splitChunks(lines: string[], symbols: SymbolInfo[], chunkChars = CHUNK_CHARS): Array<{ start: number; end: number }> {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= chunkChars) {
    return [{ start: 1, end: lines.length }];
  }
  // Symbol start lines are preferred break points
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
      // Break at the nearest symbol boundary when possible
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

/** Normalize LLM output + anchor line numbers to the symbol table */
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
      // When a symbol table exists, trust the statically parsed line number to eliminate LLM line hallucinations
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
  client: LlmProvider,
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
      opts.onProgress?.(`Analyzing chunk ${c + 1}/${chunks.length} (lines ${start}-${end})…`);
    }
    const chunkSymbols = symbols.filter((s) => s.startLine + 1 >= start && s.startLine + 1 <= end);
    const user = [
      `File: ${relPath}`,
      `Language: ${fileIndex?.languageId ?? '(not detected, infer from content)'}`,
      chunks.length > 1 ? `Note: this is chunk ${c + 1}/${chunks.length} of the file (lines ${start}-${end}); line numbers are absolute within the whole file.` : '',
      '',
      'Statically parsed symbols (line numbers are reliable):',
      symbolListText(chunkSymbols),
      '',
      'Code:',
      numberLines(lines.slice(start - 1, end), start),
    ]
      .filter(Boolean)
      .join('\n');
    partials.push(await client.completeJson<RawAnalysis>(system, user));
  }

  // Merge chunk results
  const merged: RawAnalysis = {
    functions: partials.flatMap((p) => p.functions ?? []),
    issues: partials.flatMap((p) => p.issues ?? []),
    attention: partials.flatMap((p) => p.attention ?? []),
    summary: partials.length === 1 ? partials[0].summary : undefined,
  };

  let summary = merged.summary ?? '';
  if (!summary) {
    opts.onProgress?.('Summarizing the file…');
    const sectionSummaries = partials.map((p, i) => `Chunk ${i + 1}: ${p.summary ?? '(none)'}`).join('\n');
    const res = await client.completeJson<{ summary?: string }>(
      systemPrompt(opts.outputLanguage),
      `Below are the functional summaries of each code chunk of file ${relPath}. Combine them into a 2-4 sentence overall description and output JSON: {"summary": "..."}\n\n${sectionSummaries}`,
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
