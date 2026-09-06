// ============================================================
// whatsapp/agent/prefilter.js — deterministic drop rules. No model call.
//
// Most group traffic is not a question to the firm. Everything dropped here
// never costs a token and never reaches the queue. Every drop has a reason so
// the drop rate per reason can be measured on live traffic (step 1 of the map).
//
//   prefilter({ text, direction, isGroup, senderIsStaff, dealId, kind,
//               lastFirmReplyAfter, addressedToOther }) -> { keep, reason }
// ============================================================

// Bare acknowledgements, greetings and closers in both languages. A '?' anywhere
// disqualifies a message from this list — a question is never an ack.
const ACK_WORD =
  '(ok(ay)?|k+|thanks?( you| u)?( (so|very) much)?|thx|ty|tysm|great|perfect|wonderful|amazing|awesome|sure|yes|no|got it|' +
  'received|noted|will do|sounds good|no problem|np|mazal tov|mazel tov|shavua tov|shabbat shalom|good shabbos|chag sameach|' +
  'gmar tov|shana tova|hi|hello|hey|good morning|good afternoon|good evening|' +
  'תודה( רבה)?|בסדר|סבבה|מעולה|מצוין|אוקיי?|כן|לא|קיבלתי|מקבל|יופי|בשמחה|שבוע טוב|שבת שלום|חג שמח|בוקר טוב|ערב טוב|היי|שלום|אמן|בע"ה|בעזרת השם|בהצלחה|מזל טוב)';
const SEP = '[\\s\\p{P}\\p{Emoji_Presentation}\\p{Extended_Pictographic}]*';
// one or more ack phrases, separated by punctuation/space/emoji only ("Great, thank you!", "Ok thanks 🙏")
const ACK_RE = new RegExp('^' + SEP + ACK_WORD + '(' + SEP + ACK_WORD + ')*' + SEP + '$', 'iu');

function isEmojiOnly(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]+$/u.test(t);
}

function isAck(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('?')) return false;
  if (t.length > 40) return false;
  return ACK_RE.test(t);
}

const MEDIA_ONLY_RE = /^\[(voice message|audio|image|video|document[^\]]*|sticker|location|contact card)\]$/i;

function prefilter(m) {
  const text = String((m && m.text) || '').trim();
  if (!m) return { keep: false, reason: 'no_message' };
  if (m.direction === 'out' || m.senderIsStaff) return { keep: false, reason: 'firm_sent' };
  if (m.kind && ['reaction', 'reactionMessage', 'protocolMessage', 'system', 'stub'].includes(m.kind)) return { keep: false, reason: 'system_or_reaction' };
  if (!text || MEDIA_ONLY_RE.test(text)) return { keep: false, reason: 'media_no_text' };
  if (isEmojiOnly(text)) return { keep: false, reason: 'emoji_only' };
  if (!m.dealId) return { keep: false, reason: 'unlinked_chat' };
  if (m.addressedToOther) return { keep: false, reason: 'addressed_to_other' };
  if (m.lastFirmReplyAfter) return { keep: false, reason: 'already_answered' };
  if (isAck(text)) return { keep: false, reason: 'ack' };
  return { keep: true, reason: null };
}

module.exports = { prefilter, isAck, isEmojiOnly };
