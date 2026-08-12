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
  // Per-message triage category for CLIENT messages (direction 'in'):
  //   'required' 🔴 | 'none' 🟢 | 'potential' 🟡 | NULL = not classified yet.
  // Filled lazily by the classifier pass (lib/message-classifier). NULL is a
  // retry state, so a message the AI couldn't reach during an outage is picked
  // up next pass. Response-time metrics count ONLY 'required'.
  await p.query(`ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS client_category TEXT;`);
  await p.query(
    `CREATE INDEX IF NOT EXISTS idx_pj_unclassified
       ON processing_jobs (created_at)
       WHERE direction = 'in' AND client_category IS NULL;`
  );
  // Manual "handled" dismissals for the unanswered list. A chat is dismissed at a
  // point in time; the detector then hides it as long as no NEWER client message
  // has arrived (i.e. dismissed_at >= the latest client message). If the client
  // writes again after being dismissed, the chat reappears automatically. This is
  // how a chat answered DURING a WhatsApp outage (reply never captured) gets
  // cleared without any DB surgery.
  await p.query(`
    CREATE TABLE IF NOT EXISTS unanswered_dismissals (
      chat_jid TEXT PRIMARY KEY,
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_by TEXT
    );
  `);
  ensured = true;
}

// Client messages awaiting triage classification (direction 'in', not from a
// staff phone, client_category still NULL). Returns id + encrypted payload for
// the caller to decrypt and classify. Oldest first so a backlog drains in order.
async function listUnclassifiedInbound({ limit = 50, staffPhones = [] } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const staff = Array.isArray(staffPhones) ? staffPhones.filter(Boolean) : [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const r = await p.query(
    `SELECT pj.id, pj.payload_encrypted
     FROM processing_jobs pj
     WHERE pj.source = 'whatsapp' AND pj.direction = 'in' AND pj.client_category IS NULL
       AND (pj.sender_phone IS NULL OR pj.sender_phone <> ALL($1::text[]))
     ORDER BY pj.created_at ASC
     LIMIT $2`,
    [staff, lim]
  );
  return r.rows;
}

// Store one message's triage category. Only valid categories are written.
async function setMessageCategory(id, category) {
  const p = getPool();
  if (!p || !id) return;
  if (!['required', 'none', 'potential'].includes(category)) return;
  await p.query(`UPDATE processing_jobs SET client_category = $2 WHERE id = $1`, [id, category]);
}

// Mark a chat "handled" now (manual dismiss). Idempotent — re-dismissing just
// bumps the timestamp, which also re-hides a chat that reappeared and was
// handled again.
async function dismissChat(chatJid, byEmail) {
  await ensureTables();
  const p = getPool();
  if (!p || !chatJid) return false;
  await p.query(
    `INSERT INTO unanswered_dismissals (chat_jid, dismissed_at, dismissed_by)
     VALUES ($1, now(), $2)
     ON CONFLICT (chat_jid) DO UPDATE SET dismissed_at = now(), dismissed_by = EXCLUDED.dismissed_by`,
    [chatJid, byEmail || null]
  );
  console.log(`[unanswered/dismiss] "${chatJid}" marked handled by ${byEmail || 'unknown'}`);
  return true;
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

// --- Unanswered-chat detection (deterministic; no processor / Dropbox / AI) --
//
// A chat is "unanswered" when the client has written one or more messages that
// the firm has NOT replied to yet. We look at the whole UNANSWERED BLOCK — every
// client message that came AFTER the firm's last reply (all of them if the firm
// never replied) — rather than only the single last message. This matters for
// two reasons Shira asked for:
//
//   1. Waiting time = the LONGEST-waiting message. If a client asked something
//      5h ago and then sent "תודה" 10m ago, they've still been waiting 5h — so
//      hoursWaiting is measured from the OLDEST unanswered message in the block,
//      not the last one.
//   2. "Question then thanks". The AI needs-reply check sees the WHOLE block
//      (question + thanks), so a real question isn't hidden just because the
//      most recent line happens to be an acknowledgement.
//
// Runs over the plaintext columns of processing_jobs (chat_jid, direction,
// created_at). The encrypted body is touched only for the unanswered block's
// messages (capped), to build the text handed to the needs-reply check. Chat
// labels come from whatsapp_groups; client name from wa_contacts.
//
// NOTE on time: created_at is INGEST time, not the WhatsApp send-time (which is
// only inside the encrypted payload). For live traffic these are ~equal; a
// message redelivered after a reconnect gap ('append') can carry a later
// created_at, which would only delay a flag, never invent one.
async function listUnansweredChats({ hours = 3, staffPhones = [] } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  // NOTE: use Number.isFinite, NOT `Number(hours) || 3` — the latter turns a
  // legitimate 0 (falsy!) into 3, which silently ignored ?hours=0.
  const hn = Number(hours);
  const h = Math.min(Math.max(Number.isFinite(hn) ? hn : 3, 0), 24 * 30); // clamp 0..30d; 0 is kept
  const staff = Array.isArray(staffPhones) ? staffPhones.filter(Boolean) : [];

  // VERBOSE DIAGNOSTIC MODE:
  // Pull EVERY chat that has at least one client message, together with (a) when
  // the client last wrote, (b) when the firm last wrote (LAWLY 'out' OR any staff
  // phone), and (c) the whole UNANSWERED BLOCK — all client messages after the
  // firm's last reply, with the oldest one's timestamp driving the wait time.
  // Then we classify and LOG each chat with the reason it was kept or dropped —
  // so it's always visible in the logs "why it took these, and from where".
  // "Firm side" = direction='out' OR sender_phone in the staff directory. A chat
  // is unanswered only when there is at least one client message the firm hasn't
  // replied to, and the oldest such message is older than N hours.
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
     -- Every client message the firm has NOT replied to (after last_firm_at, or
     -- all of them if the firm never replied). This is the "unanswered block".
     block AS (
       SELECT pj.chat_jid, pj.created_at, pj.payload_encrypted, pj.contact_id,
              pj.is_group, pj.sender_phone
       FROM processing_jobs pj
       JOIN per_chat pc ON pc.chat_jid = pj.chat_jid
       WHERE pj.source = 'whatsapp' AND pj.direction = 'in' AND pj.chat_jid IS NOT NULL
         AND (pj.sender_phone IS NULL OR pj.sender_phone NOT IN (SELECT phone9 FROM staff))
         AND (pc.last_firm_at IS NULL OR pj.created_at > pc.last_firm_at)
     ),
     block_agg AS (
       SELECT chat_jid,
              MIN(created_at) AS first_unanswered_at,   -- oldest waiting message
              MAX(created_at) AS last_unanswered_at,
              COUNT(*)        AS msg_count,
              bool_or(is_group) AS is_group,
              -- oldest-first, capped, so the block reads in order for the AI
              (array_agg(payload_encrypted ORDER BY created_at ASC))[1:25] AS payloads,
              (array_agg(sender_phone ORDER BY created_at DESC))[1] AS last_client_phone,
              (array_agg(contact_id ORDER BY created_at DESC) FILTER (WHERE contact_id IS NOT NULL))[1] AS contact_id
       FROM block
       GROUP BY chat_jid
     )
     SELECT pc.chat_jid,
            pc.last_client_at,
            pc.last_firm_at,
            ba.first_unanswered_at,
            ba.last_unanswered_at,
            ba.msg_count,
            ba.payloads,
            ba.is_group,
            ba.last_client_phone,
            ROUND(EXTRACT(EPOCH FROM (now() - ba.first_unanswered_at)) / 3600.0, 1) AS hours_waiting,
            g.name AS group_name,
            g.participant_phones,
            c.monday_client_name,
            c.display_name,
            dz.dismissed_at,
            g.responsible_email
     FROM per_chat pc
     LEFT JOIN block_agg ba ON ba.chat_jid = pc.chat_jid
     LEFT JOIN whatsapp_groups g ON g.provider_group_jid = pc.chat_jid AND g.removed_at IS NULL
     LEFT JOIN wa_contacts c ON c.id = ba.contact_id
     LEFT JOIN unanswered_dismissals dz ON dz.chat_jid = pc.chat_jid
     WHERE pc.last_client_at IS NOT NULL
     ORDER BY pc.last_client_at DESC`,
    [staff]
  );

  const out = [];
  for (const row of r.rows) {
    const label = row.group_name || row.monday_client_name || row.display_name || row.chat_jid;
    // No unanswered block => the firm's last message came after every client
    // message (or there are none) => nothing awaiting a reply.
    const hasBlock = row.first_unanswered_at != null;
    // Wait time is measured from the OLDEST unanswered message in the block.
    const waited = hasBlock && row.hours_waiting != null ? Number(row.hours_waiting) : null;
    const tooRecent = waited != null && waited < h;
    const msgCount = row.msg_count != null ? Number(row.msg_count) : 0;
    // Manually dismissed AND no newer client message since the dismissal.
    const dismissedAt = row.dismissed_at ? new Date(row.dismissed_at) : null;
    const dismissed = !!(dismissedAt && row.last_client_at && dismissedAt >= new Date(row.last_client_at));

    // Classify + LOG the reason for every chat that has a client message.
    let decision;
    if (!hasBlock) decision = `SKIP (firm replied after — firm last wrote ${row.last_firm_at || 'n/a'})`;
    else if (dismissed) decision = `SKIP (marked handled at ${row.dismissed_at}, no newer client msg)`;
    else if (tooRecent) decision = `SKIP (too recent — oldest unanswered waited ${waited}h < threshold ${h}h)`;
    else decision = `TAKE (${msgCount} unanswered client msg(s), oldest waited ${waited}h, no firm reply after)`;
    console.log(`[unanswered/why] "${label}" | oldestUnanswered=${row.first_unanswered_at || 'none'} (${row.last_client_phone || 'lid/unknown'}) | lastClient=${row.last_client_at} | lastFirm=${row.last_firm_at || 'never'} | block=${msgCount} | waited=${waited}h -> ${decision}`);

    if (!hasBlock || tooRecent || dismissed) continue;

    // Decrypt the block's messages (oldest first) so the AI needs-reply step can
    // read the WHOLE conversation since the last firm reply — not just the last
    // line. Never logged. On failure, that message contributes empty text.
    const payloads = Array.isArray(row.payloads) ? row.payloads : [];
    const parts = [];
    for (const pe of payloads) {
      try {
        const json = enc.decrypt(pe || '');
        const msg = json ? JSON.parse(json) : null;
        const t = textPreview(msg && msg.message) || '';
        if (t) parts.push(t);
      } catch (_) { /* skip this message's text */ }
    }
    const blockText = parts.join('\n');
    // Keep lastText as the most recent line too (debugging / back-compat).
    const lastText = parts.length ? parts[parts.length - 1] : '';

    out.push({
      chat_jid: row.chat_jid,
      isGroup: row.is_group,
      groupName: row.group_name || null,
      label,
      clientName: row.monday_client_name || row.display_name || null,
      hoursWaiting: waited,               // measured from the OLDEST unanswered msg
      lastInboundAt: row.last_client_at,
      firstUnansweredAt: row.first_unanswered_at,
      unansweredCount: msgCount,
      lastClientPhone: row.last_client_phone || null, // last-9 digits, for a wa.me link
      responsibleEmail: row.responsible_email == null ? null : String(row.responsible_email), // '' = resolved to default owner; null = not resolved yet
      participant_phones: Array.isArray(row.participant_phones) ? row.participant_phones : [],
      blockText,                          // WHOLE unanswered block -> AI needs-reply check
      lastText,                           // last line only (debugging)
    });
  }
  // Sort OLDEST-waiting first (longest hoursWaiting at the top) — most urgent
  // first, matching how the digest should read.
  out.sort((a, b) => (b.hoursWaiting || 0) - (a.hoursWaiting || 0));
  console.log(`[unanswered/why] ${out.length} chat(s) TAKEN out of ${r.rows.length} chat(s) with a client message`);
  return out;
}

// Recent ingested messages for TESTING that WhatsApp capture really works.
// Read-only, no decryption: returns direction, masked sender, chat label, status
// and time so you can send a WhatsApp message and watch it land with the right
// direction. Optional `chatLike` filters by group name or jid substring.
async function listRecentJobs({ limit = 40, chatLike = null } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 200);
  const params = [];
  let filter = `WHERE pj.source = 'whatsapp'`;
  if (chatLike) {
    params.push('%' + chatLike + '%');
    filter += ` AND (g.name ILIKE $${params.length} OR pj.chat_jid ILIKE $${params.length})`;
  }
  params.push(lim);
  const r = await p.query(
    `SELECT pj.chat_jid, pj.direction, pj.sender_phone, pj.is_group, pj.status, pj.created_at,
            g.name AS group_name
     FROM processing_jobs pj
     LEFT JOIN whatsapp_groups g ON g.provider_group_jid = pj.chat_jid AND g.removed_at IS NULL
     ${filter}
     ORDER BY pj.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return r.rows.map((row) => ({
    chat: row.group_name || row.chat_jid,
    direction: row.direction,                                   // 'in' = client, 'out' = LAWLY line
    sender: row.sender_phone ? ('…' + String(row.sender_phone).slice(-4)) : null,
    isGroup: row.is_group,
    status: row.status,
    at: row.created_at,
  }));
}

// Response-time analytics for the management dashboard. Deterministic, over the
// plaintext columns only (no decryption). A "turn" is a client message that
// STARTS a wait (the previous message in that chat was from the firm, or it's the
// first in the window) — so a burst of client messages counts once. Its response
// time is the gap to the next firm message. Returns summary + a daily trend.
//   { days, totalTurns, answeredTurns, avgHours, medianHours, pctWithin3h, daily[] }
async function responseStats({ days = 30, staffPhones = [] } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return { days, totalTurns: 0, answeredTurns: 0, avgHours: null, medianHours: null, pctWithin3h: null, daily: [] };
  const staff = Array.isArray(staffPhones) ? staffPhones.filter(Boolean) : [];
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 180);
  // A turn counts toward metrics ONLY if its client message is 🔴 'required'.
  // 🟢 'none', 🟡 'potential', and NULL (not-yet-classified) turns are excluded.
  const CTE = `
    WITH staff AS (SELECT unnest($1::text[]) AS phone9),
    msgs AS (
      SELECT chat_jid, created_at, client_category,
             CASE WHEN direction = 'out' OR sender_phone IN (SELECT phone9 FROM staff)
                  THEN 'firm' ELSE 'client' END AS side
      FROM processing_jobs
      WHERE source = 'whatsapp' AND chat_jid IS NOT NULL
        AND created_at >= now() - make_interval(days => $2)
    ),
    seq AS (
      SELECT chat_jid, created_at, side, client_category,
             LAG(side) OVER (PARTITION BY chat_jid ORDER BY created_at) AS prev_side
      FROM msgs
    ),
    turns AS (
      SELECT chat_jid, created_at AS client_at
      FROM seq
      WHERE side = 'client' AND prev_side IS DISTINCT FROM 'client'
        AND client_category = 'required'
    ),
    resp AS (
      SELECT t.client_at,
             EXTRACT(EPOCH FROM (
               (SELECT MIN(m.created_at) FROM msgs m
                 WHERE m.chat_jid = t.chat_jid AND m.side = 'firm' AND m.created_at > t.client_at)
               - t.client_at)) / 3600.0 AS hours
      FROM turns t
    )`;
  const summary = await p.query(
    CTE + `
    SELECT
      (SELECT count(*) FROM turns)::int AS total_turns,
      (SELECT count(*) FROM resp WHERE hours IS NOT NULL)::int AS answered_turns,
      (SELECT round(avg(hours)::numeric, 1) FROM resp WHERE hours IS NOT NULL) AS avg_hours,
      (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 1)
         FROM resp WHERE hours IS NOT NULL) AS median_hours,
      (SELECT round(100.0 * count(*) FILTER (WHERE hours <= 3) / NULLIF(count(*), 0), 0)
         FROM resp WHERE hours IS NOT NULL) AS pct_within_3h`,
    [staff, d]
  );
  const daily = await p.query(
    CTE + `
    SELECT to_char(date_trunc('day', client_at), 'YYYY-MM-DD') AS day,
           round(avg(hours)::numeric, 1) AS avg_hours, count(*)::int AS n
    FROM resp WHERE hours IS NOT NULL
    GROUP BY 1 ORDER BY 1`,
    [staff, d]
  );
  // Category breakdown of CLIENT messages in the window (in, non-staff).
  const cats = await p.query(
    `SELECT
       count(*) FILTER (WHERE client_category = 'required')::int  AS required,
       count(*) FILTER (WHERE client_category = 'none')::int      AS none,
       count(*) FILTER (WHERE client_category = 'potential')::int AS potential,
       count(*) FILTER (WHERE client_category IS NULL)::int       AS pending
     FROM processing_jobs
     WHERE source = 'whatsapp' AND direction = 'in'
       AND (sender_phone IS NULL OR sender_phone <> ALL($1::text[]))
       AND created_at >= now() - make_interval(days => $2)`,
    [staff, d]
  );
  const s = summary.rows[0] || {};
  const cb = cats.rows[0] || {};
  return {
    days: d,
    totalTurns: s.total_turns || 0,
    answeredTurns: s.answered_turns || 0,
    avgHours: s.avg_hours != null ? Number(s.avg_hours) : null,
    medianHours: s.median_hours != null ? Number(s.median_hours) : null,
    pctWithin3h: s.pct_within_3h != null ? Number(s.pct_within_3h) : null,
    daily: daily.rows.map((r) => ({ day: r.day, avgHours: r.avg_hours != null ? Number(r.avg_hours) : null, n: r.n })),
    categories: {
      required: cb.required || 0,
      none: cb.none || 0,
      potential: cb.potential || 0,
      pending: cb.pending || 0,
    },
  };
}

module.exports = {
  ensureTables,
  listRecentJobs,
  responseStats,
  dismissChat,
  listUnclassifiedInbound,
  setMessageCategory,
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
