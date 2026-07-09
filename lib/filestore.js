// ============================================================
// lib/filestore.js — short-lived in-memory store for generated files.
//
// When the sandbox builds an .xlsx/.docx/.pdf, we download the bytes and hold
// them here just long enough for the user to click "download" (~30 min), then
// they expire. Kept in memory (not on Render's ephemeral disk, not in Neon) so
// there's no migration and no persistence of client documents beyond the session.
// Fine for a single small-firm instance; if you ever run multiple instances,
// swap this for Dropbox or object storage.
// ============================================================
const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;              // 30 minutes
const store = new Map();                     // id -> { userId, filename, mime, buffer, expires }

function put(userId, filename, mime, buffer) {
  const id = crypto.randomBytes(16).toString('hex');
  store.set(id, { userId, filename, mime, buffer, expires: Date.now() + TTL_MS });
  return id;
}

function get(id) {
  const e = store.get(id);
  if (!e) return null;
  if (Date.now() > e.expires) { store.delete(id); return null; }
  return e;
}

// Periodic cleanup so expired buffers don't linger in memory.
const timer = setInterval(() => {
  const now = Date.now();
  for (const [id, e] of store) if (now > e.expires) store.delete(id);
}, 5 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { put, get };
