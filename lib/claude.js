// ============================================================
// lib/claude.js — thin wrapper around the Anthropic SDK for backend jobs
// (deal matching, the Phase 4 summary processor). Separate from routes/chat.js
// (which streams to the browser); this is for one-shot JSON calls from workers.
// No-ops safely to null when ANTHROPIC_API_KEY is unset.
// ============================================================
const Anthropic = require('@anthropic-ai/sdk');

const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  opus: 'claude-opus-4-8',
};

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

function resolveModel(m) {
  return (m && (MODEL_ALIASES[m] || m)) || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
}

// Best-effort: pull a JSON object out of a model reply. Tolerates code fences
// and surrounding prose. Returns null if nothing parses.
function parseJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s !== -1 && e !== -1 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (_) { return null; }
}

// Ask Claude and get a parsed JSON object back. Returns null on any failure —
// callers treat null as "couldn't decide" and fall back safely.
async function askJSON({ system, user, model, maxTokens = 1024 } = {}) {
  const c = client();
  if (!c || !user) return null;
  try {
    const resp = await c.messages.create({
      model: resolveModel(model),
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: 'user', content: String(user) }],
    });
    const text = (resp.content || []).map((b) => (b && b.text) || '').join('').trim();
    return parseJSON(text);
  } catch (e) {
    console.error('[claude] askJSON failed:', e.message);
    return null;
  }
}

module.exports = { isConfigured, askJSON, resolveModel, parseJSON };
