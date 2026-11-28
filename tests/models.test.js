'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeChat } = require('../agent/models');
const { getToolDefs } = require('../agent/tools');

const tools = getToolDefs({ mode: 'readonly' });
const fakeFetch = (reply, sink) => async (url, init) => {
  sink.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
};
const history = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', name: 'read', arguments: '{"filePath":"a"}' }, { id: 'c2', name: 'list', arguments: { path: '.' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'read', content: '{"ok":true,"content":"x"}' },
  { role: 'tool', tool_call_id: 'c2', name: 'list', content: '{"ok":true,"entries":[]}' },
];

test('OpenAI-compatible adapter: request shape and tool_call parsing', async () => {
  const sent = [];
  const chat = makeChat({ type: 'openai', baseUrl: 'https://x.test/v1/', model: 'm', apiKey: 'K' }, {
    effort: 'high',
    fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'z', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] } }] }, sent),
  });
  const r = await chat(history, tools);
  assert.equal(sent[0].url, 'https://x.test/v1/chat/completions');
  assert.equal(sent[0].headers.Authorization, 'Bearer K');
  assert.equal(sent[0].body.reasoning_effort, 'high');
  assert.deepEqual(sent[0].body.tools.map(t => t.function.name), ['list', 'read', 'glob', 'grep']);
  const asst = sent[0].body.messages[2];
  assert.equal(typeof asst.tool_calls[0].function.arguments, 'string');
  assert.equal(asst.tool_calls[1].function.arguments, '{"path":"."}');
  assert.deepEqual(sent[0].body.messages.slice(3).map(m => m.tool_call_id), ['c1', 'c2']);
  assert.deepEqual(r.tool_calls, [{ id: 'z', name: 'glob', arguments: '{"pattern":"*"}' }]);
});

test('Anthropic adapter: system split out, tool results merged into one user turn, raw blocks replayed', async () => {
  const sent = [];
  const raw = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'c1', name: 'read', input: { filePath: 'a' } }];
  const chat = makeChat({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'K' }, {
    effort: 'low',
    fetchImpl: fakeFetch({ content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu', name: 'list', input: { path: 'src' } }] }, sent),
  });
  const r = await chat([...history.slice(0, 2), { ...history[2], raw }, ...history.slice(3)], tools);
  const b = sent[0].body;
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].headers['x-api-key'], 'K');
  assert.equal(b.system, 'SYS');
  assert.ok(!b.messages.some(m => m.role === 'system'));
  assert.deepEqual(b.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(b.messages[1].content, raw);
  assert.deepEqual(b.messages[2].content.map(x => x.tool_use_id), ['c1', 'c2']);
  assert.ok(b.tools[0].input_schema && !b.tools[0].parameters);
  assert.equal(b.thinking.budget_tokens, 2048);
  assert.ok(b.max_tokens > b.thinking.budget_tokens);
  assert.equal(r.text, 'hello');
  assert.deepEqual(r.tool_calls, [{ id: 'tu', name: 'list', arguments: { path: 'src' } }]);
});

test('Gemini adapter: function declarations, functionResponse parts, thoughts skipped', async () => {
  const sent = [];
  const chat = makeChat({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', apiKey: 'K' }, {
    fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'visible' }, { functionCall: { name: 'grep', args: { pattern: 'x' } } }] } }] }, sent),
  });
  const r = await chat(history, tools);
  const b = sent[0].body;
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(sent[0].headers['x-goog-api-key'], 'K');
  assert.equal(b.systemInstruction.parts[0].text, 'SYS');
  assert.deepEqual(b.contents.map(c => c.role), ['user', 'model', 'user']);
  assert.deepEqual(b.contents[1].parts.filter(p => p.functionCall).map(p => p.functionCall.name), ['read', 'list']);
  assert.deepEqual(b.contents[2].parts.map(p => p.functionResponse.name), ['read', 'list']);
  assert.deepEqual(b.contents[2].parts[0].functionResponse.response, { ok: true, content: 'x' });
  assert.deepEqual(b.tools[0].functionDeclarations.map(t => t.name), ['list', 'read', 'glob', 'grep']);
  assert.equal(r.text, 'visible');
  assert.equal(r.tool_calls.length, 1);
  assert.deepEqual(r.tool_calls[0].arguments, { pattern: 'x' });
});

test('HTTP errors surface as exceptions; missing base URL is rejected', async () => {
  const bad = async () => ({ ok: false, status: 401, text: async () => 'nope' });
  await assert.rejects(makeChat({ type: 'openai', baseUrl: 'https://x', model: 'm' }, { fetchImpl: bad })(history, tools), /HTTP 401/);
  assert.throws(() => makeChat({ type: 'openai', model: 'm' }), /Base URL/);
});
