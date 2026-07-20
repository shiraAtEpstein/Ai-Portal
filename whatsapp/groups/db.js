// ============================================================
// whatsapp/groups/db.js — Postgres tables for the Baileys groups connector.
//
// Separate from whatsapp/schema.js + whatsapp/store.js, which are the
// official Cloud API (Coexistence, 1:1) pipeline — do not touch those.
//
// Two tables, self-provisioning (CREATE TABLE IF NOT EXISTS, same as
// lib/settings-store.js / lib/calendar.js — this repo has no migration
// runner):
//   whatsapp_group_accounts — one row per connected WhatsApp account
//     (Phase 1: exactly one, the dedicated SIM). Auth state (creds + signal
//     keys) stored as one encrypted JSON blob via lib/crypto.
//   whatsapp_groups         — every group the account has seen. Opt-out
//     model: is_monitored defaults true, per the operator's decision.
// ============================================================
const { getPool } = require('../../db');
const enc = require('../../lib/crypto');

let ensured = false;
async function ensureTables() {
  if (ensured) return;
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_group_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label TEXT NOT NULL,
      auth_state_encrypted TEXT,
      status TEXT NOT NULL DEFAULT 'auth_required',
      status_detail TEXT,
      last_connected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES whatsapp_group_accounts(id) ON DELETE CASCADE,
      provider_group_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      is_monitored BOOLEAN NOT NULL DEFAULT true,
      participant_count INT,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(account_id, provider_group_jid)
    );
  `);
  ensured = true;
}

// --- account (single-row for Phase 1, but written to support more later) --

// Returns the one configured account, creating it on first boot if absent.
async function getOrCreateAccount(label) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const existing = await p.query(
    `SELECT * FROM whatsapp_group_accounts ORDER BY created_at ASC LIMIT 1`
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await p.query(
    `INSERT INTO whatsapp_group_accounts (label) VALUES ($1) RETURNING *`,
    [label || 'WhatsApp groups monitor']
  );
  return created.rows[0];
}

// authState: { creds, keys } plain object (Buffers already base64-encoded by caller).
//
// Node's Buffer has a built-in toJSON() -> { type: 'Buffer', data: [...] },
// which JSON.stringify uses automatically. But some fields Baileys hands us
// (e.g. creds.routingInfo) are plain Uint8Array, not Buffer — those have no
// toJSON(), so they'd silently serialize as {"0":.., "1":..} objects with no
// type tag, survive JSON.parse as plain objects, and crash Buffer.concat()
// on the next reconnect (this was the "list[1]" noise-handshake bug). This
// replacer catches any Uint8Array (Buffer included, though toJSON already
// handled those before the replacer sees them) and tags it explicitly.
function typedArrayPreservingReplacer(_key, value) {
  if (value instanceof Uint8Array) {
    return { type: 'Buffer', data: Array.from(value) };
  }
  return value;
}

async function saveAuthState(accountId, authState) {
  await ensureTables();
  const p = getPool();
  if (!p) return;
  const encrypted = enc.encrypt(JSON.stringify(authState, typedArrayPreservingReplacer));

// Reverses Buffer's own toJSON() shape. Applies everywhere in the object
// graph (creds AND keys), not just one bucket — this was the actual bug:
// creds (noise/identity/signed-prekey Buffers) were never revived, only
// plain JSON.parse'd, so the noise handshake got {type:'Buffer',data:[..]}
// objects instead of real Buffers and crashed in Buffer.concat().
function bufferRevivingReviver(_key, value) {
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

async function loadAuthState(accountId) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT auth_state_encrypted FROM whatsapp_group_accounts WHERE id = $1`,
    [accountId]
  );
  const blob = r.rows[0] && r.rows[0].auth_state_encrypted;
  if (!blob) return null;
  try {
    return JSON.parse(enc.decrypt(blob), bufferRevivingReviver);
  } catch (e) {
    console.error('[whatsapp/groups] failed to parse decrypted auth state:', e.message);
    return null;
  }
}
  // Wipes the stored session (e.g. after the "list[1]" corruption, or a
// logged-out/unrecoverable device link) so the next connect() attempt
// starts clean with initAuthCreds() and forces a fresh QR.
async function resetAuthState(accountId) {
  await ensureTables();
  const p = getPool();
  if (!p) return;
  await p.query(
    `UPDATE whatsapp_group_accounts
     SET auth_state_encrypted = NULL, status = 'auth_required', status_detail = 'Reset — rescan QR required', updated_at = now()
     WHERE id = $1`,
    [accountId]
  );
}
async function setAccountStatus(accountId, status, detail) {
  await ensureTables();
  const p = getPool();
  if (!p) return;
  const setLastConnected = status === 'connected' ? ', last_connected_at = now()' : '';
  await p.query(
    `UPDATE whatsapp_group_accounts
     SET status = $1, status_detail = $2, updated_at = now() ${setLastConnected}
     WHERE id = $3`,
    [status, detail || null, accountId]
  );
}

async function getAccountStatus(accountId) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT id, label, status, status_detail, last_connected_at FROM whatsapp_group_accounts WHERE id = $1`,
    [accountId]
  );
  return r.rows[0] || null;
}

// --- groups -----------------------------------------------------------

async function upsertGroup(accountId, providerGroupJid, name, participantCount) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `INSERT INTO whatsapp_groups (account_id, provider_group_jid, name, participant_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, provider_group_jid)
     DO UPDATE SET name = EXCLUDED.name, participant_count = EXCLUDED.participant_count
     RETURNING *`,
    [accountId, providerGroupJid, name || providerGroupJid, participantCount || null]
  );
  return r.rows[0];
}

async function listGroups(accountId) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT * FROM whatsapp_groups WHERE account_id = $1 ORDER BY name ASC`,
    [accountId]
  );
  return r.rows;
}

module.exports = {
  ensureTables,
  getOrCreateAccount,
  saveAuthState,
  loadAuthState,
  resetAuthState,
  setAccountStatus,
  getAccountStatus,
  upsertGroup,
  listGroups,
};
