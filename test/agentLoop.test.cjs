const test = require('node:test');
const assert = require('node:assert/strict');

const { runAgent } = require('../out/llm/agentLoop');

// Fake client: returns scripted responses in order and records received messages, to verify the tool loop
class FakeClient {
  constructor(responses) {
    this.responses = responses;
    this.model = 'fake';
    this.received = [];
  }
  async chat(messages, extra) {
    this.received.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), extra });
    return this.responses.shift() ?? { content: '' };
  }
}

test('runAgent dispatches tool calls then returns final content', async () => {
  const client = new FakeClient([
    { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'get_callers', arguments: '{"name":"dao"}' } }] },
    { content: '{"verdict":"reachable"}' },
  ]);
  let toolArgs;
  const tools = [
    {
      def: { type: 'function', function: { name: 'get_callers', description: 'x', parameters: { type: 'object', properties: {}, required: [] } } },
      run: (args) => {
        toolArgs = args;
        return 'service@service.js:2';
      },
    },
  ];

  const res = await runAgent(client, [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools, 5);

  assert.equal(res.content, '{"verdict":"reachable"}');
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(toolArgs, { name: 'dao' });
  // the second request should include the assistant(tool_calls) and tool result messages
  const secondCall = client.received[1].messages;
  assert.ok(secondCall.some((m) => m.role === 'tool'));
});

test('runAgent returns immediately when no tool calls (degraded/no-tools endpoint)', async () => {
  const client = new FakeClient([{ content: '{"verdict":"undetermined"}' }]);
  const res = await runAgent(client, [{ role: 'user', content: 'u' }], [], 5);
  assert.equal(res.content, '{"verdict":"undetermined"}');
  assert.equal(res.toolCalls, 0);
  assert.equal(res.steps, 1);
});

test('runAgent reports unknown tool without throwing', async () => {
  const client = new FakeClient([
    { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'nope', arguments: '{}' } }] },
    { content: 'done' },
  ]);
  const res = await runAgent(client, [{ role: 'user', content: 'u' }], [], 5);
  assert.equal(res.content, 'done');
  const toolMsg = client.received[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /unknown tool/);
});
