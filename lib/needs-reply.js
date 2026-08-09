// ============================================================
// lib/needs-reply.js — decide "does this client message need a reply?"
//
// Two layers, so a plain "thanks" never slips through even if the AI is down:
//   1. A deterministic SAFETY NET drops obvious closers ("תודה", "thanx",
//      emoji-only). A message with a '?' is never treated as a closer.
//   2. Everything else (ambiguous) goes to Claude (lib/claude.askJSON) in ONE
//      batched call, using the app's default working model (CLAUDE_MODEL /
//      sonnet — NOT a forced model that might be unavailable).
//
//   evaluateNeedsReply(items, {model}) -> Map<key, boolean>
//     items: [{ key, text }]   key = a stable id (we use chat_jid)
//     true  = needs a reply (show it) / false = pure closer (hide it)
//
// FAIL-SAFE: if the AI is unset/fails/omits an item, that AMBIGUOUS item
// defaults to true (show it) — we never silently drop a real client message.
// Empty/unreadable text is treated as "show it" too (safe), never as a closer.
// ============================================================
const claude = require('./claude');

const SYSTEM =
  'You triage WhatsApp messages that clients sent to an Israeli law firm. ' +
  'For each message decide whether it NEEDS a reply from the firm.\n' +
  'Return needsReply=false ONLY when the message is a pure closing / acknowledgement ' +
  'that a normal person would not reply to — e.g. "תודה", "תודה רבה", "מצוין", "מעולה", ' +
  '"קיבלתי", "👍", "ok", "great thanks", or an emoji-only message.\n' +
  'Return needsReply=true for anything that asks a question, makes a request, raises an ' +
  'issue, chases something, or otherwise expects a response — even if it also says thanks.\n' +
  'Hebrew and English both occur. When in doubt, return true.';

// Obvious closers the safety net can drop without the AI.
const OBVIOUS_CLOSERS = new Set([
  // Hebrew
  'תודה', 'תודה רבה', 'רבה', 'מצוין', 'מצויין', 'מעולה', 'סבבה', 'אוקי', 'אוקיי',
  'אוקייי', 'קיבלתי', 'יופי', 'מושלם', 'טוב', 'בסדר', 'סגור', 'מגניב', 'נהדר',
  'ברור', 'בהחלט', 'כן', 'לא', 'תודה רבה רבה',
  // English
  'thanks', 'thank you', 'thank', 'thanx', 'thnx', 'thx', 'ty', 'tnx', 'ok',
  'okay', 'okey', 'k', 'great', 'perfect', 'got it', 'gotit', 'cool', 'nice',
  'awesome', 'sure', 'yes', 'no', 'yep', 'yup', 'done', 'good', 'fine', 'noted',
]);

const EMOJI_ONLY_RE =
  /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2000}-\u{206F}\s]+$/u;

function stripForCheck(s) {
  return String(s || '')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@\[\]^_`{|}~׳״…־׀׃׆]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// true = obviously a closer we can safely hide WITHOUT the AI.
// Empty text -> false (not a known closer -> err toward showing).
function isObviousCloser(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return false;                 // unreadable/empty -> show it (safe)
  if (/[?؟？]/.test(raw)) return false;    // a question always needs a reply
  if (EMOJI_ONLY_RE.test(raw)) return true;
  const core = stripForCheck(raw);
  if (!core) return true;                 // was only emoji/punctuation
  if (OBVIOUS_CLOSERS.has(core)) return true;
  const toks = core.split(' ').filter(Boolean);
  if (toks.length > 0 && toks.length <= 3 && toks.every((t) => OBVIOUS_CLOSERS.has(t))) return true;
  return false;
}

// items: [{ key, text }]. Returns Map<key, boolean>.
async function evaluateNeedsReply(items, { model } = {}) {
  const result = new Map();
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.key != null);
  if (!list.length) return result;

  // Layer 1 — deterministic net: obvious closers dropped immediately.
  const ambiguous = [];
  for (const it of list) {
    if (isObviousCloser(it.text)) result.set(it.key, false);
    else ambiguous.push(it);
  }
  console.log(`[unanswered/needs-reply] ${list.length} msg(s): ${list.length - ambiguous.length} hidden by net (obvious closer), ${ambiguous.length} ambiguous -> AI`);
  if (!ambiguous.length) return result;

  // Layer 2 — AI for the rest. If unavailable, flag them (safe).
  if (!claude.isConfigured()) {
    console.log('[unanswered/needs-reply] AI not configured (no ANTHROPIC_API_KEY) — flagging all ambiguous as needs-reply');
    for (const it of ambiguous) result.set(it.key, true);
    return result;
  }

  const numbered = ambiguous.map((it, i) => ({ i, text: String(it.text || '').slice(0, 500) }));
  const user =
    'Classify each message below. Respond with JSON ONLY, exactly this shape:\n' +
    '{"results":[{"i":<index>,"needsReply":true|false}, ...]}\n\n' +
    'Messages:\n' +
    numbered.map((n) => '#' + n.i + ': ' + JSON.stringify(n.text)).join('\n');

  // model omitted -> lib/claude uses CLAUDE_MODEL / sonnet (the working default).
  const json = await claude.askJSON({ system: SYSTEM, user, model, maxTokens: 2048 });

  if (!json || !Array.isArray(json.results)) {
    console.log('[unanswered/needs-reply] AI call failed/empty — flagging all ambiguous as needs-reply (safe)');
    for (const it of ambiguous) result.set(it.key, true); // couldn't decide -> show
    return result;
  }
  console.log(`[unanswered/needs-reply] AI classified ${ambiguous.length} ambiguous message(s)`);

  const byIndex = new Map();
  for (const r of json.results) {
    if (r && typeof r.i === 'number') byIndex.set(r.i, r.needsReply !== false);
  }
  ambiguous.forEach((it, i) => {
    result.set(it.key, byIndex.has(i) ? byIndex.get(i) : true); // default show if omitted
  });
  return result;
}

module.exports = { evaluateNeedsReply, isObviousCloser };
