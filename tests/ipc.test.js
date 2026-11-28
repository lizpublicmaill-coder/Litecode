'use strict';
// End-to-end through the real main-process wiring: ipc.js -> loop -> OpenAI adapter -> HTTP -> dispatcher -> disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registerAgentIpc = require('../agent/ipc');

function fakeElectron(userData, cfg) {
  const handlers = {}, listeners = {};
  const sent = [];
  const sender = { isDestroyed: () => false, send: (ch, m) => { sent.push(m); sender.onSend && sender.onSend(m); } };
  registerAgentIpc({
    ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    app: { getPath: () => userData },
    readCfg: () => cfg,
    patchCfg: o => Object.assign(cfg, o),
  });
  return { handlers, listeners, sent, sender };
}

// A tiny OpenAI-compatible server that plays back a script of assistant turns.
function fakeModelServer(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      requests.push(JSON.parse(b));
      const turn = script[requests.length - 1];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: turn }] }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('agent:run end to end: confirmation round trip, tool execution, log file, final text', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'litechat-ipc-'));
  const root = path.join(base, 'ws'); fs.mkdirSync(root);
  const userData = path.join(base, 'ud'); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');

  const m = await fakeModelServer([
    { role: 'assistant', content: 'Let me look.', tool_calls: [tc('a', 'list', {}), tc('b', 'read', { filePath: '../outside.txt' })] },
    { role: 'assistant', content: null, tool_calls: [tc('c', 'write', { filePath: 'out/new.txt', content: 'created by agent\n' })] },
    { role: 'assistant', content: 'Done: created out/new.txt.' },
  ]);
  try {
    const cfg = { agent: { root, mode: 'normal', autoApprove: false } };
    const el = fakeElectron(userData, cfg);
    const confirms = [];
    el.sender.onSend = msg => { if (msg.t === 'confirm') { confirms.push(msg); setImmediate(() => el.listeners['agent:confirm']({}, { reqId: msg.reqId, allow: true })); } };

    const ret = await el.handlers['agent:run']({ sender: el.sender }, { id: 'run1', p: { type: 'openai', baseUrl: m.url, model: 'fake', apiKey: 'k' }, task: 'make a file', history: [] });
    assert.deepEqual(ret, { ok: true });

    // The user was asked exactly once (the write), and the file exists only because they approved.
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].req.tool, 'write');
    assert.equal(fs.readFileSync(path.join(root, 'out/new.txt'), 'utf8'), 'created by agent\n');

    assert.ok(el.sent.length >= 8 && el.sent.every(x => x.id === 'run1'), 'every event must carry the run id');
    assert.deepEqual(el.sent.filter(x => x.t === 'call').map(x => x.callId), ['a', 'b', 'c']);
    const done = el.sent.find(x => x.t === 'done');
    assert.equal(done.text, 'Done: created out/new.txt.');
    assert.deepEqual(el.sent.filter(x => x.t === 'result').map(x => [x.name, x.ok]), [['list', true], ['read', false], ['write', true]]);

    // The model saw the traversal attempt fail, and never saw an absolute host path or the API key.
    const second = JSON.stringify(m.requests[1].messages);
    assert.ok(second.includes('is not allowed in paths'), 'model should be told ".." is rejected');
    assert.ok(!second.includes(base), 'host paths must not reach the model');
    assert.equal(m.requests[0].tools.length, 8);
    assert.ok(m.requests[0].messages[0].content.includes('untrusted DATA'));

    // Every call was logged.
    await new Promise(r => setTimeout(r, 50));
    const log = fs.readFileSync(path.join(userData, 'agent-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.map(l => [l.tool, l.ok]), [['list', true], ['read', false], ['write', true]]);
  } finally { m.server.close(); }
});

test('agent:run: read-only config exposes only 4 tools; denial and missing workspace are handled', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'litechat-ipc-'));
  const root = path.join(base, 'ws'); fs.mkdirSync(root);
  const m = await fakeModelServer([
    { role: 'assistant', content: null, tool_calls: [tc('w', 'write', { filePath: 'x.txt', content: 'no' })] },
    { role: 'assistant', content: 'Could not write; read-only.' },
  ]);
  try {
    const cfg = { agent: { root, mode: 'readonly' } };
    const el = fakeElectron(base, cfg);
    await el.handlers['agent:run']({ sender: el.sender }, { id: 'r2', p: { type: 'openai', baseUrl: m.url, model: 'f' }, task: 't' });
    assert.deepEqual(m.requests[0].tools.map(t => t.function.name), ['list', 'read', 'glob', 'grep']);
    assert.equal(el.sent.find(x => x.t === 'result').ok, false);
    assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);

    const none = fakeElectron(base, {});
    assert.match((await none.handlers['agent:run']({ sender: none.sender }, { id: 'r3', p: {}, task: 't' })).error, /workspace/i);
  } finally { m.server.close(); }
});

test('agent:stop aborts a pending confirmation and denies it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'litechat-ipc-'));
  const root = path.join(base, 'ws'); fs.mkdirSync(root);
  const m = await fakeModelServer([{ role: 'assistant', content: null, tool_calls: [tc('w', 'write', { filePath: 'x.txt', content: 'x' })] }]);
  try {
    const el = fakeElectron(base, { agent: { root, mode: 'normal' } });
    el.sender.onSend = msg => { if (msg.t === 'confirm') setImmediate(() => el.listeners['agent:stop']({}, 'r4')); };
    await el.handlers['agent:run']({ sender: el.sender }, { id: 'r4', p: { type: 'openai', baseUrl: m.url, model: 'f' }, task: 't' });
    assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
    assert.ok(el.sent.some(x => x.t === 'done' && x.stopped));
  } finally { m.server.close(); }
});
