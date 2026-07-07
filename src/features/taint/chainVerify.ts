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

function sliceFunctionSource(lines: string[], sym: SymbolInfo | undefined, fallbackLine: number): string {
  const start = sym ? sym.startLine : Math.max(0, fallbackLine - 4);
  const end = sym ? sym.endLine : Math.min(lines.length - 1, fallbackLine + 4);
  const body = lines
    .slice(start, end + 1)
    .map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`)
    .join('\n');
  return body.length > MAX_FUNC_CHARS ? body.slice(0, MAX_FUNC_CHARS) + '\n… (截断)' : body;
}

function systemPrompt(outputLanguage: string): string {
  const lang = outputLanguage === 'en' ? 'English' : '简体中文';
  return [
    '你是资深代码安全审计专家，正在验证一条“污点从 source/入口 流向 sink”的候选调用链。',
    '候选链由静态近似分析（名称匹配）得出，可能不精确：调用关系可能是同名误配，或中途已有校验/净化。',
    '请沿链逐跳核对：数据是否真的从上一跳传入下一跳、有无过滤/转义/参数化/白名单等净化，最终到达 sink 时是否仍然可控。',
    '需要更多上下文时可调用工具 read_function / get_callers / search_text（例如静态链断开、疑似反射或框架路由时）。',
    '完成后只输出一个 JSON 对象，不要输出其他文字：',
    '{',
    '  "verdict": "reachable | unreachable | undetermined",',
    '  "analysis": "结论依据，说明关键的净化点或可控点",',
    '  "hops": [{"file": "路径", "symbol": "函数名", "line": 行号, "evidence": "该跳的关键代码事实"}]',
    '}',
    'verdict 含义：reachable=污点确实可达且未被有效净化；unreachable=不可达或已被净化；undetermined=证据不足。',
    `所有说明文字使用${lang}。`,
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
        '读取指定文件中某个函数/方法的源码（带行号）',
        { file: { type: 'string' }, name: { type: 'string', description: '函数或方法名' } },
        ['file', 'name'],
      ),
      run: async (args) => {
        const file = String(args.file ?? '');
        const name = String(args.name ?? '');
        const fi = index.getFile(file);
        const sym = fi?.symbols.find((s) => s.name === name) ?? index.symbolsByName(name, file)[0];
        if (!sym) {
          return `未找到符号 ${name}`;
        }
        const content = await readFile(sym.file);
        if (content === undefined) {
          return `无法读取文件 ${sym.file}`;
        }
        return sliceFunctionSource(content.split(/\r?\n/), sym, sym.startLine);
      },
    },
    {
      def: def('get_callers', '查询哪些函数调用了指定名字的函数', { name: { type: 'string' } }, ['name']),
      run: (args) => {
        const name = String(args.name ?? '');
        const callers = index.callersOf(name).slice(0, 30);
        if (!callers.length) {
          return `没有找到 ${name} 的调用者（可能由框架/反射调用）`;
        }
        return JSON.stringify(
          callers.map((c) => ({ file: c.file, line: c.line + 1, caller: c.fromSymbol ? index.symbolById(c.fromSymbol)?.name : '(顶层)' })),
        );
      },
    },
    {
      def: def(
        'search_text',
        '在项目中按字符串全文检索（用于反射/路由注册等静态图断开处），返回命中位置',
        { query: { type: 'string' }, maxResults: { type: 'number' } },
        ['query'],
      ),
      run: async (args) => {
        const query = String(args.query ?? '');
        const max = Math.min(Number(args.maxResults ?? 20) || 20, 50);
        if (!query) {
          return '查询为空';
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
        return hits.length ? hits.join('\n') : `未找到 "${query}"`;
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
 * 用 LLM 逐跳验证一条候选链，产出 Finding。会把每一跳的函数源码预先喂进 prompt，
 * 因此即使端点不支持 tool-calling 也能给出结论；支持工具时模型可自行补充上下文。
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
  // 预取每一跳的函数源码
  const hopSources: string[] = [];
  for (const hop of candidate.hops) {
    const sym = hop.symbolId ? index.symbolById(hop.symbolId) : undefined;
    const content = await readFile(hop.file);
    const src = content ? sliceFunctionSource(content.split(/\r?\n/), sym, hop.line) : '（无法读取源码）';
    hopSources.push(`### ${hop.name}  (${hop.file}:${hop.line})\n${src}`);
  }

  const entry = candidate.reachedSourceMarkId
    ? `Source 标记：${source ? `${source.file}:${source.line}` : candidate.reachedSourceMarkId}`
    : `入口：${candidate.entryReason ?? '未知'}`;

  const user = [
    `Sink：${sink.file}:${sink.line}${sink.category ? `（${sink.category}${sink.cwe ? ' ' + sink.cwe : ''}）` : ''}`,
    entry,
    '',
    '候选调用链（入口 → sink）：',
    chainText(candidate.hops),
    '',
    '各跳源码：',
    ...hopSources,
    '',
    '请逐跳核对污点是否真实可达并输出 JSON 结论。',
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
  const verdictCn = verdict === 'reachable' ? '可达' : verdict === 'unreachable' ? '不可达' : '待定';

  return {
    id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: `${sink.category ?? 'sink'} @ ${sink.file.split('/').pop()}:${sink.line} · ${verdictCn}`,
    sourceMarkId: source?.id ?? candidate.reachedSourceMarkId,
    sinkMarkId: sink.id,
    chain,
    verdict,
    analysis: raw.analysis ?? content.slice(0, 500),
    author: opts.author,
    time: new Date().toISOString(),
  };
}
