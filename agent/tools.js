'use strict';
// Local tool layer. The model never touches the filesystem: it requests tool calls,
// and createDispatcher().dispatch() validates, confirms, executes and redacts them.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ToolError, openWorkspace, resolveInside, isGitInternal } = require('./workspace');
const { redact, redactDeep } = require('./redact');
const { dangerReason } = require('./bashguard');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const SKIP_DIRS = new Set(['.git']);
const SKIP_HEAVY = new Set(['node_modules']);

/* ------------------------------ schemas ------------------------------ */
const S = (description) => ({ type: 'string', description });
const I = (description) => ({ type: 'integer', description });
const B = (description) => ({ type: 'boolean', description });

const SCHEMAS = {
  list: {
    description: 'List the entries of a directory in the workspace.',
    parameters: { type: 'object', properties: { path: S('Directory relative to the workspace root. Defaults to ".".') }, required: [] },
  },
  read: {
    description: 'Read a text file. Returns the content with line numbers. Use offset/limit for large files.',
    parameters: { type: 'object', properties: {
      filePath: S('File path relative to the workspace root.'),
      offset: I('1-based line number to start from. Default 1.'),
      limit: I('Maximum number of lines to return. Default 2000.'),
    }, required: ['filePath'] },
  },
  write: {
    description: 'Create a file or completely overwrite an existing one. Requires user confirmation. Prefer edit for small changes.',
    parameters: { type: 'object', properties: {
      filePath: S('File path relative to the workspace root.'),
      content: S('Full new content of the file.'),
    }, required: ['filePath', 'content'] },
  },
  edit: {
    description: 'Replace text in an existing file. oldString must match exactly once unless replaceAll is true. Requires user confirmation.',
    parameters: { type: 'object', properties: {
      filePath: S('File path relative to the workspace root.'),
      oldString: S('Exact text to replace (include enough context to be unique).'),
      newString: S('Replacement text.'),
      replaceAll: B('Replace every occurrence instead of requiring a unique match.'),
    }, required: ['filePath', 'oldString', 'newString'] },
  },
  glob: {
    description: 'Find files by glob pattern (supports **, *, ?, {a,b}). A pattern without "/" matches file names at any depth. Newest files first.',
    parameters: { type: 'object', properties: {
      pattern: S('Glob pattern, e.g. "**/*.js" or "*.md".'),
      path: S('Directory to search, relative to the workspace root. Defaults to ".".'),
    }, required: ['pattern'] },
  },
  grep: {
    description: 'Search file contents with a regular expression. Uses ripgrep when available.',
    parameters: { type: 'object', properties: {
      pattern: S('Regular expression to search for.'),
      path: S('Directory or file to search, relative to the workspace root. Defaults to ".".'),
      include: S('Only search files matching this glob, e.g. "*.js".'),
    }, required: ['pattern'] },
  },
  bash: {
    description: 'Run a shell command with the workspace root as the working directory. Requires user confirmation. Output is truncated.',
    parameters: { type: 'object', properties: {
      command: S('The command to run.'),
      timeoutMs: I('Timeout in milliseconds (default 120000, max 600000).'),
    }, required: ['command'] },
  },
  webfetch: {
    description: 'Fetch a public http(s) URL and return its text content (HTML is converted to plain text). Requires user confirmation.',
    parameters: { type: 'object', properties: { url: S('The http(s) URL to fetch.') }, required: ['url'] },
  },
};

const READ_ONLY_TOOLS = ['list', 'read', 'glob', 'grep'];
const ALL_TOOLS = ['list', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'webfetch'];

function enabledTools({ mode, webfetch = true } = {}) {
  if (mode === 'readonly') return READ_ONLY_TOOLS.slice();
  return ALL_TOOLS.filter(t => t !== 'webfetch' || webfetch);
}

function getToolDefs(opts) {
  return enabledTools(opts).map(name => ({ name, description: SCHEMAS[name].description, parameters: SCHEMAS[name].parameters }));
}

