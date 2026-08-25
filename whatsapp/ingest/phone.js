// ============================================================
// whatsapp/ingest/phone.js — pure helpers, no DB / no side effects.
// ============================================================

function normalizePhone(input) {
  let digits = String(input == null ? '' : input).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');
  if (digits.length >= 9) return digits.slice(-9);
  return digits;
}

function jidUser(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

// The domain part of a JID: 's.whatsapp.net' (real phone), 'g.us' (group),
// 'lid' (WhatsApp's privacy-preserving "hidden" address), 'broadcast'
// (status/broadcast), 'newsletter' (channels), etc.
function jidDomain(jid) {
  if (!jid) return '';
  const at = String(jid).indexOf('@');
  return at === -1 ? '' : String(jid).slice(at + 1);
}

// A @lid address is NOT a phone number — it's an opaque per-chat identifier
// WhatsApp increasingly hands out (esp. in newer 1:1 chats and communities).
// Treating its digits as a phone yields a garbage "number" that matches no
// client and pollutes wa_contacts, so callers must detect and skip it.
function isLidJid(jid) {
  return jidDomain(jid) === 'lid';
}

// WhatsApp nests the real content inside wrapper envelopes — disappearing
// (ephemeralMessage), view-once, edited, and device-sent messages all carry a
// `.message` one (or more) levels down. Peel them so type detection sees the
// actual audioMessage/imageMessage/etc. instead of the wrapper.
function unwrapMessage(message) {
  let cur = message;
  let guard = 0;
  while (cur && typeof cur === 'object' && guard++ < 6) {
    const w =
      cur.ephemeralMessage ||
      cur.viewOnceMessage ||
      cur.viewOnceMessageV2 ||
      cur.viewOnceMessageV2Extension ||
      cur.documentWithCaptionMessage ||
      cur.editedMessage ||
      cur.deviceSentMessage;
    if (w && w.message) { cur = w.message; continue; }
    break;
  }
  return cur || message;
}

function textPreview(message) {
  if (!message || typeof message !== 'object') return '';

  // Cloud-API / history shape (from whatsapp/schema.js normalize, or a raw Cloud
  // API message): a `type` string with NO Baileys payload. Voice notes come as
  // type 'audio' with empty text — surface them as [voice message]. This is why
  // history-synced voice notes were invisible: they aren't Baileys-shaped.
  if (typeof message.type === 'string' && !message.message
      && !message.conversation && !message.extendedTextMessage
      && !message.audioMessage && !message.imageMessage && !message.videoMessage) {
    const t = message.type;
    const body = typeof message.text === 'string' ? message.text
               : (message.text && message.text.body) || '';
    if (body) return String(body).slice(0, 280);
    const cap = (message[t] && message[t].caption) || '';
    if (cap) return String(cap).slice(0, 280);
    if (t === 'audio' || t === 'voice' || t === 'ptt') return '[voice message]';
    if (t === 'image') return '[image]';
    if (t === 'video') return '[video]';
    if (t === 'document') {
      const fn = (message.media && message.media.filename) || (message.document && message.document.filename) || '';
      return '[document' + (fn ? ': ' + fn : '') + ']';
    }
    if (t === 'sticker') return '[sticker]';
    if (t === 'location') return '[location]';
    if (t === 'contacts' || t === 'contact') return '[contact card]';
    return ''; // type 'text' with no body, or an unknown type
  }

  const m = unwrapMessage(message);
  const raw =
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedButtonId) ||
    (m.listResponseMessage &&
      m.listResponseMessage.singleSelectReply &&
      m.listResponseMessage.singleSelectReply.selectedRowId) ||
    '';
  if (raw) return String(raw).slice(0, 280);

  // No readable text — label the media type so the message is never invisible
  // on the board. Voice notes especially must be surfaced (they usually need a
  // reply) until transcription exists. Mirrors whatsapp/ingest/processor.js.
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice message]' : '[audio]';
  if (m.imageMessage) return '[image]';
  if (m.videoMessage) return '[video]';
  if (m.documentMessage) return '[document' + (m.documentMessage.fileName ? ': ' + m.documentMessage.fileName : '') + ']';
  if (m.stickerMessage) return '[sticker]';
  if (m.locationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
  return '';
}

// WhatsApp may identify a sender by an opaque @lid (privacy id) as the main
// address while ALSO attaching the real phone-number address in a companion
// field on the key. Field names vary across Baileys/WhatsApp versions, so we
// scan the known candidates and take the first that is a real phone address
// (@s.whatsapp.net). Returns that JID, or null if only a LID is available.
function phoneJidFromKey(key) {
  if (!key || typeof key !== 'object') return null;
  const candidates = [key.senderPn, key.participantPn, key.participantAlt, key.remoteJidAlt];
  for (const c of candidates) {
    if (typeof c === 'string' && c.endsWith('@s.whatsapp.net')) return c;
  }
  return null;
}

