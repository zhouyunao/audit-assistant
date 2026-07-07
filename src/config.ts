import * as vscode from 'vscode';
import * as os from 'os';

const OPENAI_DEFAULT_BASEURL = 'http://localhost:11434/v1';
const OPENCODE_DEFAULT_BASEURL = 'http://127.0.0.1:4096';

export interface LlmConfig {
  provider: 'openai' | 'opencode';
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** API key for the OpenAI endpoint, or the opencode server password */
  apiKey?: string;
  /** opencode agent name (optional) */
  agent?: string;
}

const SECRET_KEY = 'auditAssistant.llm.apiKey';

export function getSettings() {
  const cfg = vscode.workspace.getConfiguration('auditAssistant');
  return {
    provider: cfg.get<'openai' | 'opencode'>('llm.provider', 'openai'),
    baseUrl: cfg.get<string>('llm.baseUrl', OPENAI_DEFAULT_BASEURL),
    model: cfg.get<string>('llm.model', ''),
    temperature: cfg.get<number>('llm.temperature', 0.2),
    maxTokens: cfg.get<number>('llm.maxTokens', 4096),
    timeoutMs: cfg.get<number>('llm.timeoutMs', 180000),
    opencodeAgent: cfg.get<string>('llm.opencode.agent', ''),
    outputLanguage: cfg.get<string>('analysis.outputLanguage', 'en'),
    indexExclude: cfg.get<string[]>('index.exclude', []),
    author: cfg.get<string>('author', '') || os.userInfo().username,
  };
}

export async function getLlmConfig(context: vscode.ExtensionContext): Promise<LlmConfig> {
  const s = getSettings();
  const apiKey = await context.secrets.get(SECRET_KEY);
  // If an opencode user hasn't changed baseUrl (still the OpenAI default), auto-switch to the opencode default
  const baseUrl = s.provider === 'opencode' && s.baseUrl === OPENAI_DEFAULT_BASEURL ? OPENCODE_DEFAULT_BASEURL : s.baseUrl;
  return {
    provider: s.provider,
    baseUrl,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    timeoutMs: s.timeoutMs,
    apiKey: apiKey || undefined,
    agent: s.opencodeAgent || undefined,
  };
}

export async function setApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'Set LLM API Key',
    prompt: 'API key for the OpenAI endpoint, or the opencode server password (OPENCODE_SERVER_PASSWORD). Stored in VSCode SecretStorage (encrypted locally), never written to settings. Leave empty if no auth is required.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return; // user cancelled
  }
  if (value === '') {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Audit Assistant: API key cleared');
  } else {
    await context.secrets.store(SECRET_KEY, value);
    vscode.window.showInformationMessage('Audit Assistant: API key saved');
  }
}
