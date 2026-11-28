'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDispatcher, getToolDefs, isPrivateIp, globToRegExp } = require('../agent/tools');
const { dangerReason } = require('../agent/bashguard');
const { redact } = require('../agent/redact');
const { runAgent } = require('../agent/loop');

function tmpWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'litechat-test-'));
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  return { base, root };
}
const call = (d, name, args, id = 't1') => d.dispatch({ id, name, arguments: args });

/* ---------------------------- path confinement ---------------------------- */
test('path traversal and absolute paths are rejected by every file tool', async () => {
  const { base, root } = tmpWorkspace();
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside');
  const d = createDispatcher({ root, autoApprove: true });
  const bad = ['../secret.txt', 'a/../../secret.txt', '..\\secret.txt', path.join(base, 'secret.txt'), '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\host\\share\\x', '~/x', 'a\0b'];
  for (const p of bad) {
    for (const [name, args] of [['read', { filePath: p }], ['write', { filePath: p, content: 'x' }], ['edit', { filePath: p, oldString: 'a', newString: 'b' }], ['list', { path: p }], ['glob', { pattern: '*', path: p }], ['grep', { pattern: 'x', path: p }]]) {
      const r = await call(d, name, args);
      assert.equal(r.ok, false, `${name}(${JSON.stringify(p)}) should be rejected`);
    }
  }
  assert.equal(fs.readFileSync(path.join(base, 'secret.txt'), 'utf8'), 'outside');
  // glob patterns may not climb out either
  assert.equal((await call(d, 'glob', { pattern: '../*' })).ok, false);
});

test('symlinks that escape the workspace are rejected', async (t) => {
  const { base, root } = tmpWorkspace();
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x.txt'), 'top secret');
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); fs.symlinkSync(path.join(base, 'nowhere'), path.join(root, 'dangling')); }
  catch { return t.skip('cannot create symlinks on this system'); }
  const d = createDispatcher({ root, autoApprove: true });
  assert.equal((await call(d, 'read', { filePath: 'link/x.txt' })).ok, false);
  assert.equal((await call(d, 'write', { filePath: 'link/new.txt', content: 'x' })).ok, false);
  assert.equal((await call(d, 'write', { filePath: 'dangling', content: 'x' })).ok, false);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(base, 'nowhere')), false);
});

test('writes inside .git are refused', async () => {
  const { root } = tmpWorkspace();
  const d = createDispatcher({ root, autoApprove: true });
  assert.equal((await call(d, 'write', { filePath: '.git/hooks/pre-commit', content: 'x' })).ok, false);
});

/* ---------------------------- confirmation ---------------------------- */
test('overwrite requires confirmation; denial leaves the file untouched', async () => {
  const { root } = tmpWorkspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'original');
  const seen = [];
  let answer = false;
  const d = createDispatcher({ root, confirm: async req => { seen.push(req); return answer; } });

  let r = await call(d, 'write', { filePath: 'a.txt', content: 'new' });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original');
  assert.equal(seen.length, 1);
  assert.match(seen[0].summary, /OVERWRITE/);

  answer = true;
  r = await call(d, 'write', { filePath: 'a.txt', content: 'new' });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'new');
});

