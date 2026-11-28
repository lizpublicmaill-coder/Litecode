'use strict';
// Non-streaming tool-calling adapters. makeChat(provider) returns
//   async chat(messages, tools, signal) -> { text, tool_calls: [{id,name,arguments}], raw }
// Normalized messages (OpenAI-like):
//   {role:'system'|'user', content}
//   {role:'assistant', content, tool_calls?, raw?}     raw = provider-native blocks, replayed verbatim
//   {role:'tool', tool_call_id, name, content}         content = JSON string of the tool result
const { applyEffort } = require('./effort');

const argsObj = c => {
  if (c.arguments && typeof c.arguments === 'object') return c.arguments;
  try { const v = JSON.parse(c.arguments || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
const argsStr = c => (typeof c.arguments === 'string' ? c.arguments || '{}' : JSON.stringify(c.arguments || {}));

async function post(fetchImpl, url, headers, body, signal) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error('Provider returned invalid JSON'); }
}

function openaiChat(p, base, fetchImpl, effort) {
  return async (messages, tools, signal) => {
    const msgs = messages.map(m => {
      if (m.role === 'assistant' && m.tool_calls?.length)
        return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: argsStr(c) } })) };
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      return { role: m.role, content: m.content };
    });
    const body = { model: p.model, messages: msgs };
    if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    applyEffort(body, p, effort);
    const j = await post(fetchImpl, base + '/chat/completions', p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {}, body, signal);
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error('Provider returned no message');
    return { text: msg.content || '', tool_calls: (msg.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}' })) };
  };
}

function anthropicChat(p, base, fetchImpl, effort) {
  return async (messages, tools, signal) => {
    const system = messages.find(m => m.role === 'system')?.content;
    const out = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: m.raw || [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...(m.tool_calls || []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: argsObj(c) })),
        ] });
      } else if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
        const last = out[out.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block);
        else out.push({ role: 'user', content: [block] });
      } else out.push({ role: 'user', content: m.content });
    }
    const body = { model: p.model, max_tokens: p.maxTokens || 8192, messages: out, ...(system && { system }) };
    if (tools?.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    applyEffort(body, p, effort);
    const j = await post(fetchImpl, base + '/v1/messages', { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, body, signal);
    const blocks = j.content || [];
    return {
      text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
      tool_calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, arguments: b.input || {} })),
      raw: blocks,
    };
  };
}

function geminiChat(p, base, fetchImpl, effort) {
  let n = 0;
  return async (messages, tools, signal) => {
    const system = messages.find(m => m.role === 'system')?.content;
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant') {
        contents.push({ role: 'model', parts: m.raw || [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.tool_calls || []).map(c => ({ functionCall: { name: c.name, args: argsObj(c) } })),
        ] });
      } else if (m.role === 'tool') {
        let resp; try { resp = JSON.parse(m.content); } catch {}
        if (!resp || typeof resp !== 'object' || Array.isArray(resp)) resp = { result: m.content };
        const part = { functionResponse: { name: m.name, response: resp } };
        const last = contents[contents.length - 1];
        if (last && last.role === 'user' && last.parts[0]?.functionResponse) last.parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      } else contents.push({ role: 'user', parts: [{ text: m.content }] });
    }
    const body = { contents, ...(system && { systemInstruction: { parts: [{ text: system }] } }) };
    if (tools?.length) body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    applyEffort(body, p, effort);
    const j = await post(fetchImpl, `${base}/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, { 'x-goog-api-key': p.apiKey }, body, signal);
    const parts = j.candidates?.[0]?.content?.parts;
    if (!parts) throw new Error('Gemini returned no content' + (j.promptFeedback?.blockReason ? ` (blocked: ${j.promptFeedback.blockReason})` : ''));
    return {
      text: parts.filter(x => x.text && !x.thought).map(x => x.text).join(''),
      tool_calls: parts.filter(x => x.functionCall).map(x => ({ id: 'call_' + (++n), name: x.functionCall.name, arguments: x.functionCall.args || {} })),
      raw: parts,
    };
  };
}

function makeChat(p, { effort = 'auto', fetchImpl = fetch } = {}) {
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Provider has no Base URL');
  if (p.type === 'anthropic') return anthropicChat(p, base, fetchImpl, effort);
  if (p.type === 'gemini') return geminiChat(p, base, fetchImpl, effort);
  return openaiChat(p, base, fetchImpl, effort);
}

module.exports = { makeChat };
