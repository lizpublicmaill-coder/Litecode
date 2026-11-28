const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs'), path = require('path');
const aborts = new Map();
const file = () => path.join(app.getPath('userData'), 'data.json');

ipcMain.handle('store:get', () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return null; } });
ipcMain.handle('store:set', (_, d) => { fs.writeFileSync(file(), JSON.stringify(d)); });
ipcMain.handle('open', (_, u) => /^https?:\/\//.test(u) && shell.openExternal(u));
ipcMain.handle('models:list', async (_, p) => {
  try {
    const base = p.baseUrl.replace(/\/+$/, ''), an = p.type === 'anthropic';
    if (p.type === 'gemini') {
      const r = await fetch(base + '/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': p.apiKey } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return { ids: (j.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, '')).sort() };
    }
    const h = an ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } : (p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {});
    const r = await fetch(base + (an ? '/v1/models?limit=100' : '/models'), { headers: h });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return { ids: (j.data || j.models || []).map(x => x.id || x.name).filter(Boolean).sort() };
  } catch (e) { return { error: e.message }; }
});
const conv = (m, an) => {
  if (!m.images?.length) return { role: m.role, content: m.content };
  const imgs = m.images.map(d => an
    ? { type: 'image', source: { type: 'base64', media_type: d.match(/:(.*?);/)[1], data: d.split(',')[1] } }
    : { type: 'image_url', image_url: { url: d } });
  const txt = m.content ? [{ type: 'text', text: m.content }] : [];
  return { role: m.role, content: [...imgs, ...txt] };
};
ipcMain.on('chat:stop', (_, id) => aborts.get(id)?.abort());

ipcMain.handle('chat:start', async (e, { id, p, messages: raw, system }) => {
  const messages = raw.map(x => conv(x, p.type === 'anthropic'));
  const send = (t, v) => !e.sender.isDestroyed() && e.sender.send('chat:evt', { id, t, v });
  const ac = new AbortController(); aborts.set(id, ac);
  const base = p.baseUrl.replace(/\/+$/, '');
  let url, headers = { 'Content-Type': 'application/json' }, body;
  if (p.type === 'gemini') {
    url = `${base}/v1beta/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse`;
    headers['x-goog-api-key'] = p.apiKey;
    body = {
      contents: raw.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...(m.images || []).map(d => ({ inlineData: { mimeType: d.match(/:(.*?);/)[1], data: d.split(',')[1] } })),
          ...(m.content ? [{ text: m.content }] : [])
        ]
      })),
      ...(system && { systemInstruction: { parts: [{ text: system }] } })
    };
  } else if (p.type === 'anthropic') {
    url = base + '/v1/messages';
    headers['x-api-key'] = p.apiKey; headers['anthropic-version'] = '2023-06-01';
    body = { model: p.model, max_tokens: p.maxTokens || 4096, stream: true, messages, ...(system && { system }) };
  } else {
    url = base + '/chat/completions';
    if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;
    body = { model: p.model, stream: true, messages: system ? [{ role: 'system', content: system }, ...messages] : messages };
  }
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (let l of lines) {
        l = l.trim(); if (!l.startsWith('data:')) continue;
        const d = l.slice(5).trim(); if (d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const txt = p.type === 'gemini' ? (j.candidates?.[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('') : p.type === 'anthropic' ? (j.type === 'content_block_delta' ? j.delta?.text : '') : j.choices?.[0]?.delta?.content;
          if (txt) send('delta', txt);
        } catch {}
      }
    }
    send('done');
  } catch (err) { send(err.name === 'AbortError' ? 'done' : 'error', err.message); }
  finally { aborts.delete(id); }
});

app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1100, height: 750, backgroundColor: '#17181c', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  w.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