test('with no confirm handler, writes/edits/bash are denied (fail closed)', async () => {
  const { root } = tmpWorkspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const d = createDispatcher({ root });
  assert.equal((await call(d, 'write', { filePath: 'b.txt', content: 'x' })).ok, false);
  assert.equal((await call(d, 'edit', { filePath: 'a.txt', oldString: 'hello', newString: 'bye' })).ok, false);
  assert.equal((await call(d, 'bash', { command: 'echo hi' })).ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
});

test('autoApprove skips confirmation for write/edit', async () => {
  const { root } = tmpWorkspace();
  let asked = 0;
  const d = createDispatcher({ root, autoApprove: true, confirm: async () => { asked++; return false; } });
  assert.equal((await call(d, 'write', { filePath: 'a.txt', content: 'one' })).ok, true);
  assert.equal((await call(d, 'edit', { filePath: 'a.txt', oldString: 'one', newString: 'two' })).ok, true);
  assert.equal(asked, 0);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two');
});

/* ---------------------------- edit semantics ---------------------------- */
test('edit fails on non-unique match unless replaceAll; also on missing/identical text', async () => {
  const { root } = tmpWorkspace();
  fs.writeFileSync(path.join(root, 'f.txt'), 'foo bar foo baz foo');
  let asked = 0;
  const d = createDispatcher({ root, confirm: async () => { asked++; return true; } });

  let r = await call(d, 'edit', { filePath: 'f.txt', oldString: 'foo', newString: 'qux' });
  assert.equal(r.ok, false);
  assert.match(r.error, /matches 3 places/);
  assert.equal(asked, 0, 'a failing edit must not prompt the user');
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'foo bar foo baz foo');

  assert.equal((await call(d, 'edit', { filePath: 'f.txt', oldString: 'nope', newString: 'x' })).ok, false);
  assert.equal((await call(d, 'edit', { filePath: 'f.txt', oldString: 'foo', newString: 'foo' })).ok, false);
  assert.equal((await call(d, 'edit', { filePath: 'f.txt', oldString: '', newString: 'x' })).ok, false);

  r = await call(d, 'edit', { filePath: 'f.txt', oldString: 'bar foo', newString: 'BAR' });
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 1);
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'foo BAR baz foo');

  r = await call(d, 'edit', { filePath: 'f.txt', oldString: 'foo', newString: '$&x', replaceAll: true });
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 2);
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), '$&x BAR baz $&x', 'replacement text must be literal');
});

test('edit matches LF patterns against CRLF files and keeps CRLF', async () => {
  const { root } = tmpWorkspace();
  fs.writeFileSync(path.join(root, 'w.txt'), 'a\r\nb\r\nc\r\n');
  const d = createDispatcher({ root, autoApprove: true });
  const r = await call(d, 'edit', { filePath: 'w.txt', oldString: 'a\nb', newString: 'x\ny' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'w.txt'), 'utf8'), 'x\r\ny\r\nc\r\n');
});

/* ---------------------------- round trip ---------------------------- */
for (const engine of ['js', 'rg']) {
  test(`create / read / list / glob / grep round trip (grep engine: ${engine})`, async (t) => {
    const { root } = tmpWorkspace();
    const d = createDispatcher({ root, autoApprove: true, useRipgrep: engine === 'rg' ? 'auto' : false });
    assert.equal((await call(d, 'write', { filePath: 'src/app.js', content: 'const a = 1;\nfunction hello() {\n  return "world";\n}\n' })).ok, true);
    assert.equal((await call(d, 'write', { filePath: 'src/util/helper.js', content: '// helper\nmodule.exports = 42;\n' })).ok, true);
    assert.equal((await call(d, 'write', { filePath: 'README.md', content: '# Title\nhello docs\n' })).ok, true);
    fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'function hello() {}');

    const rd = await call(d, 'read', { filePath: 'src/app.js' });
    assert.equal(rd.ok, true);
    assert.equal(rd.totalLines, 4);
    assert.match(rd.content, /^\s+1\| const a = 1;/);
    assert.match(rd.content, /\n\s+3\|\s+return "world";/);

    const part = await call(d, 'read', { filePath: 'src/app.js', offset: 2, limit: 1 });
    assert.equal(part.startLine, 2); assert.equal(part.endLine, 2); assert.equal(part.truncated, true);
    assert.equal((await call(d, 'read', { filePath: 'src/app.js', offset: 99 })).ok, false);

    const ls = await call(d, 'list', { path: '.' });
    assert.deepEqual(ls.entries.map(e => e.name), ['node_modules/', 'src/', 'README.md']);

    const g = await call(d, 'glob', { pattern: '**/*.js' });
    assert.deepEqual(g.files.sort(), ['src/app.js', 'src/util/helper.js']);       // node_modules skipped
    assert.deepEqual((await call(d, 'glob', { pattern: '*.md' })).files, ['README.md']);
    assert.deepEqual((await call(d, 'glob', { pattern: 'src/**/*.js' })).files.sort(), ['src/app.js', 'src/util/helper.js']);
    assert.deepEqual((await call(d, 'glob', { pattern: '*.js', path: 'src/util' })).files, ['src/util/helper.js']);

    const gr = await call(d, 'grep', { pattern: 'hello' });
    if (engine === 'rg' && gr.engine !== 'ripgrep') return t.skip('ripgrep not installed');
    assert.equal(gr.ok, true);
    assert.deepEqual(gr.matches.map(m => `${m.file}:${m.line}`).sort(), ['README.md:2', 'src/app.js:2']);
    const gi = await call(d, 'grep', { pattern: 'hello', include: '*.md' });
    assert.deepEqual(gi.matches.map(m => m.file), ['README.md']);
    assert.equal((await call(d, 'grep', { pattern: '(' , useRipgrep: false })).ok, false);
  });
}

