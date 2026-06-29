// ============================================================
// lib/crypto.js — app-level encryption for stored chat messages.
// AES-256-GCM. The key is derived (SHA-256) from CHAT_ENC_KEY, which lives
// in Render's environment (NEVER in the database or the repo). So the
// encrypted text sits in Neon and the key sits in Render — two places.
// Stored format:  v1:<iv>:<authTag>:<ciphertext>  (all base64)
// If no key is configured, text is returned as-is (so nothing breaks),
// with a one-time warning — set CHAT_ENC_KEY to turn encryption on.
// ============================================================
const crypto = require('crypto');

const SECRET = process.env.CHAT_ENC_KEY || '';
const KEY = SECRET ? crypto.createHash('sha256').update(SECRET, 'utf8').digest() : null;

let warned = false;
function warnOnce() {
  if (!warned) { warned = true; console.warn('[CRYPTO] CHAT_ENC_KEY not set — chat messages are NOT encrypted.'); }
}

function enabled() { return !!KEY; }

function encrypt(plain) {
  if (!KEY) { warnOnce(); return String(plain == null ? '' : plain); }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain == null ? '' : plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

function decrypt(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1:')) return blob; // plaintext / legacy
  if (!KEY) return '[encrypted — key unavailable]';
  try {
    const parts = blob.split(':');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return '[unable to decrypt]';
  }
}

module.exports = { enabled, encrypt, decrypt };
