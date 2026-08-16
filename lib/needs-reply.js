// ============================================================
// lib/needs-reply.js — classify a client WhatsApp message into one of THREE
// categories (per the firm's taxonomy):
//
//   'required'  🔴  Response Required — clearly needs a reply or action.
//                   → alerted, and counted in response-time metrics.
//   'none'      🟢  No Response Needed — thanks, acknowledgements, plain info/FYI.
//                   → not alerted, not counted.
//   'potential' 🟡  Potential Response — might need a reply, but we're not sure.
//                   → not alerted, not counted (kept aside for review).
//
// Two layers, so a plain "thanks" never needs the AI:
//   1. A deterministic SAFETY NET labels obvious closers as 'none' ("תודה",
//      "thanx", emoji-only). A message with a '?' is never an obvious closer.
//   2. Everything else goes to Claude in ONE batched call.
//
//   evaluateNeedsReply(items, {model}) -> Map<key, 'required'|'none'|'potential'>
//     items: [{ key, text }]   key = a stable id (chat_jid, or a message id)
//
// RETRY, NEVER GUESS: if the AI is unavailable / fails / omits an item, that
// item is simply LEFT OUT of the map (no default category). The caller treats a
// missing key as "not classified yet" and tries again later — so when the AI
// comes back up, the message gets classified then, rather than being guessed
// wrong during an outage.
// ============================================================
const claude = require('./claude');

const CATEGORY = { REQUIRED: 'required', NONE: 'none', POTENTIAL: 'potential', VOICE: 'voice' };
// The AI only ever returns these three. 'voice' is assigned deterministically
// (a voice-only block) BEFORE the AI, so it is not in the AI's allowed set.
const VALID = new Set([CATEGORY.REQUIRED, CATEGORY.NONE, CATEGORY.POTENTIAL]);

// A chat gets the 'voice' status when the client's LATEST unanswered message is
// a voice note — that's the message actually awaiting a listen. We check the
// last line because the block is joined oldest-first, so earlier "Thanks" /
// questions don't hide a newer voice note (that was the Kreitman case). If the
// newest message is typed text, the text is classified normally instead.
function isVoiceLast(text) {
  const lines = String(text == null ? '' : text).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return false;
  // Drop an optional "Name: " sender label before checking (blocks are labelled).
  const last = lines[lines.length - 1].replace(/^[^:\n]{1,40}:\s*/, '');
  return /^\[(voice message|audio)\]$/i.test(last);
}

const SYSTEM =
  'You triage WhatsApp messages that clients sent to an Israeli law firm. ' +
  'Classify EACH message into exactly one of three categories:\n' +
  '- "required": the message clearly needs a reply or action from the firm — a direct ' +
  'question, an explicit request, a raised problem or concern, or chasing/following up on ' +
  'something still pending.\n' +
  '- "none": no response needed — a pure acknowledgement or closer ("תודה", "תודה רבה", ' +
  '"מצוין", "קיבלתי", "👍", "ok", "great thanks"), OR a purely informational message / FYI ' +
  'that plainly does not call for any answer.\n' +
  '- "potential": it MIGHT need a reply or action, but it is not clear-cut — e.g. a general ' +
  'update where the client says they will follow up themselves ("I will confirm ASAP"), a soft ' +
  'comment or hope with no direct question, or anything genuinely borderline.\n' +
  'Use "required" only when it is clearly needed; use "potential" when you are not confident; ' +
  'use "none" for clear closers and pure information. Hebrew and English both occur.\n' +
  'IMPORTANT — judge the CURRENT state: each item may contain SEVERAL messages from the ' +
  'client, in time order (oldest first). Decide whether the firm still needs to respond AS OF ' +
  'THE LAST message. If a later message has RESOLVED or made an earlier question irrelevant, ' +
  'classify by the latest state, not the earliest question. In particular, classify "none" when ' +
  'the client has answered their own question, withdrawn or changed the request, said they will ' +
  'handle it themselves, or indicated the matter is now being handled in person or on a call — ' +
  'e.g. "never mind", "we are here", "just arrived", "sorted it", "בוטל", "הגענו", "כבר טיפלנו". ' +
  'A pending question earlier in the block does NOT keep it "required" if the client has since ' +
  'arrived or otherwise moved past it.\n' +
  'TIME DECAY of arrival/ETA messages: each item is prefixed with "(last message Nm ago)". If ' +
  'the last message is a plan to arrive or an ETA — "on our way", "leaving now", "be there in 15 ' +
  'minutes", "arriving shortly", "אנחנו בדרך", "מגיע עוד רבע שעה" — and enough time has now passed ' +
  'that the visit has surely happened (more than the stated time plus ~20 minutes, or ~20+ minutes ' +
  'when no time was stated), classify "none": they have arrived and it is being handled in person. ' +
  'If little time has passed, keep judging it on its content.\n' +
  'A "[voice message]" token appearing ALONGSIDE typed text is just context — classify by the ' +
  'readable text (voice-only messages are handled separately and will not reach you).\n' +
  'MULTIPLE PEOPLE: the block is a group chat and each line is prefixed with the SENDER\'S NAME ' +
  '("Name: text"). Staff-member replies are NOT shown to you — everyone you see is a client or ' +
  'another non-staff participant (an agent, broker, family member, etc.). Your job is only to ' +
  'decide whether THE FIRM still needs to respond.\n' +
  'ANSWERED BY SOMEONE ELSE: if a question was already ANSWERED by anyone in the chat — even a ' +
  'non-staff participant — and nothing is left for the firm to do, classify "none". Likewise, if ' +
  'a message is clearly DIRECTED AT a specific non-staff person (by name or context) rather than ' +
  'the firm, and it is theirs to answer, classify "none" (or "potential" if you are unsure the ' +
  'firm is off the hook). Use "required" only when there is an OPEN item the firm itself must ' +
  'still handle — a question aimed at the office, or one nobody else has answered.';