test('read rejects binary and missing files; big outputs are bounded', async () => {
  const { root } = tmpWorkspace();
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  const d = createDispatcher({ root, autoApprove: true });
  assert.equal((await call(d, 'read', { filePath: 'bin.dat' })).ok, false);
  const r = await call(d, 'read', { filePath: 'nope.txt' });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(root), 'errors must not leak absolute paths');
});

/* ---------------------------- modes ---------------------------- */
test('read-only mode exposes and permits only list/read/glob/grep', async () => {
  const { root } = tmpWorkspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  assert.deepEqual(getToolDefs({ mode: 'readonly' }).map(t => t.name), ['list', 'read', 'glob', 'grep']);
  assert.deepEqual(getToolDefs({}).map(t => t.name), ['list', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'webfetch']);
  const d = createDispatcher({ root, mode: 'readonly', autoApprove: true, confirm: async () => true });
  assert.deepEqual(d.tools.map(t => t.name), ['list', 'read', 'glob', 'grep']);
  for (const [n, a] of [['write', { filePath: 'b', content: 'x' }], ['edit', { filePath: 'a.txt', oldString: 'x', newString: 'y' }], ['bash', { command: 'echo hi' }], ['webfetch', { url: 'https://example.com' }]])
    assert.equal((await call(d, n, a)).ok, false, `${n} must be rejected in read-only mode`);
  assert.equal((await call(d, 'read', { filePath: 'a.txt' })).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x');
});

test('unknown tools and malformed arguments return structured errors', async () => {
  const { root } = tmpWorkspace();
  const d = createDispatcher({ root });
  assert.deepEqual(Object.keys(await call(d, 'rm', {})), ['ok', 'error']);
  assert.equal((await call(d, 'constructor', {})).ok, false);
  assert.equal((await call(d, 'read', {})).ok, false);
  assert.equal((await d.dispatch({ id: 1, name: 'read', arguments: '{not json' })).ok, false);
  assert.equal((await call(d, 'read', { filePath: 5 })).ok, false);
});

/* ---------------------------- bash ---------------------------- */
test('dangerous commands are detected; ordinary ones are not', () => {
  const bad = ['rm -rf /', 'rm -rf /*', 'sudo rm -fr ~', 'rm -r -f $HOME', 'rm -rf --no-preserve-root /', 'rm -rf /usr', 'echo hi && rm -rf /',
    ':(){ :|:& };:', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sda1', 'mkfs /dev/sdb', 'chmod -R 777 /', 'chmod 777 -R /',
    'git push --force origin main', 'git push -f origin master', 'git push origin +main', 'git push --force-with-lease', 'git push -f',
    'git push --force origin HEAD:production', 'git push --force origin release-1.2', 'rd /s /q C:\\', 'format C:', 'Remove-Item -Recurse -Force C:\\'];
  for (const c of bad) assert.ok(dangerReason(c), `should flag: ${c}`);
  const ok = ['ls -la', 'rm -rf node_modules', 'rm -rf ./build', 'rm file.txt', 'rm -r dist/', 'git push origin feature/x', 'git push -u origin feature',
    'git push --force origin feature/x', 'git status', 'dd if=a of=b.img', 'chmod -R 755 ./dir', 'npm test && echo "rm -rf is dangerous"'];
  for (const c of ok) assert.equal(dangerReason(c), null, `should NOT flag: ${c}`);
});

test('dangerous bash needs explicit approval even in auto-approve mode', async () => {
  const { root } = tmpWorkspace();
  const reqs = [];
  const d = createDispatcher({ root, autoApprove: true, confirm: async r => { reqs.push(r); return false; } });
  const r = await call(d, 'bash', { command: 'rm -rf /' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Blocked/);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].danger, true);
  // ...and a safe command is not prompted at all under auto-approve
  const safe = await call(d, 'bash', { command: 'echo hello' });
  assert.equal(safe.ok, true);
  assert.equal(reqs.length, 1);
});

