// OpenAI 兼容 /chat/completions 客户端。不依赖 SDK，直接用 fetch，
// 以兼容 vLLM / Ollama / OneAPI 等内网部署的端点。

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

export interface LlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export class LlmError extends Error {}

export class LlmClient {
  constructor(private readonly opts: LlmClientOptions) {}

  get model(): string {
    return this.opts.model;
  }

  async chat(messages: ChatMessage[], extra?: { tools?: ToolDef[]; jsonMode?: boolean }): Promise<ChatResult> {
    if (!this.opts.model) {
      throw new LlmError('未配置模型名，请在设置中填写 auditAssistant.llm.model');
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
      const msg = e instanceof Error && e.name === 'AbortError' ? '请求超时' : String(e);
      throw new LlmError(`无法访问 LLM 端点 ${url}：${msg}。请检查 auditAssistant.llm.baseUrl 配置和网络。`);
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    if (!resp.ok) {
      // 部分端点不支持 response_format，去掉后重试一次
      if (extra?.jsonMode && resp.status >= 400 && resp.status < 500) {
        return this.chat(messages, { ...extra, jsonMode: false });
      }
      throw new LlmError(`LLM 端点返回 ${resp.status}：${text.slice(0, 500)}`);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LlmError(`LLM 端点返回了非 JSON 内容：${text.slice(0, 200)}`);
    }
    const choice = data?.choices?.[0];
    if (!choice) {
      throw new LlmError(`LLM 回复缺少 choices：${text.slice(0, 200)}`);
    }
    return {
      content: choice.message?.content ?? '',
      toolCalls: choice.message?.tool_calls,
    };
  }

  /**
   * 要求 LLM 输出符合给定结构的 JSON，自动剥离 markdown 代码块围栏；
   * 解析失败时带着错误信息重试一次。
   */
  async completeJson<T>(system: string, user: string): Promise<T> {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const first = await this.chat(messages, { jsonMode: true });
    const parsed = tryParseJson<T>(first.content);
    if (parsed !== undefined) {
      return parsed;
    }
    const retry = await this.chat(
      [
        ...messages,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: '上面的回复无法解析为 JSON。请只输出一个合法的 JSON 对象，不要包含任何其他文字或 markdown 围栏。',
        },
      ],
      { jsonMode: true },
    );
    const parsed2 = tryParseJson<T>(retry.content);
    if (parsed2 === undefined) {
      throw new LlmError(`LLM 两次都未能输出合法 JSON。最后回复：${retry.content.slice(0, 300)}`);
    }
    return parsed2;
  }
}

export function tryParseJson<T>(raw: string): T | undefined {
  let s = raw.trim();
  // 剥离 ```json ... ``` 围栏
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence) {
    s = fence[1];
  }
  // 有些模型会在 JSON 前后加说明文字，截取第一个 { 到最后一个 }
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
