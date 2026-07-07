import { LlmClient, LlmProvider } from './client';
import { OpencodeClient } from './opencodeClient';
import { LlmConfig } from '../config';

/** 按配置的 provider 选择后端：OpenAI 兼容端点或 opencode serve。 */
export function createLlmProvider(cfg: LlmConfig): LlmProvider {
  if (cfg.provider === 'opencode') {
    return new OpencodeClient({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      agent: cfg.agent,
      password: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }
  return new LlmClient({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    apiKey: cfg.apiKey,
  });
}
