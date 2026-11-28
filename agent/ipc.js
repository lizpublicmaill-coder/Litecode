'use strict';
// Electron main-process wiring. All filesystem/shell access happens here, never in the renderer or the model.
const fs = require('fs');
const path = require('path');
const { createDispatcher } = require('./tools');
const { makeChat } = require('./models');
const { runAgent, buildSystemPrompt } = require('./loop');

module.exports = function registerAgentIpc({ ipcMain, dialog, app, readCfg, patchCfg }) {
  const runs = new Map();     // run id -> AbortController
  const pending = new Map();  // confirm id -> resolver

  const view = () => {
    const a = readCfg().agent || {};
    return { root: a.root || null, mode: a.mode === 'readonly' ? 'readonly' : 'normal', autoApprove: !!a.autoApprove };
  };

  ipcMain.handle('agent:cfg:get', () => view());
  ipcMain.handle('agent:cfg:set', (_, c) => {
    const a = { ...(readCfg().agent || {}) };
    if (c && (c.mode === 'readonly' || c.mode === 'normal')) a.mode = c.mode;
    if (c && typeof c.autoApprove === 'boolean') a.autoApprove = c.autoApprove;
    patchCfg({ agent: a });
    return view();
  });
  // The workspace root can only be set through the native folder picker (never by the model or page script).
  ipcMain.handle('agent:pick', async () => {
    const r = await dialog.showOpenDialog({ title: 'Choose workspace folder', properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths[0]) patchCfg({ agent: { ...(readCfg().agent || {}), root: r.filePaths[0] } });
    return view();
  });

  ipcMain.on('agent:stop', (_, id) => runs.get(id)?.abort());
  ipcMain.on('agent:confirm', (_, { reqId, allow }) => pending.get(reqId)?.(allow === true));

  ipcMain.handle('agent:run', async (e, { id, p, task, history, effort }) => {
    const cfg = view();
    if (!cfg.root) return { error: 'Choose a workspace folder first.' };
    const ac = new AbortController();
    runs.set(id, ac);
    const send = o => { if (!e.sender.isDestroyed()) e.sender.send('agent:evt', { ...o, id }); };

    const logFile = path.join(app.getPath('userData'), 'agent-log.jsonl');
    try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old'); } catch {}
    const log = entry => fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => {});

    const confirm = req => new Promise(resolve => {
      const reqId = Math.random().toString(36).slice(2);
      const done = v => { pending.delete(reqId); resolve(v); };
      pending.set(reqId, done);
      ac.signal.addEventListener('abort', () => done(false), { once: true });
      send({ t: 'confirm', reqId, req });
    });

    try {
      const d = createDispatcher({ root: cfg.root, mode: cfg.mode, autoApprove: cfg.autoApprove, confirm, log });
      const out = await runAgent({
        chat: makeChat(p, { effort }),
        system: buildSystemPrompt({ workspaceName: path.basename(d.root), mode: cfg.mode }),
        task, history: (history || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'),
        dispatch: d.dispatch, tools: d.tools, signal: ac.signal, onEvent: send,
      });
      send({ t: 'done', text: out.text });
    } catch (err) {
      if (err.name === 'AbortError' || ac.signal.aborted) send({ t: 'done', text: '', stopped: true });
      else send({ t: 'error', error: err.message });
    } finally { runs.delete(id); }
    return { ok: true };
  });
};