/** Minimal JSON-schema validation + light coercion. Unknown properties are dropped. */
function validateArgs(schema, args) {
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('Arguments must be a JSON object');
  const out = {};
  for (const [k, def] of Object.entries(schema.properties)) {
    let v = args[k];
    if (v === undefined || v === null) continue;
    if (def.type === 'integer') {
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = parseInt(v, 10);
      if (!Number.isInteger(v)) throw new ToolError(`"${k}" must be an integer`);
    } else if (def.type === 'boolean') {
      if (v === 'true') v = true; else if (v === 'false') v = false;
      if (typeof v !== 'boolean') throw new ToolError(`"${k}" must be a boolean`);
    } else if (def.type === 'string') {
      if (typeof v !== 'string') throw new ToolError(`"${k}" must be a string`);
    }
    out[k] = v;
  }
  for (const k of schema.required || []) if (!(k in out)) throw new ToolError(`Missing required argument "${k}"`);
  return out;
}

/* ------------------------------ helpers ------------------------------ */
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const posix = p => p.split(path.sep).join('/');

function globToRegExp(pattern) {
  let re = '', i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
      } else { re += '[^/]*'; i++; }
    } else if (c === '?') { re += '[^/]'; i++; }
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) { re += '\\{'; i++; }
      else { re += '(?:' + pattern.slice(i + 1, end).split(',').map(x => globToRegExp(x).source.slice(1, -1)).join('|') + ')'; i = end + 1; }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; i++; }
      else { re += '[' + pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end + 1; }
    } else { re += c.replace(/[.+^$()|\\\]}]/g, '\\$&'); i++; }
  }
  return new RegExp('^' + re + '$');
}

