import { ChatMessage, LlmProvider, ToolDef } from './client';

/** A tool the LLM can call: definition + local execution */
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
 * Generic tool-calling agent loop: the model may call tools repeatedly until it produces a
 * final reply without tool calls. When the endpoint doesn't support tools, the model won't
 * return tool_calls and the loop returns on the first step — so it degrades gracefully for
 * "context already in the prompt, tools are just optional extras" usage.
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
        result = `Error: unknown tool ${tc.function.name}`;
      } else {
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          result = await tool.run(args);
        } catch (e) {
          result = `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 8000) });
    }
  }

  // Steps exhausted: ask once more for a final conclusion without tools
  const final = await client.chat([...messages, { role: 'user', content: 'Based on the information above, give your final JSON conclusion directly without calling any more tools.' }]);
  return { content: final.content, steps: maxSteps, toolCalls };
}
