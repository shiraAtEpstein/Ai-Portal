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

module.exports = { normalizePhone, senderFromMessage, jidUser, jidDomain, isLidJid, phoneJidFromKey, textPreview };
