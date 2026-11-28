'use strict';
// Best-effort secret redaction for everything returned to the model and written to logs.
// This is a safety net, not a guarantee: unusual secret formats can slip through.

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],               // OpenAI, Anthropic (sk-ant-...), etc.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED_GITLAB_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi, 'Bearer [REDACTED]'],
  // key = value / "key": "value"
  [/((?:api[_-]?key|secret[_-]?access[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|passwd|password|pwd|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi, '$1[REDACTED]'],
];

// Every KEY=value line (used for .env files, where all values are treated as secret).
const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(.*)$/gm;

function redact(text, { envFile = false } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let s = text;
  if (envFile) s = s.replace(ENV_LINE, (m, k, v) => (v.trim() ? k + '[REDACTED]' : m));
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

function redactDeep(v, opts) {
  if (typeof v === 'string') return redact(v, opts);
  if (Array.isArray(v)) return v.map(x => redactDeep(x, opts));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redactDeep(v[k], opts);
    return o;
  }
  return v;
}

module.exports = { redact, redactDeep };