test('bash: confirmation, cwd is the workspace, env vars are not exposed, timeout works', async () => {
  const { root } = tmpWorkspace();
  process.env.LITECHAT_TEST_SECRET = 'super-secret-value-123';
  process.env.OPENAI_API_KEY = 'sk-testtesttesttesttesttest';
  try {
    const denied = createDispatcher({ root, confirm: async () => false });
    assert.equal((await call(denied, 'bash', { command: 'echo hi' })).ok, false);

    const d = createDispatcher({ root, confirm: async () => true });
    const cwd = await call(d, 'bash', { command: 'node -p "process.cwd()"' });
    assert.equal(cwd.ok, true);
    assert.equal(fs.realpathSync(cwd.stdout.trim()), fs.realpathSync(root));

    const env = await call(d, 'bash', { command: 'node -p "String(process.env.LITECHAT_TEST_SECRET) + \'|\' + String(process.env.OPENAI_API_KEY)"' });
    assert.equal(env.stdout.trim(), 'undefined|undefined');

    const fail = await call(d, 'bash', { command: 'node -e "process.exit(3)"' });
    assert.equal(fail.ok, true); assert.equal(fail.exitCode, 3);

    const slow = await call(d, 'bash', { command: 'node -e "setTimeout(()=>{},30000)"', timeoutMs: 1000 });
    assert.equal(slow.ok, false);
    assert.match(slow.error, /timed out/);
  } finally { delete process.env.LITECHAT_TEST_SECRET; delete process.env.OPENAI_API_KEY; }
});

