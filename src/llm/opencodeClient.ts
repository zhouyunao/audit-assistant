// opencode serve session-based API client. opencode does not expose an OpenAI-compatible
// /chat/completions; instead: POST /session to create a session -> POST /session/:id/message
// to send a message (parts) and synchronously read the reply.
// Reference: https://opencode.ai/docs/server/ (OpenAPI at http://<host>:<port>/doc)
//
// Note: the opencode server runs its own agent and tool loop and does not consume our OpenAI
// tool protocol, so chat() here is "text in / text out" and returns no toolCalls. We rely on
// completeJson and chainVerify's degraded path (each hop's source is pre-fetched into the prompt).

import { ChatExtra, ChatMessage, ChatResult, LlmError, LlmProvider, completeJson } from './client';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpencodeOptions {
  /** e.g. http://127.0.0.1:4096 */
  baseUrl: string;
  /** providerID/modelID, e.g. anthropic/claude-3-5-sonnet-20241022 */
  model: string;
  /** Optional: opencode agent name */
  agent?: string;
  /** Corresponds to the server's OPENCODE_SERVER_PASSWORD */
  password?: string;
  timeoutMs?: number;
  /** Injectable fetch for testing; defaults to the global fetch */
  fetchImpl?: FetchLike;
}

/** providerID/modelID -> { providerID, modelID }. providerID is empty when there is no slash. */
export function parseModel(model: string): { providerID: string; modelID: string } {
  const i = model.indexOf('/');
  if (i < 0) {
    return { providerID: '', modelID: model };
  }
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/**
 * Flatten our ChatMessage[] into a single opencode message:
 *   - all system contents are merged into the `system` field
 *   - the rest are role-labeled and joined into one text part (each request creates a fresh
 *     session, so the full context must be included)
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
        return `[assistant previous reply]\n${m.content}`;
      }
      if (m.role === 'tool') {
        return `[tool result]\n${m.content}`;
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

/** Extract the assistant text from the POST /session/:id/message response (concatenate all text parts). */
export function extractText(data: any): string {
  const parts: any[] = Array.isArray(data?.parts) ? data.parts : Array.isArray(data?.info?.parts) ? data.info.parts : [];
  const text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (text) {
    return text;
  }
  // Fallback: some versions may put the text in info.content
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
      const msg = e instanceof Error && e.name === 'AbortError' ? 'request timed out' : String(e);
      throw new LlmError(`Cannot reach opencode endpoint ${url}: ${msg}. Make sure "opencode serve" is running and baseUrl is correct.`);
    } finally {
      clearTimeout(timer);
    }
    const raw = await resp.text();
    if (!resp.ok) {
      throw new LlmError(`opencode returned ${resp.status}: ${raw.slice(0, 500)}`);
    }
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new LlmError(`opencode returned non-JSON content: ${raw.slice(0, 200)}`);
    }
  }

  async chat(messages: ChatMessage[], _extra?: ChatExtra): Promise<ChatResult> {
    if (!this.parsed.modelID) {
      throw new LlmError('opencode requires auditAssistant.llm.model as providerID/modelID, e.g. anthropic/claude-3-5-sonnet-20241022');
    }
    const session = await this.post('/session', { title: 'audit-assistant' });
    const sessionId = session?.id;
    if (!sessionId) {
      throw new LlmError(`opencode failed to create a session (no session id returned): ${JSON.stringify(session).slice(0, 200)}`);
    }
    const body = buildMessageBody(messages, this.parsed, this.opts.agent);
    const data = await this.post(`/session/${encodeURIComponent(sessionId)}/message`, body);
    return { content: extractText(data) };
  }

  completeJson<T>(system: string, user: string): Promise<T> {
    return completeJson<T>(this, system, user);
  }
}
