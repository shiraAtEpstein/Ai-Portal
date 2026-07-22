// ============================================================
// whatsapp/ingest/db.js — Postgres tables for WhatsApp message ingestion.
// Self-provisioning, same idiom as whatsapp/groups/db.js. No-ops without a pool.
// Raw message payload encrypted at rest via lib/crypto.
// ============================================================
const { getPool } = require('../../db');
const enc = require('../../lib/crypto');

let ensured = false;
async function ensureTables() {
  if (ensured) return;
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_normalized TEXT UNIQUE NOT NULL,
      phone_raw TEXT,
      display_name TEXT,
      monday_item_id TEXT,
      monday_client_name TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'unresolved',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS processing_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source TEXT NOT NULL DEFAULT 'whatsapp',
      source_item_id TEXT NOT NULL,
      chat_jid TEXT,
      is_group BOOLEAN DEFAULT false,
      direction TEXT,
      sender_phone TEXT,
      contact_id UUID REFERENCES wa_contacts(id),
      payload_encrypted TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      processed_at TIMESTAMPTZ,
      UNIQUE (source, source_item_id)
    );
  `);
  // The Phase 4 background processor will poll `WHERE status = 'pending'`.
  // Add the partial index now (one line, zero risk) so that scan stays fast
  // as the table grows, and so we don't need a migration later.
  await p.query(
    `CREATE INDEX IF NOT EXISTS idx_processing_jobs_pending
       ON processing_jobs (created_at) WHERE status = 'pending';`
  );
  ensured = true;
}

// Baileys message objects can carry protobuf Long / native BigInt values
// (e.g. messageTimestamp). Plain JSON.stringify throws on BigInt, which used
// to drop the whole raw payload to '{}'. Coerce BigInt to string so the raw
// message — our audit trail and re-enrichment source — is preserved intact.
function safeStringifyPayload(obj) {
  return JSON.stringify(obj == null ? {} : obj, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
}

async function upsertContact({
  phone_normalized,
  phone_raw,
  display_name,
  monday_item_id,
  monday_client_name,
  resolution_status,
} = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  if (!phone_normalized) return null;
  const r = await p.query(
    `INSERT INTO wa_contacts
       (phone_normalized, phone_raw, display_name, monday_item_id, monday_client_name, resolution_status)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'unresolved'))
     ON CONFLICT (phone_normalized) DO UPDATE SET
       phone_raw          = COALESCE(EXCLUDED.phone_raw, wa_contacts.phone_raw),
       display_name       = COALESCE(EXCLUDED.display_name, wa_contacts.display_name),
       monday_item_id     = COALESCE(EXCLUDED.monday_item_id, wa_contacts.monday_item_id),
       monday_client_name = COALESCE(EXCLUDED.monday_client_name, wa_contacts.monday_client_name),
       resolution_status  = COALESCE(EXCLUDED.resolution_status, wa_contacts.resolution_status),
       updated_at         = now()
     RETURNING *`,
    [
      phone_normalized,
      phone_raw || null,
      display_name || null,
      monday_item_id || null,
      monday_client_name || null,
      resolution_status || null,
    ]
  );
  return r.rows[0] || null;
}

async function getContactByPhone(phone_normalized) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  if (!phone_normalized) return null;
  const r = await p.query(
    `SELECT * FROM wa_contacts WHERE phone_normalized = $1`,
    [phone_normalized]
  );
  return r.rows[0] || null;
}

async function enqueueJob({
  source_item_id,
  chat_jid,
  is_group,
  direction,
  sender_phone,
  contact_id,
  payloadObj,
} = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  if (!source_item_id) return null;
  let payloadEncrypted = null;
  try {
    payloadEncrypted = enc.encrypt(safeStringifyPayload(payloadObj));
  } catch (e) {
    console.warn('[whatsapp/ingest] could not serialize raw payload, storing empty:', e.message);
    payloadEncrypted = enc.encrypt('{}');
  }
  const r = await p.query(
    `INSERT INTO processing_jobs
       (source, source_item_id, chat_jid, is_group, direction, sender_phone, contact_id, payload_encrypted)
     VALUES ('whatsapp', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source, source_item_id) DO NOTHING
     RETURNING id`,
    [
      source_item_id,
      chat_jid || null,
      !!is_group,
      direction || null,
      sender_phone || null,
      contact_id || null,
      payloadEncrypted,
    ]
  );
  return (r.rows[0] && r.rows[0].id) || null;
}

module.exports = {
  ensureTables,
  upsertContact,
  getContactByPhone,
  enqueueJob,
};