function makeGlobMatcher(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new ToolError('pattern is required');
  if (/^[\\/]/.test(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.split(/[\\/]+/).includes('..'))
    throw new ToolError('Pattern must be relative and may not contain ".."');
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegExp(p);
  const matchBase = !p.includes('/');
  return { test: rel => (matchBase ? re.test(rel.slice(rel.lastIndexOf('/') + 1)) : re.test(rel)), allowHeavy: p.includes('node_modules') };
}

/** Iterative directory walk. Never follows symlinks. */
function walk(baseAbs, onFile, { allowHeavy = false, maxFiles = 200000 } = {}) {
  const stack = [baseAbs];
  let n = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (!allowHeavy && SKIP_HEAVY.has(e.name))) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (++n > maxFiles) return false;
        if (onFile(full) === false) return true;
      }
    }
  }
  return true;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function readTextFile(abs, rel) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new ToolError(`${rel} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw new ToolError(`${rel} is too large (${st.size} bytes). Use grep or read with offset/limit on a smaller file.`);
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) throw new ToolError(`${rel} looks like a binary file`);
  return buf.toString('utf8');
}

function safeEnv() {
  const allow = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TERM', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const env = {};
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function isPrivateIp(ip) {
  const net = require('net');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

async function assertPublicHost(hostname) {
  const net = require('net');
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal'))
    throw new ToolError('Local/internal addresses are not allowed');
  if (net.isIP(h)) { if (isPrivateIp(h)) throw new ToolError('Private network addresses are not allowed'); return; }
  let addrs;
  try { addrs = await require('dns').promises.lookup(h, { all: true }); } catch { throw new ToolError('Could not resolve host'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new ToolError('Host resolves to a private network address');
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function previewLines(text, maxLines = 30, maxChars = 3000) {
  const lines = text.split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  if (lines.length > maxLines) out += `\n… (${lines.length - maxLines} more lines)`;
  return truncate(out, maxChars);
}

/* ------------------------------ dispatcher ------------------------------ */
/**
 * opts:
 *   root          workspace folder (required)
 *   mode          'normal' | 'readonly'
 *   autoApprove   skip confirmation for write/edit/bash/webfetch (never for dangerous bash)
 *   confirm       async ({tool, summary, detail, danger}) => boolean
 *   log           (entry) => void
 *   webfetch      set false to disable the tool
 *   useRipgrep    'auto' (default) | false
 *   protectedBranches, fetchImpl, maxOutput
 */
function createDispatcher(opts = {}) {
  const rootReal = openWorkspace(opts.root);
  const readonly = opts.mode === 'readonly';
  const enabled = new Set(enabledTools({ mode: opts.mode, webfetch: opts.webfetch }));
  const maxOutput = opts.maxOutput || 30000;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

  async function ask(req) {
    if (typeof opts.confirm !== 'function') return false;
    try { return (await opts.confirm(req)) === true; } catch { return false; }
  }
  const approve = (req) => (opts.autoApprove ? Promise.resolve(true) : ask(req));

  const IMPL = {
    async list({ path: p = '.' }) {
      const { abs, rel } = resolveInside(rootReal, p);
      if (!fs.statSync(abs).isDirectory()) throw new ToolError(`${rel} is not a directory`);
      const ents = fs.readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      const entries = ents.slice(0, 500).map(e => {
        const type = e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : 'file';
        const o = { name: e.name + (type === 'dir' ? '/' : ''), type };
        if (type === 'file') { try { o.size = fs.lstatSync(path.join(abs, e.name)).size; } catch {} }
        return o;
      });
      return { ok: true, path: rel, entries, truncated: ents.length > 500 };
    },

    async read({ filePath, offset = 1, limit = 2000 }) {
      const { abs, rel } = resolveInside(rootReal, filePath);
      if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);
      let text = readTextFile(abs, rel);
      if (/^\.env(\.|$)/i.test(path.basename(abs))) text = redact(text, { envFile: true });
      const all = text.split(/\r?\n/);
      if (all.length > 1 && all[all.length - 1] === '') all.pop();
      const total = all.length;
      limit = Math.max(1, Math.min(limit, 5000));
      offset = Math.max(1, offset);
      if (total > 0 && offset > total) throw new ToolError(`offset ${offset} is past the end of the file (${total} lines)`);
      const slice = all.slice(offset - 1, offset - 1 + limit);
      const content = slice.map((l, i) => `${String(offset + i).padStart(5, ' ')}| ${truncate(l, MAX_LINE_CHARS)}`).join('\n');
      const endLine = total === 0 ? 0 : offset + slice.length - 1;
      return { ok: true, path: rel, totalLines: total, startLine: total === 0 ? 0 : offset, endLine, truncated: endLine < total, content };
    },

    async write({ filePath, content }) {
      const { abs, rel } = resolveInside(rootReal, filePath);
      if (isGitInternal(rel)) throw new ToolError('Writing inside .git is not allowed');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) throw new ToolError(`Content too large (${bytes} bytes, max ${MAX_WRITE_BYTES})`);
      let existed = false;
      try { const st = fs.statSync(abs); if (st.isDirectory()) throw new ToolError(`${rel} is a directory`); existed = true; }
      catch (e) { if (e instanceof ToolError) throw e; }
      const ok = await approve({ tool: 'write', path: rel, summary: `${existed ? 'OVERWRITE' : 'Create'} ${rel} (${bytes} bytes)`, detail: previewLines(content) });
      if (!ok) throw new ToolError('The user denied this write. Nothing was changed.');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      resolveInside(rootReal, filePath); // re-verify after creating directories
      fs.writeFileSync(abs, content, 'utf8');
      return { ok: true, path: rel, created: !existed, bytes };
    },

    async edit({ filePath, oldString, newString, replaceAll = false }) {
      const { abs, rel } = resolveInside(rootReal, filePath);
      if (isGitInternal(rel)) throw new ToolError('Editing inside .git is not allowed');
      if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);
      if (oldString === '') throw new ToolError('oldString must not be empty (use write to create files)');
      if (oldString === newString) throw new ToolError('oldString and newString are identical');
      const text = readTextFile(abs, rel);
      let from = oldString, to = newString, count = text.split(from).length - 1;
      if (count === 0 && text.includes('\r\n') && !oldString.includes('\r\n')) {
        from = oldString.replace(/\n/g, '\r\n'); to = newString.replace(/\r?\n/g, '\r\n');
        count = text.split(from).length - 1;
      }
      if (count === 0) throw new ToolError('oldString was not found in the file. Re-read the file and copy the text exactly (including whitespace).');
      if (count > 1 && !replaceAll) throw new ToolError(`oldString matches ${count} places. Add surrounding context to make it unique, or set replaceAll to true.`);
      const ok = await approve({
        tool: 'edit', path: rel, summary: `Edit ${rel} (${count} replacement${count > 1 ? 's' : ''})`,
        detail: truncate('--- old\n' + previewLines(oldString, 15, 1500) + '\n+++ new\n' + previewLines(newString, 15, 1500), 3200),
      });
      if (!ok) throw new ToolError('The user denied this edit. Nothing was changed.');
      fs.writeFileSync(abs, text.split(from).join(to), 'utf8');
      return { ok: true, path: rel, replacements: count };
    },

    async glob({ pattern, path: p = '.' }) {
      const m = makeGlobMatcher(pattern);
      const { abs } = resolveInside(rootReal, p);
      if (!fs.statSync(abs).isDirectory()) throw new ToolError('path must be a directory');
      const hits = [];
      walk(abs, f => {
        const relBase = posix(path.relative(abs, f));
        if (m.test(relBase)) { let t = 0; try { t = fs.statSync(f).mtimeMs; } catch {} hits.push({ rel: posix(path.relative(rootReal, f)), t }); }
      }, { allowHeavy: m.allowHeavy });
      hits.sort((a, b) => b.t - a.t);
      return { ok: true, files: hits.slice(0, 200).map(h => h.rel), count: hits.length, truncated: hits.length > 200 };
    },

    async grep({ pattern, path: p = '.', include }) {
      if (!pattern) throw new ToolError('pattern is required');
      const { abs, rel } = resolveInside(rootReal, p);
      const inc = include ? makeGlobMatcher(include) : null;
      if (opts.useRipgrep !== false) {
        const r = await ripgrep(rootReal, pattern, rel, include);
        if (r) return r;
      }
      let re;
      try { re = new RegExp(pattern); } catch (e) { throw new ToolError('Invalid regular expression: ' + e.message); }
      const matches = [];
      let truncated = false;
      const scan = f => {
        const relF = posix(path.relative(rootReal, f));
        if (inc && !inc.test(posix(path.relative(abs, f)))) return;
        let st; try { st = fs.statSync(f); } catch { return; }
        if (st.size > 2 * 1024 * 1024) return;
        let buf; try { buf = fs.readFileSync(f); } catch { return; }
        if (looksBinary(buf)) return;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 4000) continue;
          if (re.test(lines[i])) {
            matches.push({ file: relF, line: i + 1, text: truncate(lines[i].trim(), 300) });
            if (matches.length >= 100) { truncated = true; return false; }
          }
        }
      };
      const st0 = fs.statSync(abs);
      if (st0.isFile()) scan(abs); else walk(abs, scan);
      return { ok: true, engine: 'js', matches, count: matches.length, truncated };
    },

    async bash({ command, timeoutMs = 120000 }) {
      if (!command.trim()) throw new ToolError('command is empty');
      timeoutMs = Math.max(1000, Math.min(timeoutMs, 600000));
      const danger = dangerReason(command, { protectedBranches: opts.protectedBranches });
      if (danger) {
        const ok = await ask({ tool: 'bash', danger: true, summary: `DANGEROUS COMMAND (${danger}). Approve only if you are sure.`, detail: command });
        if (!ok) throw new ToolError(`Blocked: ${danger}. The user did not approve this command.`);
      } else if (!(await approve({ tool: 'bash', summary: 'Run shell command', detail: command }))) {
        throw new ToolError('The user denied this command.');
      }
      return runShell(command, rootReal, timeoutMs, maxOutput);
    },

    async webfetch({ url }) {
      if (!fetchImpl) throw new ToolError('fetch is not available');
      let u;
      try { u = new URL(url); } catch { throw new ToolError('Invalid URL'); }
      if (!/^https?:$/.test(u.protocol)) throw new ToolError('Only http(s) URLs are allowed');
      await assertPublicHost(u.hostname);
      if (!(await approve({ tool: 'webfetch', summary: 'Fetch URL', detail: u.href }))) throw new ToolError('The user denied this fetch.');
      let res;
      for (let hop = 0; hop <= 3; hop++) {
        res = await fetchImpl(u.href, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'LiteChat-Agent/1.0' } });
        const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
        if (!loc) break;
        u = new URL(loc, u);
        if (!/^https?:$/.test(u.protocol)) throw new ToolError('Redirected to a non-http(s) URL');
        await assertPublicHost(u.hostname);
        if (hop === 3) throw new ToolError('Too many redirects');
      }
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !/text\/|json|xml|javascript/.test(type)) throw new ToolError(`Unsupported content type: ${type}`);
      let text = (await res.text()).slice(0, 2_000_000);
      if (type.includes('html')) text = htmlToText(text);
      return { ok: res.ok, url: u.href, status: res.status, contentType: type, content: truncate(text, 100000), truncated: text.length > 100000,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
    },
  };

  function scrub(msg) {
    return String(msg).split(rootReal).join('<workspace>');
  }

  /** call = { id, name, arguments } (arguments: object or JSON string) */
  async function dispatch(call) {
    const t0 = Date.now();
    const name = call && call.name;
    let args = call && call.arguments;
    let result;
    try {
      if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { throw new ToolError('Arguments are not valid JSON'); } }
      if (!Object.prototype.hasOwnProperty.call(IMPL, name)) throw new ToolError(`Unknown tool "${name}"`);
      if (!enabled.has(name)) throw new ToolError(`Tool "${name}" is not available${readonly ? ' in read-only mode' : ''}`);
      args = validateArgs(SCHEMAS[name].parameters, args);
      result = await IMPL[name](args);
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : (e && e.code ? `${e.code}: ${e.syscall || 'operation'} failed` : 'Tool failed: ' + (e && e.message));
      result = { ok: false, error: scrub(msg) };
    }
    result = redactDeep(result);
    if (typeof result.error === 'string') result.error = scrub(result.error);
    if (opts.log) {
      try {
        opts.log({
          ts: new Date().toISOString(), id: call && call.id, tool: name, ms: Date.now() - t0,
          args: redactDeep(summarizeArgs(args)), ok: result.ok, error: result.error,
          result: truncate(JSON.stringify(result), 2000),
        });
      } catch {}
    }
    return result;
  }

  return { dispatch, tools: getToolDefs({ mode: opts.mode, webfetch: opts.webfetch }), root: rootReal };
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const o = {};
  for (const [k, v] of Object.entries(args)) o[k] = typeof v === 'string' ? truncate(v, 500) : v;
  return o;
}

/* ------------------------------ ripgrep ------------------------------ */
function ripgrep(rootReal, pattern, relPath, include) {
  return new Promise(resolve => {
    const args = ['--no-config', '--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-columns-preview',
      '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--max-count', '50'];
    if (include) args.push('--glob', include);
    args.push('-e', pattern, '--', relPath === '' ? '.' : relPath);
    let child, out = '', err = '', done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try { child = spawn('rg', args, { cwd: rootReal, env: safeEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { return finish(null); }
    child.on('error', () => finish(null));       // rg not installed -> JS fallback
    child.stdout.on('data', d => { out += d; if (out.length > 1_000_000) child.kill(); });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      if (code === 2 && !out) return finish({ ok: false, error: 'grep failed: ' + truncate(err.trim(), 300) });
      const matches = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        matches.push({ file: m[1].replace(/\\/g, '/').replace(/^\.\//, ''), line: +m[2], text: truncate(m[3].trim(), 300) });
        if (matches.length >= 100) break;
      }
      finish({ ok: true, engine: 'ripgrep', matches, count: matches.length, truncated: matches.length >= 100 });
    });
  });
}

/* ------------------------------ shell ------------------------------ */
function runShell(command, cwd, timeoutMs, maxOutput) {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    let child, stdout = '', stderr = '', truncated = false, timedOut = false, settled = false;
    const finish = r => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const cap = (cur, d) => { if (cur.length >= maxOutput) { truncated = true; return cur; } const n = cur + d; if (n.length > maxOutput) { truncated = true; return n.slice(0, maxOutput); } return n; };
    try { child = spawn(command, { shell: true, cwd, env: safeEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin, windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: 'Could not start command' }); }
    const kill = () => {
      try { if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', d => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', d => { stderr = cap(stderr, d.toString()); });
    child.on('error', () => finish({ ok: false, error: 'Command failed to start' }));
    child.on('close', (code, signal) => {
      if (timedOut) return finish({ ok: false, error: `Command timed out after ${timeoutMs} ms`, stdout, stderr, truncated });
      finish({ ok: true, exitCode: code, ...(signal ? { signal } : {}), stdout, stderr, truncated });
    });
  });
}

module.exports = { createDispatcher, getToolDefs, enabledTools, validateArgs, globToRegExp, isPrivateIp, htmlToText, SCHEMAS };
