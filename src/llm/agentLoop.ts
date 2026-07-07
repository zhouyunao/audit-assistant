import { ChatMessage, LlmProvider, ToolDef } from './client';

/** 一个可被 LLM 调用的工具：定义 + 本地执行 */
export interface AgentTool {
  def: ToolDef;
  run(args: Record<string, unknown>): Promise<string> | string;
}

export interface AgentResult {
  content: string;
  steps: number;
  toolCalls: number;
}

/**
 * 通用 tool-calling agent 循环：模型可反复调用工具，直到给出不含工具调用的最终回复。
 * 端点不支持 tools 时模型不会返回 tool_calls，循环第一步即拿到最终回复——因此对
 * 「已把上下文喂进 prompt、工具只是可选补充」的用法能自然降级。
 */
export async function runAgent(
  client: LlmProvider,
  seed: ChatMessage[],
  tools: AgentTool[],
  maxSteps = 12,
): Promise<AgentResult> {
  const messages = [...seed];
  const byName = new Map(tools.map((t) => [t.def.function.name, t]));
  const defs = tools.map((t) => t.def);
  let toolCalls = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const res = await client.chat(messages, tools.length ? { tools: defs } : undefined);
    if (!res.toolCalls?.length) {
      return { content: res.content, steps: step, toolCalls };
    }
    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      toolCalls++;
      const tool = byName.get(tc.function.name);
      let result: string;
      if (!tool) {
        result = `错误：未知工具 ${tc.function.name}`;
      } else {
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          result = await tool.run(args);
        } catch (e) {
          result = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 8000) });
    }
  }

  // 步数耗尽：再要一次不带工具的最终结论
  const final = await client.chat([...messages, { role: 'user', content: '请基于以上信息直接给出最终 JSON 结论，不要再调用工具。' }]);
  return { content: final.content, steps: maxSteps, toolCalls };
}
