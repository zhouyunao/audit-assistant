const test = require('node:test');
const assert = require('node:assert/strict');

const { OpencodeClient, parseModel, buildMessageBody, extractText } = require('../out/llm/opencodeClient');

test('parseModel splits providerID/modelID on first slash', () => {
  assert.deepEqual(parseModel('anthropic/claude-3-5-sonnet-20241022'), { providerID: 'anthropic', modelID: 'claude-3-5-sonnet-20241022' });
  assert.deepEqual(parseModel('openai/gpt-4o'), { providerID: 'openai', modelID: 'gpt-4o' });
  assert.deepEqual(parseModel('local/my/model'), { providerID: 'local', modelID: 'my/model' });
  assert.deepEqual(parseModel('barename'), { providerID: '', modelID: 'barename' });
});

test('buildMessageBody puts system into system field and conversation into a text part', () => {
  const body = buildMessageBody(
    [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
    ],
    { providerID: 'anthropic', modelID: 'claude' },
    'auditor',
  );
  assert.deepEqual(body.model, { providerID: 'anthropic', modelID: 'claude' });
  assert.equal(body.system, 'SYS');
  assert.equal(body.agent, 'auditor');
  assert.equal(body.parts.length, 1);
  assert.equal(body.parts[0].type, 'text');
  assert.match(body.parts[0].text, /hello/);
});

test('buildMessageBody flattens multi-turn with role labels (for stateless sessions)', () => {
  const body = buildMessageBody(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'tool', content: 'T1' },
      { role: 'user', content: 'Q2' },
    ],
    { providerID: '', modelID: 'm' },
  );
  const text = body.parts[0].text;
  assert.match(text, /Q1/);
  assert.match(text, /assistant previous reply[\s\S]*A1/);
  assert.match(text, /tool result[\s\S]*T1/);
  assert.match(text, /Q2/);
  assert.equal(body.agent, undefined);
});

test('extractText concatenates text parts, ignores non-text', () => {
  assert.equal(
    extractText({ info: {}, parts: [{ type: 'reasoning', text: 'ignore' }, { type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }),
    'hello world',
  );
  assert.equal(extractText({ parts: [{ type: 'tool', name: 'x' }] }), '');
  assert.equal(extractText({ info: { parts: [{ type: 'text', text: 'nested' }] } }), 'nested');
  assert.equal(extractText({ info: { content: 'fallback' }, parts: [] }), 'fallback');
});

// Drive the full chat flow with a fake fetch: create session -> send message -> extract text
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const handler = Object.entries(routes).find(([re]) => new RegExp(re).test(url));
    const data = handler ? handler[1](JSON.parse(init.body)) : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  return { impl, calls };
}

test('chat: creates session then posts message and returns extracted text', async () => {
  const { impl, calls } = fakeFetch({
    '/session$': () => ({ id: 'sess_123' }),
    '/session/sess_123/message$': () => ({ info: {}, parts: [{ type: 'text', text: '{"ok":true}' }] }),
  });
  const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:4096/', model: 'anthropic/claude', password: 'pw', fetchImpl: impl });

  const res = await client.chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
  assert.equal(res.content, '{"ok":true}');
  assert.equal(res.toolCalls, undefined);

  // first call creates the session, second posts to that session
  assert.match(calls[0].url, /\/session$/);
  assert.match(calls[1].url, /\/session\/sess_123\/message$/);
  // password sent as a Bearer header
  assert.equal(calls[0].headers.authorization, 'Bearer pw');
  assert.equal(client.model, 'anthropic/claude');
});

test('completeJson works over opencode chat (JSON in text part)', async () => {
  const { impl } = fakeFetch({
    '/session$': () => ({ id: 's1' }),
    '/message$': () => ({ parts: [{ type: 'text', text: '```json\n{"verdict":"reachable"}\n```' }] }),
  });
  const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:4096', model: 'x/y', fetchImpl: impl });
  const out = await client.completeJson('sys', 'user');
  assert.deepEqual(out, { verdict: 'reachable' });
});

test('chat throws a helpful error when model lacks modelID', async () => {
  const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:4096', model: '', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'x' }]), /providerID\/modelID/);
});
