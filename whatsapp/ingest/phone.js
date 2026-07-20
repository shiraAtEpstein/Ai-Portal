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

  let phoneRaw;
  if (fromMe) {
    phoneRaw = jidUser(isGroup ? key.participant : chatJid);
  } else if (isGroup) {
    phoneRaw = jidUser(key.participant);
  } else {
    phoneRaw = jidUser(chatJid);
  }

  return {
    phone_raw: phoneRaw || '',
    phone_normalized: normalizePhone(phoneRaw),
    is_group: isGroup,
    chat_jid: chatJid,
    direction: fromMe ? 'out' : 'in',
    message_id: (key.id != null ? String(key.id) : ''),
    text_preview: textPreview(msg && msg.message),
  };
}

module.exports = { normalizePhone, senderFromMessage, jidUser, textPreview };
