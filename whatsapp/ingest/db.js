// ============================================================
// whatsapp/ingest/db.js — Postgres tables for WhatsApp message ingestion.
// Self-provisioning, same idiom as whatsapp/groups/db.js. No-ops without a pool.
// Raw message payload encrypted at rest via lib/crypto.
// ============================================================
const { getPool } = require('../../db');
const enc = require('../../lib/crypto');
const { textPreview } = require('./phone');

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
  // "Awaiting reply" — deterministic (no AI): a client message that hasn't been
  // answered by the firm. Tracked from message direction + timestamps so a
  // client never goes silently unanswered.
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS awaiting_reply BOOLEAN NOT NULL DEFAULT false;`);
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;`);
  await p.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMPTZ;`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_deals_awaiting ON deals (last_inbound_at) WHERE awaiting_reply = true;`);
  // Phase 5 (brought forward): discrete extracted items per deal — the
  // specifics that must not be lost to summary compression. category is a
  // controlled label so they're easy to search/filter.
  await p.query(`
    CREATE TABLE IF NOT EXISTS deal_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      category TEXT NOT NULL,           -- task | payment | document | date | note
      text TEXT NOT NULL,
      party TEXT,                       -- firm | client | null
      status TEXT NOT NULL DEFAULT 'open',  -- open | done
      due_date DATE,
      source_job_id UUID,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_deal_items_deal ON deal_items (deal_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_deal_items_open ON deal_items (category, due_date) WHERE status = 'open';`);
  // `needs`: does the FIRM have to act, and how — response | action | none.
  // Drives attention/awaiting_reply. (See lawly-status-criteria.md.)
  await p.query(`ALTER TABLE deal_items ADD COLUMN IF NOT EXISTS needs TEXT;`);
  ensured = true;
}

const ITEM_NEEDS = ['response', 'action', 'none'];

// Allowed item categories (keep in sync with the processor prompt).
const ITEM_CATEGORIES = ['task', 'payment', 'document', 'date', 'note'];

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

// Record a message's send-time on the deal (last inbound/outbound). This is now
// just real-time METADATA ("client last wrote 3h ago"); `awaiting_reply` itself
// is derived from an open response-needed item at processing time (see
// applyTaskUpdate), per the revised criteria. Order-safe via GREATEST.
async function noteDealActivity(dealId, direction, tsSeconds) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId || (direction !== 'in' && direction !== 'out')) return;
  const col = direction === 'in' ? 'last_inbound_at' : 'last_outbound_at';
  await p.query(
    `UPDATE deals SET ${col} = GREATEST(COALESCE(${col}, to_timestamp(0)),
       to_timestamp(COALESCE($2::double precision, extract(epoch from now())))) WHERE id = $1`,
    [dealId, tsSeconds == null ? null : Number(tsSeconds)]
  );
}

// The "needs attention" set: deals awaiting a reply (with how long), and open
// items the FIRM owes. Powers the in-portal panel and the email digest.
async function listAttention() {
  await ensureTables();
  const p = getPool();
  if (!p) return { awaitingReply: [], openFirmItems: [] };
  const awaiting = await p.query(
    `SELECT id, name, monday_board_id, monday_item_id, last_inbound_at, last_outbound_at,
            round(EXTRACT(EPOCH FROM (now() - last_inbound_at)) / 3600.0, 1) AS hours_waiting
     FROM deals WHERE awaiting_reply = true ORDER BY last_inbound_at ASC`
  );
  const items = await p.query(
    `SELECT i.id, i.category, i.needs, i.text, i.party, i.due_date, d.id AS deal_id, d.name AS deal_name
     FROM deal_items i JOIN deals d ON d.id = i.deal_id
     WHERE i.status = 'open' AND i.party = 'firm' AND i.needs IN ('response','action')
     ORDER BY (i.needs = 'response') DESC, i.due_date NULLS LAST, i.created_at ASC`
  );
  return { awaitingReply: awaiting.rows, openFirmItems: items.rows };
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

// The deal's current OPEN items (with ids) — handed to the task agent so it can
// see what exists, close finished ones by id, and add only genuinely new ones.
async function getOpenItemsForDeal(dealId) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return [];
  const r = await p.query(
    `SELECT id, category, needs, text, party, due_date FROM deal_items
     WHERE deal_id = $1 AND status = 'open' ORDER BY created_at ASC`,
    [dealId]
  );
  return r.rows;
}

