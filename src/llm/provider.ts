import { LlmClient, LlmProvider } from './client';
import { OpencodeClient } from './opencodeClient';
import { LlmConfig } from '../config';

/** Choose the backend based on the configured provider: OpenAI-compatible endpoint or opencode serve. */
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
