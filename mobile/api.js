// Browser/Android implementation of the same `api` that preload.js gives the desktop app.
// Talks to providers directly from the WebView. If the provider blocks the request (CORS),
// falls back to Capacitor's native HTTP (no streaming in that case: the reply arrives at once).
(() => {
  const handlers = [], aborts = new Map();
  const emit = m => handlers.forEach(h => h(m));

  // ---- storage (IndexedDB, so images don't hit localStorage's 5 MB limit) ----
  const db = new Promise((res, rej) => {
    const r = indexedDB.open('litechat', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const kv = async (mode, fn) => { const d = await db; return new Promise((res, rej) => {
    const rq = fn(d.transaction('kv', mode).objectStore('kv')); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); };

  const conv = (m, an) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    const imgs = m.images.map(d => an
      ? { type: 'image', source: { type: 'base64', media_type: d.match(/:(.*?);/)[1], data: d.split(',')[1] } }
      : { type: 'image_url', image_url: { url: d } });
    return { role: m.role, content: [...imgs, ...(m.content ? [{ type: 'text', text: m.content }] : [])] };
  };

  function applyEffort(body, p, e) {
    const lv = { low: 0, medium: 1, high: 2, max: 3 }[e]; if (lv === undefined) return body;
    const m = (p.model || '').toLowerCase();
    if (p.type === 'anthropic') {
      const budget = [2048, 8192, 16384, 32000][lv];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(body.max_tokens || 0, budget + 4096);
    } else if (p.type === 'gemini') {
      const g3 = /gemini-3/.test(m), pro = m.includes('pro');
      body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: g3
        ? { thinkingLevel: pro ? (lv < 1 ? 'low' : 'high') : ['low', 'medium', 'high', 'high'][lv] }
        : { thinkingBudget: [1024, 8192, 24576, pro ? 32768 : 24576][lv] } };
    } else {
      body.reasoning_effort = ['low', 'medium', 'high', 'high'][lv];
    }
    return body;
  }
  function buildRequest(p, raw, system) {
    const base = p.baseUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (p.type === 'gemini') {
      headers['x-goog-api-key'] = p.apiKey;
      return { headers, url: `${base}/v1beta/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse`,
        body: { contents: raw.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [
          ...(m.images || []).map(d => ({ inlineData: { mimeType: d.match(/:(.*?);/)[1], data: d.split(',')[1] } })),
          ...(m.content ? [{ text: m.content }] : [])] })),
          ...(system && { systemInstruction: { parts: [{ text: system }] } }) } };
    }
    if (p.type === 'anthropic') {
      headers['x-api-key'] = p.apiKey; headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      return { headers, url: base + '/v1/messages',
        body: { model: p.model, max_tokens: p.maxTokens || 4096, stream: true, messages: raw.map(x => conv(x, true)), ...(system && { system }) } };
    }
    if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;
    const messages = raw.map(x => conv(x, false));
    return { headers, url: base + '/chat/completions',
      body: { model: p.model, stream: true, messages: system ? [{ role: 'system', content: system }, ...messages] : messages } };
  }

  function parseLine(p, l) {
    l = l.trim(); if (!l.startsWith('data:')) return '';
    const d = l.slice(5).trim(); if (d === '[DONE]') return '';
    try {
      const j = JSON.parse(d);
      if (p.type === 'gemini') return (j.candidates?.[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
      if (p.type === 'anthropic') return j.type === 'content_block_delta' ? (j.delta?.text || '') : '';
      return j.choices?.[0]?.delta?.content || '';
    } catch { return ''; }
  }

  async function nativePost(url, headers, body) {
    const H = window.Capacitor?.Plugins?.CapacitorHttp;
    if (!H) throw new Error('Request blocked by the provider (CORS) and no native HTTP available');
    const r = await H.request({ url, method: 'POST', headers, data: body, responseType: 'text' });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${String(r.data).slice(0, 500)}`);
    return String(r.data);
  }

  window.api = {
    get: async () => { try { return (await kv('readonly', s => s.get('data'))) || null; } catch { return null; } },
    set: async d => { try { await kv('readwrite', s => s.put(JSON.parse(JSON.stringify(d)), 'data')); } catch {} },
    open: async u => { if (/^https?:\/\//.test(u)) window.open(u, '_blank'); },
    stop: id => aborts.get(id)?.abort(),
    on: cb => { handlers.push(cb); },

    models: async p => {
      try {
        const base = p.baseUrl.replace(/\/+$/, '');
        let url, headers = {};
        if (p.type === 'gemini') { url = base + '/v1beta/models?pageSize=1000'; headers['x-goog-api-key'] = p.apiKey; }
        else if (p.type === 'anthropic') { url = base + '/v1/models?limit=100'; headers = { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }; }
        else { url = base + '/models'; if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey; }
        let j;
        try {
          const r = await fetch(url, { headers });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          j = await r.json();
        } catch (e) {
          const H = window.Capacitor?.Plugins?.CapacitorHttp; if (!H || /^HTTP /.test(e.message)) throw e;
          const r = await H.request({ url, method: 'GET', headers }); if (r.status >= 400) throw new Error('HTTP ' + r.status);
          j = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        }
        if (p.type === 'gemini') return { ids: (j.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => m.name.replace(/^models\//, '')).sort() };
        return { ids: (j.data || j.models || []).map(x => x.id || x.name).filter(Boolean).sort() };
      } catch (e) { return { error: e.message }; }
    },

    start: async ({ id, p, messages, system, effort }) => {
      const ac = new AbortController(); aborts.set(id, ac);
      const send = (t, v) => emit({ id, t, v });
      const { url, headers, body } = buildRequest(p, messages, system);
      applyEffort(body, p, effort);
      try {
        let r;
        try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal }); }
        catch (e) {
          if (e.name === 'AbortError') throw e;
          // CORS / network failure -> native HTTP fallback (non-streaming)
          const text = await nativePost(url, headers, body);
          for (const l of text.split('\n')) { const t = parseLine(p, l); if (t) send('delta', t); }
          send('done'); return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
        const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const l of lines) { const t = parseLine(p, l); if (t) send('delta', t); }
        }
        send('done');
      } catch (err) { send(err.name === 'AbortError' ? 'done' : 'error', err.message); }
      finally { aborts.delete(id); }
    }
  };
})();