// Obvious closers the safety net can label 'none' without the AI.
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

// true = obviously a closer we can safely label 'none' WITHOUT the AI.
function isObviousCloser(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return false;                 // unreadable/empty -> let the AI see it
  if (/[?؟？]/.test(raw)) return false;    // a question is never an obvious closer
  if (EMOJI_ONLY_RE.test(raw)) return true;
  const core = stripForCheck(raw);
  if (!core) return true;                 // was only emoji/punctuation
  if (OBVIOUS_CLOSERS.has(core)) return true;
  const toks = core.split(' ').filter(Boolean);
  if (toks.length > 0 && toks.length <= 3 && toks.every((t) => OBVIOUS_CLOSERS.has(t))) return true;
  return false;
}

// items: [{ key, text, lastMsgAgeMinutes? }]. Returns Map<key, category>.
// Missing key = not classified yet (AI unavailable/failed/omitted) — caller
// retries later. lastMsgAgeMinutes (optional) drives the arrival/ETA time-decay.
async function evaluateNeedsReply(items, { model } = {}) {
  const result = new Map();
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.key != null);
  if (!list.length) return result;

  // Layer 1 — deterministic net: voice-only -> 'voice'; obvious closers -> 'none'.
  const ambiguous = [];
  let voiceCount = 0;
  for (const it of list) {
    if (isVoiceLast(it.text)) { result.set(it.key, CATEGORY.VOICE); voiceCount++; }
    else if (isObviousCloser(it.text)) result.set(it.key, CATEGORY.NONE);
    else ambiguous.push(it);
  }
  console.log(`[unanswered/needs-reply] ${list.length} msg(s): ${voiceCount} -> voice, ${list.length - ambiguous.length - voiceCount} -> none (obvious closer), ${ambiguous.length} -> AI`);
  if (!ambiguous.length) return result;

  // Layer 2 — AI for the rest. If unavailable, leave them UNCLASSIFIED (retry).
  if (!claude.isConfigured()) {
    console.log('[unanswered/needs-reply] AI not configured — leaving ambiguous UNCLASSIFIED (retry when AI is available)');
    return result;
  }

  const numbered = ambiguous.map((it, i) => {
    const age = Number.isFinite(Number(it.lastMsgAgeMinutes)) ? Math.round(Number(it.lastMsgAgeMinutes)) : null;
    const prefix = age == null ? '' : '(last message ' + age + 'm ago) ';
    return { i, text: prefix + String(it.text || '').slice(0, 500) };
  });
  const user =
    'Classify each message below. Respond with JSON ONLY, exactly this shape:\n' +
    '{"results":[{"i":<index>,"category":"required|potential|none"}, ...]}\n\n' +
    'Messages:\n' +
    numbered.map((n) => '#' + n.i + ': ' + JSON.stringify(n.text)).join('\n');

  let json = null;
  try {
    json = await claude.askJSON({ system: SYSTEM, user, model, maxTokens: 2048 });
  } catch (e) {
    console.log('[unanswered/needs-reply] AI call threw (' + e.message + ') — leaving ambiguous UNCLASSIFIED (retry when up)');
    return result;
  }
  if (!json || !Array.isArray(json.results)) {
    console.log('[unanswered/needs-reply] AI failed/empty — leaving ambiguous UNCLASSIFIED (retry when up)');
    return result; // DO NOT guess — retry later
  }
  console.log(`[unanswered/needs-reply] AI classified ${ambiguous.length} ambiguous message(s)`);

  const byIndex = new Map();
  for (const r of json.results) {
    if (r && typeof r.i === 'number') {
      const c = String(r.category || '').toLowerCase();
      byIndex.set(r.i, VALID.has(c) ? c : null);
    }
  }
  ambiguous.forEach((it, i) => {
    const c = byIndex.has(i) ? byIndex.get(i) : null;
    if (c) result.set(it.key, c); // omitted / invalid -> leave absent (pending)
  });
  return result;
}

module.exports = { evaluateNeedsReply, isObviousCloser, CATEGORY };
