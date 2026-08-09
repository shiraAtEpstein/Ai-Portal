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
