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

function textPreview(message) {
  if (!message || typeof message !== 'object') return '';
  const m = message;
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
  return String(raw || '').slice(0, 280);
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

  const phoneRaw = jidUser(senderJid);
  // Only derive a phone when the sender JID is a real phone address. A @lid
  // (opaque id) or an outbound-group self-send has no usable client phone —
  // the message is still captured, just without a phone/contact to link.
  const phoneNormalized = (isLid || selfOutboundGroup) ? '' : normalizePhone(phoneRaw);

  return {
    phone_raw: phoneRaw || '',
    phone_normalized: phoneNormalized,
    is_group: isGroup,
    is_lid: isLid,
    self_outbound_group: selfOutboundGroup,
    sender_jid: senderJid,
    chat_jid: chatJid,
    direction: fromMe ? 'out' : 'in',
    message_id: (key.id != null ? String(key.id) : ''),
    text_preview: textPreview(msg && msg.message),
  };
}

module.exports = { normalizePhone, senderFromMessage, jidUser, jidDomain, isLidJid, textPreview };
