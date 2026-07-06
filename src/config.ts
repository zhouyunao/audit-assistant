import * as vscode from 'vscode';
import * as os from 'os';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  apiKey?: string;
}

const SECRET_KEY = 'auditAssistant.llm.apiKey';

export function getSettings() {
  const cfg = vscode.workspace.getConfiguration('auditAssistant');
  return {
    baseUrl: cfg.get<string>('llm.baseUrl', 'http://localhost:11434/v1'),
    model: cfg.get<string>('llm.model', ''),
    temperature: cfg.get<number>('llm.temperature', 0.2),
    maxTokens: cfg.get<number>('llm.maxTokens', 4096),
    timeoutMs: cfg.get<number>('llm.timeoutMs', 180000),
    outputLanguage: cfg.get<string>('analysis.outputLanguage', 'zh'),
    indexExclude: cfg.get<string[]>('index.exclude', []),
    author: cfg.get<string>('author', '') || os.userInfo().username,
  };
}

export async function getLlmConfig(context: vscode.ExtensionContext): Promise<LlmConfig> {
  const s = getSettings();
  const apiKey = await context.secrets.get(SECRET_KEY);
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    timeoutMs: s.timeoutMs,
    apiKey: apiKey || undefined,
  };
}

export async function setApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: '设置 LLM API Key',
    prompt: '保存在 VSCode SecretStorage（本机加密），不会写入设置文件。端点无需鉴权时可留空。',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return; // 用户取消
  }
  if (value === '') {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Audit Assistant: API Key 已清除');
  } else {
    await context.secrets.store(SECRET_KEY, value);
    vscode.window.showInformationMessage('Audit Assistant: API Key 已保存');
  }
}