/* ---------------------------- redaction & logging ---------------------------- */
test('secrets are redacted in tool output, .env values entirely, and in logs', async () => {
  const { root } = tmpWorkspace();
  const awsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const oaiKey = 'sk-proj-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  fs.writeFileSync(path.join(root, 'config.js'), `const aws = "${awsKey}";\nconst k = '${oaiKey}';\nconst password = "hunter2hunter2";\nconst ok = "plain text";\n`);
  fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://u:p@h/db\nSHORT=abc\n# comment\nEMPTY=\n');
  fs.writeFileSync(path.join(root, 'key.pem'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\n');
  const logs = [];
  const d = createDispatcher({ root, autoApprove: true, log: e => logs.push(e) });

  const c = (await call(d, 'read', { filePath: 'config.js' })).content;
  assert.ok(!c.includes(awsKey) && !c.includes(oaiKey) && !c.includes('hunter2hunter2'), c);
  assert.ok(c.includes('plain text'));
  const env = (await call(d, 'read', { filePath: '.env' })).content;
  assert.ok(!env.includes('postgres://') && !env.includes('abc'), env);
  assert.ok(env.includes('DATABASE_URL=[REDACTED]') && env.includes('# comment'));
  assert.ok(!(await call(d, 'read', { filePath: 'key.pem' })).content.includes('MIIEabc'));
  const g = await call(d, 'grep', { pattern: 'AKIA', useRipgrep: false });
  assert.ok(!JSON.stringify(g).includes(awsKey));
  const out = await call(d, 'bash', { command: `node -p "'${oaiKey}'"` });
  assert.ok(!out.stdout.includes(oaiKey));
  assert.ok(!JSON.stringify(logs).includes(oaiKey) && !JSON.stringify(logs).includes(awsKey));

  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'), 'Authorization: Bearer [REDACTED]');
  assert.ok(!redact('token=ghp_' + 'a'.repeat(36)).includes('ghp_a'));
  assert.equal(redact('max_tokens: 4096'), 'max_tokens: 4096');
});

test('every call and its result is logged', async () => {
  const { root } = tmpWorkspace();
  const logs = [];
  const d = createDispatcher({ root, autoApprove: true, log: e => logs.push(e) });
  await call(d, 'write', { filePath: 'a.txt', content: 'hi' }, 'id1');
  await call(d, 'read', { filePath: '../x' }, 'id2');
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(l => [l.id, l.tool, l.ok]), [['id1', 'write', true], ['id2', 'read', false]]);
  assert.ok(logs[0].result && logs[0].ts && logs[1].error);
});

/* ---------------------------- webfetch guards ---------------------------- */
test('webfetch refuses non-http, local and private targets before fetching', async () => {
  const { root } = tmpWorkspace();
  let fetched = 0;
  const d = createDispatcher({ root, autoApprove: true, fetchImpl: async () => { fetched++; throw new Error('should not fetch'); } });
  for (const url of ['file:///etc/passwd', 'ftp://x.com/a', 'http://localhost:8080/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://[::1]/', 'http://printer.local/', 'not a url'])
    assert.equal((await call(d, 'webfetch', { url })).ok, false, url);
  assert.equal(fetched, 0);
  assert.ok(isPrivateIp('192.168.1.1') && isPrivateIp('::ffff:10.0.0.1') && isPrivateIp('fd00::1') && !isPrivateIp('8.8.8.8') && !isPrivateIp('2606:4700::1111'));
});

test('globToRegExp basics', () => {
  assert.ok(globToRegExp('**/*.js').test('a/b/c.js') && globToRegExp('**/*.js').test('c.js') && !globToRegExp('**/*.js').test('c.ts'));
  assert.ok(globToRegExp('src/*.{js,ts}').test('src/a.ts') && !globToRegExp('src/*.js').test('src/x/a.js'));
});

/* ---------------------------- agent loop ---------------------------- */
test('agent loop: model requests tools, app executes them, final text is returned', async () => {
  const { root } = tmpWorkspace();
  const d = createDispatcher({ root, autoApprove: true });
  const script = [
    { text: 'Creating a file', tool_calls: [{ id: 'c1', name: 'write', arguments: { filePath: 'hello.txt', content: 'hello world\n' } }] },
    { text: '', tool_calls: [{ id: 'c2', name: 'read', arguments: JSON.stringify({ filePath: 'hello.txt' }) }, { id: 'c3', name: 'grep', arguments: { pattern: 'world' } }, { id: 'c4', name: 'read', arguments: { filePath: '../../etc/passwd' } }] },
    { text: 'All done.', tool_calls: [] },
  ];
  const seen = [];
  const chat = async (messages) => { seen.push(messages.map(m => m.role).join(',')); return script[seen.length - 1]; };
  const events = [];
  const out = await runAgent({ chat, system: 'sys', task: 'make a file', dispatch: d.dispatch, tools: d.tools, onEvent: e => events.push(e.t + ':' + (e.name || '')) });
  assert.equal(out.text, 'All done.');
  assert.deepEqual(seen, ['system,user', 'system,user,assistant,tool', 'system,user,assistant,tool,assistant,tool,tool,tool']);
  assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'hello world\n');
  const toolMsgs = out.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(toolMsgs[0].ok, true); assert.equal(toolMsgs[1].ok, true); assert.equal(toolMsgs[2].ok, true);
  assert.equal(toolMsgs[3].ok, false, 'traversal attempt from the model is rejected and reported back');
  assert.ok(events.includes('call:write') && events.includes('result:read'));
});

test('agent loop: step limit and abort', async () => {
  const { root } = tmpWorkspace();
  const d = createDispatcher({ root });
  const looping = async () => ({ text: '', tool_calls: [{ id: 'x', name: 'list', arguments: {} }] });
  const out = await runAgent({ chat: looping, system: 's', task: 't', dispatch: d.dispatch, tools: d.tools, maxSteps: 3 });
  assert.equal(out.limitReached, true);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(runAgent({ chat: looping, system: 's', task: 't', dispatch: d.dispatch, tools: d.tools, signal: ac.signal }), { name: 'AbortError' });
});
