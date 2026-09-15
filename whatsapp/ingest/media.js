// ============================================================
// whatsapp/ingest/media.js — downloads and decrypts a Baileys media message.
//
// Stateless: doesn't need a live socket, just the message's own mediaKey/
// directPath/url — exactly what a stored, previously-ingested message already
// carries in processing_jobs.payload_encrypted (see whatsapp/ingest/db.js).
//
// This implements the real behavior behind whatsapp/groups/provider.js's
// downloadAttachment(), which was a throwing stub through Phase 1
// ("Media download not implemented yet — text-only"). Voice-message
// transcription (whatsapp/ingest/voice.js) is the first real caller.
// ============================================================
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// A Buffer that went through JSON.stringify -> JSON.parse — exactly what
// happens to a stored message, since whatsapp/ingest/db.js's enqueueJob()
// JSON.stringifies the raw Baileys message (including binary fields like
// audioMessage.mediaKey) before encrypting it — comes back as a plain object
// { type: 'Buffer', data: [...] }, not a real Buffer. Baileys' getMediaKeys()
// needs a real Buffer/Uint8Array (or a base64 string); rehydrate just the one
// field downloadContentFromMessage actually reads.
function rehydrateMediaKey(node) {
  const k = node && node.mediaKey;
  if (k && k.type === 'Buffer' && Array.isArray(k.data)) {
    return Object.assign({}, node, { mediaKey: Buffer.from(k.data) });
  }
  return node;
}

// Mirrors whatsapp/ingest/phone.js's unwrapMessage (ephemeral/view-once/
// edited envelopes). Duplicated rather than imported so this module's only
// real dependency is Baileys itself — it's meant to be usable standalone,
// independent of a live provider instance or the rest of the ingest pipeline.
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

// rawMessage: the full parsed Baileys message object as stored (i.e.
// JSON.parse(enc.decrypt(processing_jobs.payload_encrypted))) — accepts
// either the outer { key, message: {...} } shape or an already-unwrapped
// `.message` node, matching how callers elsewhere do `msg && (msg.message || msg)`.
//
// NOTE (not yet live-verified): WhatsApp media URLs are time-limited. This
// is called as soon as possible after ingest (see whatsapp/ingest/voice.js /
// listTaskInboxMessages()), but a long-delayed retry on an old message could
// hit an expired URL — surfaces as a normal thrown error, caught and recorded
// as a failed transcription attempt by the caller, never a crash.
async function downloadAudioBuffer(rawMessage) {
  const outer = rawMessage && (rawMessage.message || rawMessage);
  const m = unwrapMessage(outer);
  const audio = m && m.audioMessage;
  if (!audio) throw new Error('downloadAudioBuffer: message has no audioMessage');
  const media = rehydrateMediaKey(audio);
  const stream = await downloadContentFromMessage(media, 'audio');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return {
    buffer: Buffer.concat(chunks),
    mime: audio.mimetype || 'audio/ogg; codecs=opus',
  };
}

module.exports = { downloadAudioBuffer, rehydrateMediaKey, unwrapMessage };