function senderFromMessage(msg) {
  const key = (msg && msg.key) || {};
  const chatJid = key.remoteJid || '';
  const isGroup = chatJid.endsWith('@g.us');
  const fromMe = !!key.fromMe;

  // Which JID identifies the *sender* whose phone we want. For an outbound
  // group message that's our own device — there is no single client to
  // attribute it to (the "counterparty" is the whole group), so we flag it
  // and don't try to pin it to one client's phone.
  let senderJid;
  if (fromMe) {
    senderJid = isGroup ? key.participant : chatJid;
  } else if (isGroup) {
    senderJid = key.participant;
  } else {
    senderJid = chatJid;
  }
  senderJid = senderJid || '';

  const isLid = isLidJid(senderJid);
  const selfOutboundGroup = fromMe && isGroup;

  // Pick the address to derive a phone from. If the sender is a real phone
  // address, use it. If it's a @lid, try to recover a companion phone-number
  // address WhatsApp may have attached; if there's only a LID, we get null and
  // the message is captured without a phone (still no fake contacts).
  let phoneJid = null;
  if (!selfOutboundGroup) {
    if (!isLid && senderJid) phoneJid = senderJid;
    else if (isLid) phoneJid = phoneJidFromKey(key);
  }
  const lidResolved = isLid && !!phoneJid;         // a LID we mapped back to a phone
  const lidUnresolved = isLid && !phoneJid;        // a LID with no phone available

  const phoneRaw = jidUser(phoneJid || senderJid);
  const phoneNormalized = phoneJid ? normalizePhone(jidUser(phoneJid)) : '';

  return {
    phone_raw: phoneRaw || '',
    phone_normalized: phoneNormalized,
    is_group: isGroup,
    is_lid: isLid,
    lid_resolved: lidResolved,
    lid_unresolved: lidUnresolved,
    self_outbound_group: selfOutboundGroup,
    sender_jid: senderJid,
    chat_jid: chatJid,
    direction: fromMe ? 'out' : 'in',
    message_id: (key.id != null ? String(key.id) : ''),
    timestamp: msgTimestamp(msg),
    text_preview: textPreview(msg && msg.message),
  };
}

// WhatsApp message send-time in unix seconds. Baileys gives a number, a numeric
// string, or a protobuf Long ({low, high}). Returns null if unavailable (caller
// falls back to ingestion time).
function msgTimestamp(msg) {
  const t = msg && msg.messageTimestamp;
  if (t == null) return null;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; }
  if (typeof t === 'object' && typeof t.low === 'number') return t.low; // Long
  return null;
}

// Keys WhatsApp attaches ALONGSIDE the real content. In a GROUP, Baileys puts
// the key-exchange record in the same object as the message, and it frequently
// comes first — so `Object.keys()[0]` on a perfectly ordinary group message
// returns 'senderKeyDistributionMessage'.
//
// That is not a detail. Reading the first key blindly labelled most group
// traffic — including the firm's own replies — as a system record, and the
// unanswered detector drops system records. Replies went invisible and every
// group chat read as unanswered from the beginning of time.
//
// So these are never a message's identity while anything else is present.
const SIDE_CHANNEL_KEYS = ['senderKeyDistributionMessage', 'messageContextInfo'];

// The kind of message this is, once the wrappers are peeled: 'reactionMessage',
// 'audioMessage', 'conversation', 'imageMessage', … Diagnostics only — it says
// what a row IS without exposing what it SAYS.
//
// 'system' means the row carried nothing but side-channel keys: a genuine
// key-exchange record with no message in it. A single label for that case keeps
// the repair pass in whatsapp/ingest/db.js convergent — nothing is left holding
// a value that pass would want to re-examine.
function messageKind(message) {
  if (!message || typeof message !== 'object') return 'unknown';

  // NO CONTENT AT ALL. Baileys sends group events — "X joined", "the security
  // code changed" — as rows with a key and a messageStubType but no `.message`.
  // Reading the first key of the envelope labelled those 'key' or
  // 'messageStubParameters', and they were then counted as client messages that
  // could open a wait. Nobody is waiting for an answer to a join notification.
  //
  // Only a row that SAYS it is a stub is treated as one. A content-less row with
  // no stub markers (a missed call, a payload that lost its body) is left as
  // 'noContent' and still counts — fail open, as everywhere else here.
  if (!message.message) {
    return (message.messageStubType != null || message.messageStubParameters) ? 'stub' : 'noContent';
  }

  const m = unwrapMessage(message.message);
  if (!m || typeof m !== 'object') return 'unknown';
  if (typeof m.type === 'string') return m.type;            // Cloud-API / history shape
  const keys = Object.keys(m).filter((k) => SIDE_CHANNEL_KEYS.indexOf(k) === -1);
  if (keys.length) return keys[0];
  return Object.keys(m).length ? 'system' : 'unknown';
}

module.exports = { normalizePhone, senderFromMessage, jidUser, jidDomain, isLidJid, phoneJidFromKey, textPreview, messageKind, unwrapMessage, SIDE_CHANNEL_KEYS };
