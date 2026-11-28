'use strict';
// Maps the UI "Thinking" level (low|medium|high|max) to each provider's reasoning parameters.
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
module.exports = { applyEffort };
