// ============================================================
// lib/needs-reply.js — deterministic "does this client message need a reply?"
//
// No AI. A tiny keyword/emoji test so it's fully unit-testable and cheap to run
// over every unanswered chat's last inbound message. Purpose: don't nag staff
// about a chat whose last client message is just "תודה!" / "👍" / "ok".
//
//   needsReply(text) -> true  = a real message the firm should answer
//                       false = a pure acknowledgment / thanks / emoji / closer
//
// Rules (in order):
//   1. Empty / whitespace-only            -> false (nothing to answer)
//   2. Contains a question mark (? ؟ ？)   -> true
//   3. Contains a request/ask keyword      -> true
//   4. After stripping emoji + punctuation, what's left is only an
//      acknowledgment/thanks/closer token -> false
//   5. Anything else                       -> true (default to "needs a reply",
//                                             so we err on the side of flagging)
// ============================================================

// Question marks: ASCII, Arabic (؟), fullwidth (？).
const QUESTION_MARKS = /[?؟？]/;

// Request / ask keywords (Hebrew + English). Presence of any of these means the
// client is asking for something -> needs a reply, even without a '?'.
const REQUEST_KEYWORDS = [
  // Hebrew
  'אפשר', 'תוכל', 'תוכלי', 'אפשרי', 'בבקשה', 'צריך', 'צריכה', 'צריכים',
  'רוצה', 'רוצים', 'מבקש', 'מבקשת', 'תשלח', 'תשלחי', 'תשלחו', 'תעדכן',
  'תעדכני', 'מתי', 'איך', 'למה', 'כמה', 'האם', 'איפה', 'מה קורה', 'תחזור',
  'תחזרי', 'דחוף', 'שאלה', 'שאלות',
  // English
  'can you', 'could you', 'please', 'need', 'want', 'when', 'how', 'why',
  'what', 'where', 'update me', 'let me know', 'urgent', 'asap', 'question',
  'get back', 'call me', 'send me',
];

// Acknowledgment / thanks / closer tokens (Hebrew + English). If, after
// stripping emoji and punctuation, the whole message is made only of these
// tokens, it does NOT need a reply.
const ACK_TOKENS = new Set([
  // Hebrew
  'תודה', 'תודה רבה', 'רבה', 'מצוין', 'מצויין', 'מעולה', 'סבבה', 'אוקי',
  'אוקיי', 'אוקייי', 'קיבלתי', 'יופי', 'גדול', 'מושלם', 'טוב', 'בסדר',
  'סגור', ' מגניב', 'מגניב', 'נהדר', 'כן', 'לא', 'בהחלט', 'ברור',
  // English
  'thanks', 'thank you', 'thank', 'thx', 'ty', 'tnx', 'ok', 'okay', 'okey',
  'k', 'great', 'perfect', 'got it', 'gotit', 'cool', 'nice', 'awesome',
  'sure', 'yes', 'no', 'yep', 'yup', 'done', 'good', 'fine', 'noted',
]);

// Broad emoji / symbol range remover (covers 👍 🙏 😊 and friends) plus
// variation selectors and ZWJ used to build compound emoji.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2000}-\u{206F}]/gu;

// Strip emoji, then punctuation, collapse whitespace. Leaves letters/digits.
function stripEmojiAndPunct(s) {
  return String(s || '')
    .replace(EMOJI_RE, ' ')
    // Punctuation (ASCII + common Hebrew/quotes). Keep letters and digits.
    .replace(/[!"#$%&'()*+,\-./:;<=>?@\[\]^_`{|}~׳״…־׀׃׆]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function needsReply(text) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();

  // 1. Nothing / whitespace / emoji-or-punctuation-only -> no reply needed.
  if (!trimmed) return false;

  const lower = raw.toLowerCase();

  // 2. A question mark anywhere -> needs a reply.
  if (QUESTION_MARKS.test(raw)) return true;

  // 3. Any explicit request keyword -> needs a reply.
  for (const kw of REQUEST_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  // 4. Strip emoji + punctuation; if nothing meaningful remains, it was an
  //    emoji/punctuation-only message -> no reply needed.
  const core = stripEmojiAndPunct(raw);
  if (!core) return false;

  // Tokenize the remaining core and check whether EVERY token is an ack/closer.
  // Also test the whole core as a single phrase (covers "thank you", "got it",
  // "תודה רבה", "מה קורה"-style multi-word tokens are handled as keywords above).
  const coreLower = core.toLowerCase();
  if (ACK_TOKENS.has(coreLower)) return false;

  const tokens = coreLower.split(' ').filter(Boolean);
  if (tokens.length > 0 && tokens.length <= 4 && tokens.every((t) => ACK_TOKENS.has(t))) {
    return false;
  }

  // 5. Default: assume it needs a reply (err toward flagging, never toward
  //    silently dropping a real client message).
  return true;
}

module.exports = { needsReply };
