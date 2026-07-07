// OpenAI-compatible /chat/completions client. No SDK dependency — uses fetch directly,
// so it works with self-hosted endpoints such as vLLM / Ollama / OneAPI.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
}

export interface ChatExtra {
  tools?: ToolDef[];
  jsonMode?: boolean;
}

/**
 * Unified LLM backend interface. Both the OpenAI-compatible endpoint (LlmClient) and
 * opencode serve (OpencodeClient) implement it; the feature layer depends only on this
 * interface and is agnostic to the concrete backend.
 */
export interface LlmProvider {
  readonly model: string;
  chat(messages: ChatMessage[], extra?: ChatExtra): Promise<ChatResult>;
  completeJson<T>(system: string, user: string): Promise<T>;
}

export interface LlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export class LlmError extends Error {}

export class LlmClient implements LlmProvider {
  constructor(private readonly opts: LlmClientOptions) {}

  get model(): string {
    return this.opts.model;
  }

  async chat(messages: ChatMessage[], extra?: ChatExtra): Promise<ChatResult> {
    if (!this.opts.model) {
      throw new LlmError('No model configured. Set auditAssistant.llm.model in settings.');
    }
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: this.opts.temperature ?? 0.2,
      max_tokens: this.opts.maxTokens ?? 4096,
    };
    if (extra?.tools?.length) {
      body.tools = extra.tools;
    }
    if (extra?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 180000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const msg = e instanceof Error && e.name === 'AbortError' ? 'request timed out' : String(e);
      throw new LlmError(`Cannot reach LLM endpoint ${url}: ${msg}. Check auditAssistant.llm.baseUrl and your network.`);
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    if (!resp.ok) {
      // Some endpoints don't support response_format; drop it and retry once
      if (extra?.jsonMode && resp.status >= 400 && resp.status < 500) {
        return this.chat(messages, { ...extra, jsonMode: false });
      }
      throw new LlmError(`LLM endpoint returned ${resp.status}: ${text.slice(0, 500)}`);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LlmError(`LLM endpoint returned non-JSON content: ${text.slice(0, 200)}`);
    }
    const choice = data?.choices?.[0];
    if (!choice) {
      throw new LlmError(`LLM response is missing choices: ${text.slice(0, 200)}`);
    }
    return {
      content: choice.message?.content ?? '',
      toolCalls: choice.message?.tool_calls,
    };
  }

  completeJson<T>(system: string, user: string): Promise<T> {
    return completeJson<T>(this, system, user);
  }
}

/**
 * Ask the LLM for JSON matching a given shape, stripping markdown code fences automatically;
 * retries once with an error hint if parsing fails. Works with any LlmProvider.
 */
export async function completeJson<T>(provider: LlmProvider, system: string, user: string): Promise<T> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const first = await provider.chat(messages, { jsonMode: true });
  const parsed = tryParseJson<T>(first.content);
  if (parsed !== undefined) {
    return parsed;
  }
  const retry = await provider.chat(
    [
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content: 'The reply above could not be parsed as JSON. Output only a single valid JSON object, with no other text or markdown fences.',
      },
    ],
    { jsonMode: true },
  );
  const parsed2 = tryParseJson<T>(retry.content);
  if (parsed2 === undefined) {
    throw new LlmError(`LLM failed to produce valid JSON twice. Last reply: ${retry.content.slice(0, 300)}`);
  }
  return parsed2;
}

export function tryParseJson<T>(raw: string): T | undefined {
  let s = raw.trim();
  // Strip ```json ... ``` fences
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence) {
    s = fence[1];
  }
  // Some models add prose around the JSON; take from the first { to the last }
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      s = s.slice(start, end + 1);
    }
  }
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
