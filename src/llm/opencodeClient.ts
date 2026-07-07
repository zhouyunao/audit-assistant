// opencode serve 会话式 API 客户端。opencode 不提供 OpenAI 兼容的 /chat/completions，
// 而是：POST /session 建会话 → POST /session/:id/message 发送消息（parts）并同步取回复。
// 参考：https://opencode.ai/docs/server/ （OpenAPI 见 http://<host>:<port>/doc）
//
// 说明：opencode 服务端自带 agent 与工具循环，不消费我们的 OpenAI tool 协议，
// 因此这里的 chat() 只做「文本进/文本出」，不返回 toolCalls。我们依赖 completeJson
// 与 chainVerify 的降级路径（每跳源码已预取进 prompt）即可正常工作。

import { ChatExtra, ChatMessage, ChatResult, LlmError, LlmProvider, completeJson } from './client';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpencodeOptions {
  /** 如 http://127.0.0.1:4096 */
  baseUrl: string;
  /** providerID/modelID，如 anthropic/claude-3-5-sonnet-20241022 */
  model: string;
  /** 可选：opencode 的 agent 名 */
  agent?: string;
  /** 对应服务端 OPENCODE_SERVER_PASSWORD */
  password?: string;
  timeoutMs?: number;
  /** 注入 fetch，便于测试；默认全局 fetch */
  fetchImpl?: FetchLike;
}

/** providerID/modelID → { providerID, modelID }。无斜杠时 providerID 为空。 */
export function parseModel(model: string): { providerID: string; modelID: string } {
  const i = model.indexOf('/');
  if (i < 0) {
    return { providerID: '', modelID: model };
  }
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/**
 * 把我们的 ChatMessage[] 压平成 opencode 单条消息：
 *   - 所有 system 内容合并进 system 字段
 *   - 其余按角色标注后合并为一个 text part（因每次请求都新建会话，需带全上下文）
 */
export function buildMessageBody(
  messages: ChatMessage[],
  model: { providerID: string; modelID: string },
  agent?: string,
): Record<string, unknown> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant') {
        return `【助手上一轮回复】\n${m.content}`;
      }
      if (m.role === 'tool') {
        return `【工具返回】\n${m.content}`;
      }
      return m.content;
    })
    .join('\n\n');

  const body: Record<string, unknown> = {
    model,
    parts: [{ type: 'text', text: convo }],
  };
  if (system) {
    body.system = system;
  }
  if (agent) {
    body.agent = agent;
  }
  return body;
}

/** 从 POST /session/:id/message 的响应里抽出助手文本（拼接所有 text part）。 */
export function extractText(data: any): string {
  const parts: any[] = Array.isArray(data?.parts) ? data.parts : Array.isArray(data?.info?.parts) ? data.info.parts : [];
  const text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (text) {
    return text;
  }
  // 兜底：部分版本可能把文本放在 info.content
  return typeof data?.info?.content === 'string' ? data.info.content : '';
}

export class OpencodeClient implements LlmProvider {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly parsed: { providerID: string; modelID: string };

  constructor(private readonly opts: OpencodeOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.parsed = parseModel(opts.model);
  }

  get model(): string {
    return this.opts.model;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.opts.password ? { authorization: `Bearer ${this.opts.password}` } : {}),
    };
  }

  private async post(path: string, body: unknown): Promise<any> {
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 180000);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const msg = e instanceof Error && e.name === 'AbortError' ? '请求超时' : String(e);
      throw new LlmError(`无法访问 opencode 端点 ${url}：${msg}。请确认已运行 opencode serve 且 baseUrl 正确。`);
    } finally {
      clearTimeout(timer);
    }
    const raw = await resp.text();
    if (!resp.ok) {
      throw new LlmError(`opencode 返回 ${resp.status}：${raw.slice(0, 500)}`);
    }
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new LlmError(`opencode 返回了非 JSON 内容：${raw.slice(0, 200)}`);
    }
  }

  async chat(messages: ChatMessage[], _extra?: ChatExtra): Promise<ChatResult> {
    if (!this.parsed.modelID) {
      throw new LlmError('opencode 需要在 auditAssistant.llm.model 填写 providerID/modelID，如 anthropic/claude-3-5-sonnet-20241022');
    }
    const session = await this.post('/session', { title: 'audit-assistant' });
    const sessionId = session?.id;
    if (!sessionId) {
      throw new LlmError(`opencode 创建会话失败，未返回 session id：${JSON.stringify(session).slice(0, 200)}`);
    }
    const body = buildMessageBody(messages, this.parsed, this.opts.agent);
    const data = await this.post(`/session/${encodeURIComponent(sessionId)}/message`, body);
    return { content: extractText(data) };
  }

  completeJson<T>(system: string, user: string): Promise<T> {
    return completeJson<T>(this, system, user);
  }
}
