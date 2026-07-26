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

  // --- Phase 4: deals (the core business object) ---
  // One row per matter. Holds the running AI summary. `needs_update` is set
  // true when a new message lands on the deal, and the background processor
  // clears it after refreshing the summary.
  await p.query(`
    CREATE TABLE IF NOT EXISTS deals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monday_board_id TEXT NOT NULL,
      monday_item_id TEXT NOT NULL,
      name TEXT,
      status TEXT,
      ai_summary TEXT,
      needs_update BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (monday_board_id, monday_item_id)
    );
  `);
  await p.query(
    `CREATE INDEX IF NOT EXISTS idx_deals_needs_update
       ON deals (updated_at) WHERE needs_update = true;`
  );
  // Link a message and a contact to their deal (nullable — unresolved or
  // ambiguous senders stay null and land in the review queue).
  await p.query(`ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS deal_id UUID;`);
  await p.query(`ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS deal_id UUID;`);
  // Phase 4B: structured fields the processor extracts alongside the prose
  // summary, so cross-deal questions ("most urgent", "waiting on documents",
  // "overdue payments") are DB queries, not a scan of every summary.
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_action TEXT;`);
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS blocking_on TEXT;`);
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_deadline DATE;`);
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMPTZ;`);
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
  deal_id,
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
       (source, source_item_id, chat_jid, is_group, direction, sender_phone, contact_id, deal_id, payload_encrypted)
     VALUES ('whatsapp', $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source, source_item_id) DO NOTHING
     RETURNING id`,
    [
      source_item_id,
      chat_jid || null,
      !!is_group,
      direction || null,
      sender_phone || null,
      contact_id || null,
      deal_id || null,
      payloadEncrypted,
    ]
  );
  return (r.rows[0] && r.rows[0].id) || null;
}

// --- Phase 4: deal helpers -------------------------------------------------

// Upsert a deal discovered from Monday. Keyed by (board, item) so re-seeing the
// same deal doesn't duplicate it. Returns the row (with our internal id).
async function upsertDeal({ monday_board_id, monday_item_id, name, status } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  if (!monday_board_id || !monday_item_id) return null;
  const r = await p.query(
    `INSERT INTO deals (monday_board_id, monday_item_id, name, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (monday_board_id, monday_item_id) DO UPDATE SET
       name   = COALESCE(EXCLUDED.name, deals.name),
       status = COALESCE(EXCLUDED.status, deals.status),
       updated_at = now()
     RETURNING *`,
    [String(monday_board_id), String(monday_item_id), name || null, status || null]
  );
  return r.rows[0] || null;
}

// Remember the deal a contact belongs to, so we resolve it once per contact
// rather than on every message.
async function setContactDeal(contactId, dealId) {
  await ensureTables();
  const p = getPool();
  if (!p || !contactId || !dealId) return;
  await p.query(`UPDATE wa_contacts SET deal_id = $2, updated_at = now() WHERE id = $1`, [contactId, dealId]);
}

// Flag a deal as having new unprocessed messages — the background processor
// picks these up.
async function markDealNeedsUpdate(dealId) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return;
  await p.query(`UPDATE deals SET needs_update = true, updated_at = now() WHERE id = $1`, [dealId]);
}

// --- Phase 4B: processor reads/writes -------------------------------------

// Deals with new unprocessed messages, oldest-touched first.
async function listDealsNeedingUpdate(limit = 50) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const r = await p.query(
    `SELECT id FROM deals WHERE needs_update = true ORDER BY updated_at ASC LIMIT $1`,
    [lim]
  );
  return r.rows.map((row) => row.id);
}

async function getDeal(dealId) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return null;
  const r = await p.query(`SELECT * FROM deals WHERE id = $1`, [dealId]);
  return r.rows[0] || null;
}

// Does this deal have any pending messages? (drives on-demand freshness)
async function dealHasPending(dealId) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return false;
  const r = await p.query(
    `SELECT 1 FROM processing_jobs WHERE deal_id = $1 AND status = 'pending' LIMIT 1`,
    [dealId]
  );
  return !!r.rows[0];
}

// The pending messages for a deal, oldest first, with the sender's client name.
// payload_encrypted is returned for the caller to decrypt (never logged).
async function getPendingJobsForDeal(dealId, limit = 200) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const r = await p.query(
    `SELECT pj.id, pj.direction, pj.sender_phone, pj.is_group, pj.created_at, pj.payload_encrypted,
            c.monday_client_name, c.display_name
     FROM processing_jobs pj
     LEFT JOIN wa_contacts c ON c.id = pj.contact_id
     WHERE pj.deal_id = $1 AND pj.status = 'pending'
     ORDER BY pj.created_at ASC
     LIMIT $2`,
    [dealId, lim]
  );
  return r.rows;
}

// Apply a validated processor result in one transaction: update the deal's
// summary + structured fields, mark the processed jobs done, clear needs_update.
// `fields` is already validated by the caller. Returns true on success.
async function applyDealUpdate(dealId, fields, jobIds) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return false;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE deals SET
         ai_summary    = $2,
         status        = COALESCE($3, status),
         next_action   = $4,
         blocking_on   = $5,
         next_deadline = $6,
         needs_update  = false,
         last_processed_at = now(),
         updated_at    = now()
       WHERE id = $1`,
      [dealId, fields.summary || null, fields.status || null, fields.next_action || null,
       fields.blocking_on || null, fields.next_deadline || null]
    );
    if (Array.isArray(jobIds) && jobIds.length) {
      await client.query(
        `UPDATE processing_jobs SET status = 'done', processed_at = now()
         WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
        [jobIds]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[whatsapp/processor] applyDealUpdate failed:', e.message);
    return false;
  } finally {
    client.release();
  }
}

// Read-only snapshot for the admin health endpoint: how many jobs (by status),
// how contacts resolved, and the most recent contacts. No message content —
// that stays encrypted in payload_encrypted.
async function stats({ recentLimit = 10 } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return { available: false };
  const jobsByStatus = {};
  const jb = await p.query(`SELECT status, count(*)::int n FROM processing_jobs GROUP BY status`);
  for (const r of jb.rows) jobsByStatus[r.status] = r.n;
  const totalJobs = Object.values(jobsByStatus).reduce((a, b) => a + b, 0);

  const contactsByResolution = {};
  const cb = await p.query(`SELECT resolution_status, count(*)::int n FROM wa_contacts GROUP BY resolution_status`);
  for (const r of cb.rows) contactsByResolution[r.resolution_status] = r.n;

  const recent = await p.query(
    `SELECT phone_normalized, display_name, monday_client_name, resolution_status, created_at
     FROM wa_contacts ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(parseInt(recentLimit, 10) || 10, 1), 100)]
  );

  return {
    available: true,
    totalJobs,
    jobsByStatus,
    contactsByResolution,
    recentContacts: recent.rows,
  };
}

module.exports = {
  ensureTables,
  upsertContact,
  getContactByPhone,
  enqueueJob,
  upsertDeal,
  setContactDeal,
  markDealNeedsUpdate,
  listDealsNeedingUpdate,
  getDeal,
  dealHasPending,
  getPendingJobsForDeal,
  applyDealUpdate,
  stats,
};
