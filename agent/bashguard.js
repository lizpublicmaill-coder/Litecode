'use strict';
// Detects obviously destructive shell commands. Matching ones are never auto-approved:
// the user must explicitly approve each one. This is a heuristic, not a sandbox.

const DEFAULT_PROTECTED = ['main', 'master', 'trunk', 'develop', 'dev', 'production', 'prod', 'stable'];

const stripQuotes = s => s.replace(/^["']|["']$/g, '');
const norm = s => stripQuotes(s).replace(/\/{2,}/g, '/');

function isRootishTarget(t) {
  t = norm(t);
  return /^\/\*?$/.test(t) || /^\/\.$/.test(t)
    || /^(~|\$HOME|\$\{HOME\})(\/\*?)?$/.test(t)
    || /^\/(bin|boot|dev|etc|home|lib\w*|opt|proc|root|sbin|srv|sys|usr|var|Users|System|Library)\/?\*?$/.test(t)
    || /^[a-zA-Z]:[\\/]*\*?$/.test(t);
}

function splitSegments(cmd) {
  return cmd.split(/&&|\|\||[;|&\n]/).map(s => s.trim()).filter(Boolean);
}

function tokens(seg) {
  const out = [];
  seg.replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (_, a, b, c) => { out.push(a ?? b ?? c); return ''; });
  return out;
}

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'env', 'nohup', 'time', 'nice', 'builtin', 'exec']);

function checkRm(toks) {
  let i = 0;
  while (i < toks.length && WRAPPERS.has(toks[i])) i++;
  if (toks[i] !== 'rm') return null;
  const rest = toks.slice(i + 1);
  const flags = rest.filter(t => t.startsWith('-'));
  const targets = rest.filter(t => !t.startsWith('-'));
  if (flags.includes('--no-preserve-root')) return 'rm --no-preserve-root';
  const recursive = flags.some(f => f === '--recursive' || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)));
  if (recursive && targets.some(isRootishTarget)) return 'recursive rm of a root/home/system directory';
  return null;
}

function checkGitPush(toks, protectedBranches) {
  const gi = toks.indexOf('git');
  if (gi < 0) return null;
  const pi = toks.indexOf('push', gi + 1);
  if (pi < 0) return null;
  const args = toks.slice(pi + 1);
  const force = args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'));
  if (!force) return null;
  if (args.includes('--all') || args.includes('--mirror')) return 'git force-push of all refs';
  const positional = args.filter(a => !a.startsWith('-') || a.startsWith('+'));
  if (positional.length <= 1) return 'git force-push without an explicit branch (may hit a protected branch)';
  const isProtected = b => protectedBranches.includes(b) || /^release[/-]/.test(b);
  for (const ref of positional.slice(1)) {
    const dst = (ref.replace(/^\+/, '').split(':').pop() || '').replace(/^refs\/heads\//, '');
    if (isProtected(dst)) return `git force-push to protected branch "${dst}"`;
  }
  return null;
}

/** Returns a human-readable reason if the command looks destructive, else null. */
function dangerReason(command, { protectedBranches = DEFAULT_PROTECTED } = {}) {
  const c = String(command);
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) return 'fork bomb';
  if (/\bdd\b[^\n;&|]*\bof=\/dev\/(?!null\b|zero\b|stdout\b|stderr\b)/.test(c)) return 'dd writing to a device';
  if (/\bmkfs(\.[a-z0-9]+)?\b/i.test(c)) return 'mkfs (formats a filesystem)';
  if (/\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+(?:0?777|a\+rwx|ugo\+rwx)\s+(?:--\s+)?["']?\/\*?["']?(?=\s|$|[;&|])/.test(c)
    || /\bchmod\s+0?777\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+["']?\/\*?["']?(?=\s|$|[;&|])/.test(c)) return 'chmod -R 777 on /';
  if (/>\s*\/dev\/(sd|hd|nvme|disk)\w*/.test(c)) return 'redirect into a block device';
  if (/\b(?:rd|rmdir|del|erase)\b[^\n;&|]*\s\/s\b[^\n;&|]*\s["']?[a-zA-Z]:[\\/]*\*?["']?(?=\s|$)/i.test(c)) return 'recursive delete of a Windows drive root';
  if (/\bRemove-Item\b[^\n;&|]*-Recurse[^\n;&|]*\s["']?[a-zA-Z]:[\\/]*\*?["']?(?=\s|$)/i.test(c)) return 'recursive delete of a Windows drive root';
  if (/\bformat(?:\.com)?\s+[a-zA-Z]:/i.test(c)) return 'format a Windows drive';

  for (const seg of splitSegments(c)) {
    const toks = tokens(seg);
    const r = checkRm(toks) || checkGitPush(toks, protectedBranches);
    if (r) return r;
  }
  return null;
}

module.exports = { dangerReason, DEFAULT_PROTECTED };
