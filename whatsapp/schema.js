/**
 * Canonical Message schema — the heart of the whole design.
 * -------------------------------------------------------------
 * Email, WhatsApp (Coexistence), the group export, and (later) Baileys all
 * normalize into THIS one shape. Build this boundary well and the ingestion
 * source becomes swappable — the enrichment/daily-agent side never has to
 * know or care where a message came from.
 *
 * Preserve Hebrew EXACTLY. No transliteration, no cleanup. (Firm rule.)
 */

/**
 * @typedef {Object} Message
 * @property {string}  id          Stable unique id. Used for dedupe.
 * @property {string}  channel     'whatsapp' | 'email' | 'whatsapp_group'
 * @property {string}  source      'inbound' | 'history' | 'echo'
 * @property {string}  conversationId  Groups messages into a thread (the chat).
 * @property {string}  fromId      Sender's phone / address (raw).
 * @property {string=} fromName    Display name if WhatsApp provided one.
 * @property {'in'|'out'} direction 'in' = from client, 'out' = from staff.
 * @property {number}  timestamp   Unix seconds, when the message was sent.
 * @property {string}  type        'text' | 'image' | 'document' | 'audio' | ...
 * @property {string=} text        Message body, exact. Empty for pure media.
 * @property {Object=} media       { id, mimeType, filename } — URLs expire ~5m,
 *                                  so a downstream fetcher grabs the bytes fast.
 * @property {Object}  raw         The untouched original payload. Never discard.
 */

/**
 * Normalize a single WhatsApp Cloud API message object into a Message.
 *
 * @param {Object} msg    one item from value.messages / history / message_echoes
 * @param {Object} value  the surrounding webhook `value` (has metadata, contacts)
 * @param {Object} opts   { source: 'inbound' | 'history' | 'echo' }
 * @returns {Message}
 */
function normalize(msg, value, opts = {}) {
  const source = opts.source || 'inbound';

  // Echoes are messages the staff member SENT, so direction is outbound.
  // Everything else arriving here is inbound from the other party.
  const direction = source === 'echo' ? 'out' : 'in';

  // Best-effort display name from the contacts array (inbound only).
  let fromName;
  const contacts = value.contacts || [];
  if (contacts.length && contacts[0].profile) {
    fromName = contacts[0].profile.name;
  }

  const businessNumber =
    (value.metadata && value.metadata.display_phone_number) || undefined;

  // The "conversation" is the pairing of the business number and the other
  // party. For a 1-on-1 chat that's simply the other person's number.
  const other = direction === 'out' ? msg.to : msg.from;
  const conversationId = [businessNumber, other].filter(Boolean).join('::');

  return {
    id: msg.id,
    channel: 'whatsapp',
    source,
    conversationId,
    fromId: msg.from || businessNumber,
    fromName,
    direction,
    timestamp: Number(msg.timestamp) || Math.floor(Date.now() / 1000),
    type: msg.type,
    text: extractText(msg),
    media: extractMedia(msg),
    raw: msg, // keep the original, always
  };
}

function extractText(msg) {
  if (msg.type === 'text' && msg.text) return msg.text.body || '';
  // Captions on media count as text content too.
  if (msg[msg.type] && msg[msg.type].caption) return msg[msg.type].caption;
  return '';
}

function extractMedia(msg) {
  const mediaTypes = ['image', 'document', 'audio', 'video', 'sticker'];
  if (!mediaTypes.includes(msg.type)) return undefined;
  const m = msg[msg.type] || {};
  return {
    id: m.id,
    mimeType: m.mime_type,
    filename: m.filename, // present for documents
  };
}

module.exports = { normalize };
