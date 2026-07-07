import { LlmProvider, ToolDef, tryParseJson } from '../../llm/client';
import { runAgent, AgentTool } from '../../llm/agentLoop';
import { ProjectIndex } from '../../indexer/indexer';
import { ChainCandidate, ChainNode } from './pathSearch';
import { ChainHop, Finding, Mark, SymbolInfo } from '../../types';

export type FileReader = (relFile: string) => Promise<string | undefined>;

export interface VerifyOptions {
  author: string;
  outputLanguage: string;
  maxSteps?: number;
}

interface RawVerdict {
  verdict?: string;
  analysis?: string;
  hops?: Array<{ file?: string; symbol?: string; line?: number; evidence?: string }>;
}

const MAX_FUNC_CHARS = 6000;

/** Human-readable name of the requested output language. */
function languageName(outputLanguage: string): string {
  return outputLanguage === 'zh' ? 'Simplified Chinese' : outputLanguage === 'ja' ? 'Japanese' : 'English';
}

function sliceFunctionSource(lines: string[], sym: SymbolInfo | undefined, fallbackLine: number): string {
  const start = sym ? sym.startLine : Math.max(0, fallbackLine - 4);
  const end = sym ? sym.endLine : Math.min(lines.length - 1, fallbackLine + 4);
  const body = lines
    .slice(start, end + 1)
    .map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`)
    .join('\n');
  return body.length > MAX_FUNC_CHARS ? body.slice(0, MAX_FUNC_CHARS) + '\n… (truncated)' : body;
}

function systemPrompt(outputLanguage: string): string {
  const lang = languageName(outputLanguage);
  return [
    'You are a senior code-security auditor verifying a candidate call chain along which taint flows from a source/entry to a sink.',
    'The candidate chain comes from approximate static analysis (name matching) and may be imprecise: a call edge could be a same-name mismatch, or the data could already be validated/sanitized along the way.',
    'Check hop by hop: does data really pass from the previous hop into the next, is there any filtering/escaping/parameterization/allow-listing, and is it still attacker-controlled when it reaches the sink?',
    'When you need more context, call the tools read_function / get_callers / search_text (e.g. when the static chain is broken, or you suspect reflection or framework routing).',
    'When done, output only a single JSON object, with no other text:',
    '{',
    '  "verdict": "reachable | unreachable | undetermined",',
    '  "analysis": "your reasoning, noting the key sanitization or controllable points",',
    '  "hops": [{"file": "path", "symbol": "function name", "line": number, "evidence": "the key code fact for this hop"}]',
    '}',
    'verdict meaning: reachable = taint truly reaches the sink without effective sanitization; unreachable = not reachable or already sanitized; undetermined = insufficient evidence.',
    `Write all prose in ${lang}.`,
  ].join('\n');
}

function buildTools(index: ProjectIndex, readFile: FileReader): AgentTool[] {
  const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });

  return [
    {
      def: def(
        'read_function',
        'Read the source code (with line numbers) of a function/method in a given file',
        { file: { type: 'string' }, name: { type: 'string', description: 'function or method name' } },
        ['file', 'name'],
      ),
      run: async (args) => {
        const file = String(args.file ?? '');
        const name = String(args.name ?? '');
        const fi = index.getFile(file);
        const sym = fi?.symbols.find((s) => s.name === name) ?? index.symbolsByName(name, file)[0];
        if (!sym) {
          return `Symbol ${name} not found`;
        }
        const content = await readFile(sym.file);
        if (content === undefined) {
          return `Cannot read file ${sym.file}`;
        }
        return sliceFunctionSource(content.split(/\r?\n/), sym, sym.startLine);
      },
    },
    {
      def: def('get_callers', 'Find which functions call a function with the given name', { name: { type: 'string' } }, ['name']),
      run: (args) => {
        const name = String(args.name ?? '');
        const callers = index.callersOf(name).slice(0, 30);
        if (!callers.length) {
          return `No callers found for ${name} (may be invoked by a framework/reflection)`;
        }
        return JSON.stringify(
          callers.map((c) => ({ file: c.file, line: c.line + 1, caller: c.fromSymbol ? index.symbolById(c.fromSymbol)?.name : '(top level)' })),
        );
      },
    },
    {
      def: def(
        'search_text',
        'Full-text search the project for a string (for reflection/route-registration and other places the static graph is broken); returns matching locations',
        { query: { type: 'string' }, maxResults: { type: 'number' } },
        ['query'],
      ),
      run: async (args) => {
        const query = String(args.query ?? '');
        const max = Math.min(Number(args.maxResults ?? 20) || 20, 50);
        if (!query) {
          return 'Empty query';
        }
        const hits: string[] = [];
        for (const fi of index.allFiles()) {
          const content = await readFile(fi.file);
          if (content === undefined) {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              hits.push(`${fi.file}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
              if (hits.length >= max) {
                return hits.join('\n');
              }
            }
          }
        }
        return hits.length ? hits.join('\n') : `"${query}" not found`;
      },
    },
  ];
}