// Apply the task agent's validated result in one transaction (id-based close/add
// model): CLOSE the named open items (mark done — kept as history), ADD the new
// ones, mark the processed jobs done, recompute `awaiting_reply` from whether an
// open response-needed item remains, and clear needs_update. Returns true on ok.
// `result` = { closeIds: [uuid], addItems: [{category, needs, text, party, due_date, source_job_id}] }
async function applyTaskUpdate(dealId, result, jobIds) {
  await ensureTables();
  const p = getPool();
  if (!p || !dealId) return false;
  const closeIds = Array.isArray(result && result.closeIds) ? result.closeIds : [];
  const addItems = Array.isArray(result && result.addItems) ? result.addItems : [];
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (closeIds.length) {
      await client.query(
        `UPDATE deal_items SET status = 'done', updated_at = now()
         WHERE deal_id = $1 AND status = 'open' AND id = ANY($2::uuid[])`,
        [dealId, closeIds]
      );
    }
    for (const it of addItems) {
      await client.query(
        `INSERT INTO deal_items (deal_id, category, needs, text, party, status, due_date, source_job_id)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)`,
        [dealId, it.category, it.needs || null, it.text, it.party || null, it.due_date || null, it.source_job_id || null]
      );
    }
    if (Array.isArray(jobIds) && jobIds.length) {
      await client.query(
        `UPDATE processing_jobs SET status = 'done', processed_at = now()
         WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
        [jobIds]
      );
    }
    // awaiting_reply = the deal still has an open response-needed item on the firm.
    await client.query(
      `UPDATE deals SET
         awaiting_reply = EXISTS (
           SELECT 1 FROM deal_items
           WHERE deal_id = $1 AND status = 'open' AND needs = 'response' AND party = 'firm'
         ),
         needs_update = false,
         last_processed_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [dealId]
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[whatsapp/processor] applyTaskUpdate failed:', e.message);
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

// --- Unanswered-chat detection (deterministic query; AI decides needs-reply) --
// Per chat: last message is from a CLIENT (inbound, and not a staff phone) with
// no firm-side message (LAWLY bot OR a staff phone) after it, older than N hours.
// Runs over the plaintext columns of processing_jobs; the encrypted body of the
// ONE last-inbound message is decrypted only to return its text — the "needs a
// reply?" call is made by AI in the digest builder.
async function listUnansweredChats({ hours = 3, staffPhones = [] } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const h = Math.min(Math.max(Number(hours) || 3, 0), 24 * 30); // clamp 0..30d
  const staff = Array.isArray(staffPhones) ? staffPhones.filter(Boolean) : [];

  console.log(`[unanswered/staff] scan using ${staff.length} staff phone(s): ${staff.join(', ') || '(none)'}`);

  const r = await p.query(
    `WITH staff AS (SELECT unnest($1::text[]) AS phone9),
     per_chat AS (
       SELECT chat_jid,
              MAX(created_at) FILTER (
                WHERE direction = 'in'
                  AND (sender_phone IS NULL OR sender_phone NOT IN (SELECT phone9 FROM staff))
              ) AS last_client_at,
              MAX(created_at) FILTER (
                WHERE direction = 'out' OR sender_phone IN (SELECT phone9 FROM staff)
              ) AS last_firm_at
       FROM processing_jobs
       WHERE source = 'whatsapp' AND chat_jid IS NOT NULL
       GROUP BY chat_jid
     ),
     last_client_msg AS (
       SELECT DISTINCT ON (chat_jid)
              chat_jid, created_at, payload_encrypted, contact_id, is_group, sender_phone
       FROM processing_jobs
       WHERE source = 'whatsapp' AND direction = 'in' AND chat_jid IS NOT NULL
         AND (sender_phone IS NULL OR sender_phone NOT IN (SELECT phone9 FROM staff))
       ORDER BY chat_jid, created_at DESC
     )
     SELECT pc.chat_jid,
            pc.last_client_at,
            pc.last_firm_at,
            lcm.payload_encrypted,
            lcm.is_group,
            lcm.sender_phone AS last_client_phone,
            ROUND(EXTRACT(EPOCH FROM (now() - pc.last_client_at)) / 3600.0, 1) AS hours_waiting,
            g.name AS group_name,
            g.participant_phones,
            c.monday_client_name,
            c.display_name
     FROM per_chat pc
     JOIN last_client_msg lcm ON lcm.chat_jid = pc.chat_jid
     LEFT JOIN whatsapp_groups g ON g.provider_group_jid = pc.chat_jid AND g.removed_at IS NULL
     LEFT JOIN wa_contacts c ON c.id = lcm.contact_id
     WHERE pc.last_client_at IS NOT NULL
     ORDER BY pc.last_client_at DESC`,
    [staff]
  );

  const out = [];
  for (const row of r.rows) {
    const label = row.group_name || row.monday_client_name || row.display_name || row.chat_jid;
    const waited = row.hours_waiting != null ? Number(row.hours_waiting) : null;
    const firmAfter = row.last_firm_at && row.last_client_at && new Date(row.last_firm_at) >= new Date(row.last_client_at);
    const tooRecent = waited != null && waited < h;

    let decision;
    if (firmAfter) decision = `SKIP (firm replied after — firm last wrote ${row.last_firm_at})`;
    else if (tooRecent) decision = `SKIP (too recent — waited ${waited}h < threshold ${h}h)`;
    else decision = 'TAKE (client wrote last, no firm reply, past threshold)';
    console.log(`[unanswered/why] "${label}" | lastClient=${row.last_client_at} (${row.last_client_phone || 'lid/unknown'}) | lastFirm=${row.last_firm_at || 'never'} | waited=${waited}h -> ${decision}`);

    if (firmAfter || tooRecent) continue;

    let lastText = '';
    try {
      const json = enc.decrypt(row.payload_encrypted || '');
      const msg = json ? JSON.parse(json) : null;
      lastText = textPreview(msg && msg.message) || '';
    } catch (_) {
      lastText = '';
    }

    out.push({
      chat_jid: row.chat_jid,
      isGroup: row.is_group,
      groupName: row.group_name || null,
      label,
      clientName: row.monday_client_name || row.display_name || null,
      hoursWaiting: waited,
      lastInboundAt: row.last_client_at,
      participant_phones: Array.isArray(row.participant_phones) ? row.participant_phones : [],
      lastText,
    });
  }
  console.log(`[unanswered/why] ${out.length} chat(s) TAKEN out of ${r.rows.length} chat(s) with a client message`);
  return out;
}
module.exports = {
  ensureTables,
  upsertContact,
  getContactByPhone,
  enqueueJob,
  upsertDeal,
  setContactDeal,
  markDealNeedsUpdate,
  noteDealActivity,
  listAttention,
  listDealsNeedingUpdate,
  getDeal,
  dealHasPending,
  getPendingJobsForDeal,
  getOpenItemsForDeal,
  applyTaskUpdate,
  listUnansweredChats,
  ITEM_CATEGORIES,
  ITEM_NEEDS,
  stats,
};