function chainText(hops: ChainNode[]): string {
  return hops.map((h, i) => `  ${i + 1}. ${h.name}  (${h.file}:${h.line})`).join('\n');
}

function normalizeVerdict(v: string | undefined): Finding['verdict'] {
  return v === 'reachable' || v === 'unreachable' || v === 'undetermined' ? v : 'undetermined';
}

/**
 * Verify a candidate chain hop by hop with the LLM and produce a Finding. Each hop's function
 * source is pre-fed into the prompt, so a conclusion is produced even when the endpoint doesn't
 * support tool-calling; when tools are supported, the model can gather extra context itself.
 */
export async function verifyChain(
  index: ProjectIndex,
  client: LlmProvider,
  readFile: FileReader,
  candidate: ChainCandidate,
  sink: Mark,
  source: Mark | undefined,
  opts: VerifyOptions,
): Promise<Finding> {
  // Pre-fetch each hop's function source
  const hopSources: string[] = [];
  for (const hop of candidate.hops) {
    const sym = hop.symbolId ? index.symbolById(hop.symbolId) : undefined;
    const content = await readFile(hop.file);
    const src = content ? sliceFunctionSource(content.split(/\r?\n/), sym, hop.line) : '(source unavailable)';
    hopSources.push(`### ${hop.name}  (${hop.file}:${hop.line})\n${src}`);
  }

  const entry = candidate.reachedSourceMarkId
    ? `Source mark: ${source ? `${source.file}:${source.line}` : candidate.reachedSourceMarkId}`
    : `Entry: ${candidate.entryReason ?? 'unknown'}`;

  const user = [
    `Sink: ${sink.file}:${sink.line}${sink.category ? ` (${sink.category}${sink.cwe ? ' ' + sink.cwe : ''})` : ''}`,
    entry,
    '',
    'Candidate call chain (entry -> sink):',
    chainText(candidate.hops),
    '',
    'Source of each hop:',
    ...hopSources,
    '',
    'Verify hop by hop whether the taint is truly reachable and output a JSON conclusion.',
  ].join('\n');

  const seed = [
    { role: 'system' as const, content: systemPrompt(opts.outputLanguage) },
    { role: 'user' as const, content: user },
  ];

  const { content } = await runAgent(client, seed, buildTools(index, readFile), opts.maxSteps ?? 12);
  const raw = tryParseJson<RawVerdict>(content) ?? {};

  const chain: ChainHop[] =
    raw.hops && raw.hops.length
      ? raw.hops.map((h) => ({
          file: h.file ?? '',
          symbol: h.symbol ?? '',
          line: typeof h.line === 'number' ? h.line : 0,
          evidence: h.evidence ?? '',
        }))
      : candidate.hops.map((h) => ({ file: h.file, symbol: h.name, line: h.line, evidence: '' }));

  const verdict = normalizeVerdict(raw.verdict);

  return {
    id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: `${sink.category ?? 'sink'} @ ${sink.file.split('/').pop()}:${sink.line} · ${verdict}`,
    sourceMarkId: source?.id ?? candidate.reachedSourceMarkId,
    sinkMarkId: sink.id,
    chain,
    verdict,
    analysis: raw.analysis ?? content.slice(0, 500),
    author: opts.author,
    time: new Date().toISOString(),
  };
}
