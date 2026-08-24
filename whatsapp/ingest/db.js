// ============================================================
// whatsapp/ingest/db.js — Postgres tables for WhatsApp message ingestion.
// Self-provisioning, same idiom as whatsapp/groups/db.js. No-ops without a pool.
// Raw message payload encrypted at rest via lib/crypto.
// ============================================================
const { getPool } = require('../../db');
const enc = require('../../lib/crypto');
const { textPreview, messageKind } = require('./phone');
// Every wait in the system is measured on the firm's working clock (08:00–22:00,
// no Saturday) — see lib/business-hours.js. Wall-clock hours are still logged
// beside it in [unanswered/why], because when a number looks wrong the first
// question is always "how long has it REALLY been sitting there".
const businessHours = require('../../lib/business-hours');
// The zone the daily buckets in responseStats are cut on. Kept beside the
// working-clock import so the two can never name different places.
const TZ_SQL = businessHours.config().timezone;

// ── WHAT COUNTS AS A MESSAGE, AND FOR WHOM ─────────────────────────────────
// A 👍 arrives down the same pipe as a real message, and the two directions
// need OPPOSITE treatment — Shira's call, and she is right:
//
//   a CLIENT's 👍  is not a question. Counting it as one opened an
//                  "unanswered" wait that nobody could ever close, because
//                  there is no way to reply to a thumbs-up. That is how a chat
//                  answered at 09:00 came to read as twelve days overdue.
//
//   a STAFFER's 👍 IS an answer. When the partner thumbs-up a client's document
//                  that is him saying "seen, fine" — dropping it would leave the
//                  client's message looking unanswered when it plainly was not.
//
// So reactions are filtered by SENDER, not by kind alone.
const REACTION_KINDS = [
  'reactionMessage',           // 👍 on someone else's message (Baileys)
  'reaction',                  // the same thing from the Cloud API / history shape
];

// System records — nobody typed these, so they are neither a question nor an
// answer, whichever side they came from.
const SYSTEM_KINDS = [
  'protocolMessage',           // revokes, ephemeral-setting changes, app state
  'senderKeyDistributionMessage',
  'messageContextInfo',
];

// Kept for the metrics module and for anything that just wants "not a real
// message from a client".
const NON_MESSAGE_KINDS = REACTION_KINDS.concat(SYSTEM_KINDS);

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
  // The staff member who SENT this message, resolved at ingest by phone OR by
  // display name (recovers staff who appear as an anonymous @lid). NULL = a
  // client / non-staff sender. Drives firm-reply detection and reply-speed.
  await p.query(`ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS sender_staff_phone9 TEXT;`);
  // Cached AI triage verdict per chat, keyed by a signature of the unanswered
  // block. Lets the board reuse a chat's verdict until its content changes (a
  // new message) — so we never re-send an unchanged chat to the AI.
  await p.query(`
    CREATE TABLE IF NOT EXISTS chat_triage (
      chat_jid   TEXT PRIMARY KEY,
      sig        TEXT,
      verdict    TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
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
  // The ACTUAL WhatsApp send time (from the message's messageTimestamp), as
  // opposed to created_at which is INGEST time. Used for all wait/response
  // timing so a message redelivered late (after a reconnect) is timed from when
  // it was really sent. NULL for rows not yet backfilled -> falls back to
  // created_at via COALESCE.
  await p.query(`ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;`);
  // WHAT KIND of message this row is — 'conversation', 'audioMessage',
  // 'reactionMessage', … Filled at ingest from the payload, backfilled for
  // history by backfillMsgKind(). It exists for one reason: the payload is
  // encrypted, so SQL cannot tell a real message from a 👍, and a reaction was
  // opening an "unanswered" wait that nobody could ever close — a chat answered
  // the same morning read as twelve days overdue. NULL means "not classified
  // yet" and is treated as a real message, never dropped.
  await p.query(`ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS msg_kind TEXT;`);
  await p.query(
    `CREATE INDEX IF NOT EXISTS idx_pj_msg_kind_missing
       ON processing_jobs (created_at) WHERE msg_kind IS NULL;`
  );
  await p.query(
    `CREATE INDEX IF NOT EXISTS idx_pj_sent_at_missing
       ON processing_jobs (created_at) WHERE sent_at IS NULL;`
  );
  // Set when a message is DELETED for everyone in WhatsApp (revoke). A deleted
  // message no longer counts as unanswered and drops off the board.
  await p.query(`ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
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
  // WHY a chat was cleared: the staff-set status key from config/board-statuses.json
  // ('answered' = נענה, 'no_reply_needed' = לא דורש מענה). Rows written before this
  // column existed stay NULL, which the admin view renders as "לא ידוע".
  await p.query(`ALTER TABLE unanswered_dismissals ADD COLUMN IF NOT EXISTS reason TEXT;`);
  // Manual אחראי override, set from the control board. Deliberately a SEPARATE
  // table from whatsapp_groups.responsible_email: that column is auto-filled from
  // monday by lib/responsible.resolveAndStore() and would overwrite a person's
  // choice on the next resolve. Keeping the override here means the portal's
  // decision always wins, and monday stays READ-ONLY — we never write back to it.
  await p.query(`
    CREATE TABLE IF NOT EXISTS chat_responsible_override (
      chat_jid TEXT PRIMARY KEY,
      email    TEXT NOT NULL,
      name     TEXT,
      set_by   TEXT,
      set_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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

// Backfill sent_at (real WhatsApp send time) for existing rows that predate the
// column, by decrypting each payload and reading its messageTimestamp. Rows with
// no usable timestamp get sent_at = created_at so they're not rescanned. Bounded;
// run repeatedly until it reports 0 scanned.
async function backfillSentAt({ limit = 100 } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return { scanned: 0, filled: 0 };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  const r = await p.query(
    `SELECT id, payload_encrypted FROM processing_jobs
     WHERE source = 'whatsapp' AND sent_at IS NULL AND payload_encrypted IS NOT NULL
     ORDER BY created_at DESC LIMIT $1`,
    [lim]
  );
  let filled = 0;
  for (const row of r.rows) {
    let ts = null;
    try {
      const json = enc.decrypt(row.payload_encrypted || '');
      const msg = json ? JSON.parse(json) : null;
      const n = Number(msg && msg.messageTimestamp);
      if (Number.isFinite(n) && n > 0) ts = n;
    } catch (_) { /* unreadable -> fall back to created_at below */ }
    if (ts) {
      await p.query(
        `UPDATE processing_jobs SET sent_at = to_timestamp($2::double precision) WHERE id = $1 AND sent_at IS NULL`,
        [row.id, ts]
      );
      filled++;
    } else {
      await p.query(`UPDATE processing_jobs SET sent_at = created_at WHERE id = $1 AND sent_at IS NULL`, [row.id]);
    }
  }
  if (r.rows.length) console.log(`[sent-at-backfill] scanned ${r.rows.length}, filled ${filled} from send-time`);
  return { scanned: r.rows.length, filled };
}

// --- Triage verdict cache -------------------------------------------------
// getChatTriage(jids) -> Map<chat_jid, { sig, verdict }>. Reused so the board
// only asks the AI about chats whose content changed.
async function getChatTriage(jids) {
  const map = new Map();
  const p = getPool();
  if (!p || !Array.isArray(jids) || !jids.length) return map;
  const r = await p.query(
    `SELECT chat_jid, sig, verdict FROM chat_triage WHERE chat_jid = ANY($1::text[])`,
    [jids]
  );
  for (const row of r.rows) map.set(row.chat_jid, { sig: row.sig, verdict: row.verdict });
  return map;
}

// Store a chat's verdict keyed by the content signature it was computed from.
async function setChatTriage(chatJid, sig, verdict) {
  const p = getPool();
  if (!p || !chatJid) return;
  await p.query(
    `INSERT INTO chat_triage (chat_jid, sig, verdict, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_jid) DO UPDATE SET sig = EXCLUDED.sig, verdict = EXCLUDED.verdict, updated_at = now()`,
    [chatJid, sig || null, verdict || null]
  );
}

// Mark a message deleted (WhatsApp revoke) by its source_item_id (= key.id of
// the revoked message). It then drops out of the unanswered detection.
async function markMessageDeleted(sourceItemId) {
  const p = getPool();
  if (!p || !sourceItemId) return;
  const r = await p.query(
    `UPDATE processing_jobs SET deleted_at = now()
     WHERE source = 'whatsapp' AND source_item_id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [String(sourceItemId)]
  );
  if (r.rows[0]) console.log(`[whatsapp/ingest] message ${sourceItemId} marked deleted (revoked) — drops off the board`);
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
// `reason` is the staff status key from config/board-statuses.json ('answered' /
// 'no_reply_needed'). It is recorded only so the admin "מה נוקה" view can show WHY
// a chat left the list; the detector's hide logic depends on the timestamp alone,
// so both reasons behave identically.
async function dismissChat(chatJid, byEmail, reason = null) {
  await ensureTables();
  const p = getPool();
  if (!p || !chatJid) return false;
  await p.query(
    `INSERT INTO unanswered_dismissals (chat_jid, dismissed_at, dismissed_by, reason)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (chat_jid) DO UPDATE
       SET dismissed_at = now(),
           dismissed_by = EXCLUDED.dismissed_by,
           reason       = EXCLUDED.reason`,
    [chatJid, byEmail || null, reason || null]
  );
  console.log(`[unanswered/dismiss] "${chatJid}" cleared by ${byEmail || 'unknown'} (reason=${reason || '-'})`);
  return true;
}

// Undo a dismissal — puts the chat back on the list immediately. Used by the
// admin "מה נוקה" view when something was cleared by mistake.
async function undismissChat(chatJid, byEmail) {
  await ensureTables();
  const p = getPool();
  if (!p || !chatJid) return false;
  const r = await p.query(`DELETE FROM unanswered_dismissals WHERE chat_jid = $1`, [chatJid]);
  console.log(`[unanswered/dismiss] "${chatJid}" restored by ${byEmail || 'unknown'} (${r.rowCount} row(s))`);
  return r.rowCount > 0;
}

// Recently cleared chats, newest first — the audit view. Joined to the group and
// contact rows only to recover a human-readable label; no message text is read.
async function listDismissals({ limit = 100 } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  // Label comes from whatsapp_groups only. wa_contacts is keyed by phone and is
  // reached through a message row's contact_id, so there is no chat_jid -> contact
  // join available here; a 1:1 chat falls back to its jid, which still identifies it.
  const { rows } = await p.query(
    `SELECT d.chat_jid, d.dismissed_at, d.dismissed_by, d.reason,
            COALESCE(g.name, d.chat_jid) AS label
       FROM unanswered_dismissals d
       LEFT JOIN whatsapp_groups g
              ON g.provider_group_jid = d.chat_jid AND g.removed_at IS NULL
      ORDER BY d.dismissed_at DESC
      LIMIT $1`,
    [n]
  );
  return rows.map((r) => ({
    chatJid: r.chat_jid,
    label: r.label,
    dismissedAt: r.dismissed_at,
    dismissedBy: r.dismissed_by,
    reason: r.reason,
  }));
}

// Set (or clear) the manual אחראי for a chat. Passing a falsy email REMOVES the
// override, so the chat falls back to the normal monday/in-group resolution.
// Never writes to monday — monday stays read-only.
async function setResponsibleOverride(chatJid, email, name, byEmail) {
  await ensureTables();
  const p = getPool();
  if (!p || !chatJid) return false;
  if (!email) {
    await p.query(`DELETE FROM chat_responsible_override WHERE chat_jid = $1`, [chatJid]);
    console.log(`[unanswered/responsible] "${chatJid}" override removed by ${byEmail || 'unknown'}`);
    return true;
  }
  await p.query(
    `INSERT INTO chat_responsible_override (chat_jid, email, name, set_by, set_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (chat_jid) DO UPDATE
       SET email  = EXCLUDED.email,
           name   = EXCLUDED.name,
           set_by = EXCLUDED.set_by,
           set_at = now()`,
    [chatJid, email, name || null, byEmail || null]
  );
  console.log(`[unanswered/responsible] "${chatJid}" -> ${email} (manual, by ${byEmail || 'unknown'})`);
  return true;
}

// All manual אחראי overrides for the given chats -> Map<chat_jid, {email, name}>.
// Called once per board build, so a manual choice costs no extra query per row.
async function getResponsibleOverrides(chatJids = []) {
  await ensureTables();
  const p = getPool();
  const out = new Map();
  if (!p || !chatJids.length) return out;
  const { rows } = await p.query(
    `SELECT chat_jid, email, name FROM chat_responsible_override WHERE chat_jid = ANY($1)`,
    [chatJids]
  );
  for (const r of rows) out.set(r.chat_jid, { email: r.email, name: r.name });
  return out;
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
  sender_staff_phone9, // the staffer who sent it (phone9), resolved by phone OR name; null for clients
  contact_id,
  deal_id,
  payloadObj,
  ts_seconds, // WhatsApp send time (messageTimestamp), seconds since epoch
} = {}) {
  // Derived here rather than at the call site so every ingest path — live
  // socket, history sync, replay — records it the same way.
  const kind = (() => { try { return messageKind(payloadObj); } catch (_) { return null; } })();
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
  const tsNum = Number(ts_seconds);
  const sentSeconds = Number.isFinite(tsNum) && tsNum > 0 ? tsNum : null;
  const r = await p.query(
    `INSERT INTO processing_jobs
       (source, source_item_id, chat_jid, is_group, direction, sender_phone, sender_staff_phone9, contact_id, deal_id, payload_encrypted, sent_at, msg_kind)
     VALUES ('whatsapp', $1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $10::double precision IS NULL THEN NULL ELSE to_timestamp($10::double precision) END, $11)
     ON CONFLICT (source, source_item_id) DO NOTHING
     RETURNING id`,
    [
      source_item_id,
      chat_jid || null,
      !!is_group,
      direction || null,
      sender_phone || null,
      sender_staff_phone9 || null,
      contact_id || null,
      deal_id || null,
      payloadEncrypted,
      sentSeconds,
      kind,
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
  // NOTE: this `hours_waiting` is WALL-CLOCK, deliberately. It is deal-level
  // metadata ("the client last wrote 3h ago") on the deals pipeline, not a
  // response-time measurement on the WhatsApp waiting board, and nothing in the
  // UI currently renders it. It was left on the wall clock rather than half-
  // converted; if this ever becomes a number somebody is judged by, move it to
  // businessHours.businessHoursBetween(row.last_inbound_at, Date.now()) like
  // listUnansweredChats does, and say so on screen.
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
     -- eff_at = the ACTUAL WhatsApp send time (sent_at) when known, else the
     -- ingest time (created_at). All wait/answer timing uses this, so a message
     -- redelivered late after a reconnect is still timed from when it was SENT.
     base AS (
       SELECT chat_jid, direction, sender_phone, sender_staff_phone9, payload_encrypted, contact_id, is_group,
              client_category,
              COALESCE(sent_at, created_at) AS eff_at
       FROM processing_jobs
       WHERE source = 'whatsapp' AND chat_jid IS NOT NULL AND deleted_at IS NULL
         -- System records (revokes, key exchange) are nobody's words.
         AND (msg_kind IS NULL OR msg_kind <> ALL($3::text[]))
         -- Reactions are filtered BY SENDER, not by kind:
         --   a staffer's 👍 stays — it is the firm answering, and dropping it
         --     would leave a client's message looking unanswered when it was not;
         --   a client's 👍 goes — it is not a question, and one sitting under
         --     the firm's last answer opened a wait nobody could ever close.
         -- msg_kind IS NULL means "not classified yet" and still counts: the
         -- fail-safe runs toward flagging a message, never toward hiding one.
         AND (
           direction = 'out'
           OR sender_staff_phone9 IS NOT NULL
           OR sender_phone IN (SELECT phone9 FROM staff)
           OR msg_kind IS NULL
           OR msg_kind <> ALL($2::text[])
         )
     ),
     -- "firm side" = the message was sent by a staffer: an outbound Lawly-line
     -- message, a resolved staff sender (by phone OR display name), or a raw
     -- staff phone (covers rows not yet backfilled). Everything else inbound is
     -- a client. Using sender_staff_phone9 is what catches staff who reply as an
     -- anonymous @lid — those were previously mistaken for client messages.
     per_chat AS (
       SELECT chat_jid,
              MAX(eff_at) FILTER (
                WHERE direction = 'in'
                  AND sender_staff_phone9 IS NULL
                  AND (sender_phone IS NULL OR sender_phone NOT IN (SELECT phone9 FROM staff))
              ) AS last_client_at,
              MAX(eff_at) FILTER (
                WHERE direction = 'out' OR sender_staff_phone9 IS NOT NULL
                  OR sender_phone IN (SELECT phone9 FROM staff)
              ) AS last_firm_at
       FROM base
       GROUP BY chat_jid
     ),
     -- Every client message the firm has NOT replied to (after last_firm_at, or
     -- all of them if the firm never replied). This is the "unanswered block".
     block AS (
       SELECT b.chat_jid, b.eff_at, b.payload_encrypted, b.contact_id,
              b.is_group, b.sender_phone, b.client_category
       FROM base b
       JOIN per_chat pc ON pc.chat_jid = b.chat_jid
       WHERE b.direction = 'in'
         AND b.sender_staff_phone9 IS NULL
         AND (b.sender_phone IS NULL OR b.sender_phone NOT IN (SELECT phone9 FROM staff))
         AND (pc.last_firm_at IS NULL OR b.eff_at > pc.last_firm_at)
     ),
     block_agg AS (
       SELECT chat_jid,
              -- WHERE THE WAIT REALLY STARTS.
              --
              -- Not simply the oldest message in the block. The triage already
              -- classifies every client message (client_category): 'none' is a
              -- closer — a 👍, a "תודה", a plain FYI — and nobody can reply to
              -- one. A chat answered at 09:00 and then reacted to at 12:01 was
              -- reading as TWELVE DAYS overdue, because the reaction was
              -- holding the clock and no answer could ever release it.
              --
              -- So the wait starts at the oldest message that plausibly wants
              -- an answer. Anything not yet classified (NULL) counts as wanting
              -- one: the fail-safe runs toward flagging, never toward hiding.
              MIN(eff_at) FILTER (
                WHERE COALESCE(client_category, 'unclassified') <> 'none'
              ) AS first_needing_reply_at,
              MIN(eff_at) AS first_unanswered_at,   -- oldest message of any kind
              MAX(eff_at) AS last_unanswered_at,
              COUNT(*)        AS msg_count,
              bool_or(is_group) AS is_group,
              -- oldest-first, capped, so the block reads in order for the AI
              (array_agg(payload_encrypted ORDER BY eff_at ASC))[1:25] AS payloads,
              (array_agg(sender_phone ORDER BY eff_at DESC))[1] AS last_client_phone,
              (array_agg(contact_id ORDER BY eff_at DESC) FILTER (WHERE contact_id IS NOT NULL))[1] AS contact_id
       FROM block
       GROUP BY chat_jid
     )
     SELECT pc.chat_jid,
            pc.last_client_at,
            pc.last_firm_at,
            ba.first_unanswered_at,
            ba.first_needing_reply_at,
            ba.last_unanswered_at,
            ba.msg_count,
            ba.payloads,
            ba.is_group,
            ba.last_client_phone,
            ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(ba.first_needing_reply_at, ba.first_unanswered_at))) / 3600.0, 1) AS hours_waiting,
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
    [staff, REACTION_KINDS, SYSTEM_KINDS]
  );

  const out = [];
  for (const row of r.rows) {
    const label = row.group_name || row.monday_client_name || row.display_name || row.chat_jid;
    // No unanswered block => the firm's last message came after every client
    // message (or there are none) => nothing awaiting a reply.
    const hasBlock = row.first_unanswered_at != null;
    // Measured from the OLDEST unanswered message in the block. TWO NUMBERS,
    // because there are two questions:
    //   hoursWaiting         — WORKING hours (08:00-22:00, no Saturday). Feeds
    //                          the response-speed metrics only.
    //   calendarHoursWaiting — REAL elapsed hours. Feeds everything a person
    //                          READS: the wait beside each row, the ops
    //                          dashboard's oldest/aging figures, the ordering.
    // The instant the clock really starts — see first_needing_reply_at above.
    // Falls back to the oldest message when every one of them is a closer, in
    // which case the chat-level triage will almost certainly drop it anyway.
    const waitFrom = row.first_needing_reply_at || row.first_unanswered_at;
    const waited = hasBlock ? businessHours.businessHoursBetween(waitFrom, Date.now()) : null;
    const calendarWaited = hasBlock && row.hours_waiting != null ? Number(row.hours_waiting) : null;
    // ── WHY THE THRESHOLD STAYS ON THE WALL CLOCK ──────────────────────────
    // The `hours` threshold answers "is this old enough to bother somebody
    // about", and that is a question about real elapsed time. Measuring it in
    // working hours would have quietly broken the one thing this feature
    // exists for: the digest runs at 08:00 with a 3-hour threshold, and at
    // 08:00 NOTHING has three working hours behind it — so every message that
    // arrived overnight, and the whole weekend on a Sunday, would have been
    // dropped from the only email of the day. The message would simply never
    // be mentioned.
    //
    // So: INCLUSION is wall-clock, MEASUREMENT is working hours. A message from
    // 23:00 last night appears in the morning list, and the time printed next
    // to it is the working time it has actually been waiting.
    const tooRecent = calendarWaited != null && calendarWaited < h;
    const msgCount = row.msg_count != null ? Number(row.msg_count) : 0;
    // Manually dismissed AND no newer client message since the dismissal.
    const dismissedAt = row.dismissed_at ? new Date(row.dismissed_at) : null;
    const dismissed = !!(dismissedAt && row.last_client_at && dismissedAt >= new Date(row.last_client_at));

    // Classify + LOG the reason for every chat that has a client message.
    let decision;
    if (!hasBlock) decision = `SKIP (firm replied after — firm last wrote ${row.last_firm_at || 'n/a'})`;
    else if (dismissed) decision = `SKIP (marked handled at ${row.dismissed_at}, no newer client msg)`;
    else if (tooRecent) decision = `SKIP (too recent — oldest unanswered waited ${calendarWaited}h wall-clock < threshold ${h}h)`;
    else decision = `TAKE (${msgCount} unanswered client msg(s), oldest waited ${waited} working h, no firm reply after)`;
    console.log(`[unanswered/why] "${label}" | oldestUnanswered=${row.first_unanswered_at || 'none'} (${row.last_client_phone || 'lid/unknown'}) | lastClient=${row.last_client_at} | lastFirm=${row.last_firm_at || 'never'} | block=${msgCount} | waited=${waited} working h (${calendarWaited}h wall-clock) -> ${decision}`);

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
        // Baileys payloads carry the content under .message; Cloud-API/history
        // payloads ARE the message (type/text at top level) — pass whichever.
        const t = textPreview(msg && (msg.message || msg)) || '';
        if (t) {
          // Prefix each line with the sender's display name so the AI reads the
          // block as a DIALOGUE — it can then see when a question was answered by
          // ANYONE in the chat (including a non-staff participant), or was
          // directed at a specific person, and drop it from the waiting list.
          const who = (msg && (msg.pushName || msg.verifiedBizName)) ? String(msg.pushName || msg.verifiedBizName).trim() : '';
          parts.push((who ? who + ': ' : '') + t);
        }
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
      hoursWaiting: waited,               // WORKING hours — response-speed metrics only
      calendarHoursWaiting: calendarWaited, // REAL elapsed hours — what people read
      lastInboundAt: row.last_client_at,
      firstUnansweredAt: waitFrom,                 // what every wait is shown from
      oldestInBlockAt: row.first_unanswered_at,    // including closers — diagnostics
      unansweredCount: msgCount,
      lastClientPhone: row.last_client_phone || null, // last-9 digits, for a wa.me link
      responsibleEmail: row.responsible_email == null ? null : String(row.responsible_email), // '' = resolved to default owner; null = not resolved yet
      participant_phones: Array.isArray(row.participant_phones) ? row.participant_phones : [],
      blockText,                          // WHOLE unanswered block -> AI needs-reply check
      lastText,                           // last line only (debugging)
    });
  }
  // OLDEST FIRST, by the moment the client actually wrote. Sorting on working
  // hours looked equivalent but is not: at 08:00 everything that arrived
  // overnight has zero working hours, the whole batch ties, and the genuinely
  // oldest message stops heading the list. The timestamp cannot tie.
  out.sort((a, b) => new Date(a.firstUnansweredAt).getTime() - new Date(b.firstUnansweredAt).getTime());

  console.log(`[unanswered/why] ${out.length} chat(s) TAKEN out of ${r.rows.length} chat(s) with a client message`);
  return out;
}

// Backfill msg_kind for rows ingested before the column existed. Same shape and
// the same idempotence as backfillSentAt: only touches NULLs, bounded per pass,
// and rows it cannot read are stamped 'unknown' so they are not rescanned
// forever. Run from the scheduler's periodic maintenance pass.
//
// Until a row is backfilled its msg_kind is NULL and it counts as a real
// message — the fail-safe is to flag, never to hide.
async function backfillMsgKind({ limit = 200 } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return { scanned: 0, filled: 0, reactions: 0 };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const r = await p.query(
    `SELECT id, payload_encrypted FROM processing_jobs
     WHERE source = 'whatsapp' AND msg_kind IS NULL
     ORDER BY created_at DESC LIMIT $1`,
    [lim]
  );
  let filled = 0, reactions = 0;
  for (const row of r.rows) {
    let kind = 'unknown';
    try {
      const json = enc.decrypt(row.payload_encrypted || '');
      const msg = json ? JSON.parse(json) : null;
      kind = messageKind(msg) || 'unknown';
    } catch (_) { /* unreadable -> 'unknown', still a real message */ }
    await p.query(`UPDATE processing_jobs SET msg_kind = $2 WHERE id = $1 AND msg_kind IS NULL`, [row.id, kind]);
    filled++;
    if (REACTION_KINDS.indexOf(kind) !== -1) reactions++;
  }
  if (r.rows.length) {
    console.log(`[msg-kind-backfill] scanned ${r.rows.length}, filled ${filled}` +
      (reactions ? `, ${reactions} of them reactions/receipts that will stop holding a wait open` : ''));
  }
  return { scanned: r.rows.length, filled, reactions };
}

// ============================================================================
// diagnoseChat — why does THIS chat say what it says?
//
// Built after a row read "waiting 12 days" on a conversation whose newest
// message arrived that morning and which the firm had plainly answered. The
// wait is measured from the OLDEST message the firm has not replied to, so a
// number that looks impossible always means one thing: a message the detector
// is NOT counting as a firm reply. There are only a few ways that happens —
//
//   • the sender came through as an anonymous @lid, so sender_phone is NULL,
//     and sender_staff_phone9 was never filled (the row predates the name
//     resolution, or the backfill has not been run);
//   • the staffer's WhatsApp display name does not resolve to anyone in
//     config/staff-directory.json;
//   • the person answering is not IN the directory at all;
//   • the row is not really a reply — a 👍 REACTION is ingested like any other
//     inbound message, and one sitting under the firm's last answer opens an
//     "unanswered block" that then never closes.
//
// — and reading the code cannot tell them apart. This can. Read-only, admin
// only, and deliberately WITHOUT message text: it returns what each row IS
// (kind, side, sender, time), never what it says. Phones are masked.
// ============================================================================
async function diagnoseChat({ chatLike = '', limit = 25, staffPhones = [] } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return { chats: [] };
  const like = String(chatLike || '').trim();
  if (!like) return { chats: [] };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const staff = Array.isArray(staffPhones) ? staffPhones.filter(Boolean) : [];

  const groups = await p.query(
    `SELECT provider_group_jid AS jid, name FROM whatsapp_groups
     WHERE name ILIKE '%'||$1||'%' AND removed_at IS NULL LIMIT 5`, [like]
  );
  const jids = groups.rows.map((g) => g.jid);
  if (!jids.length) return { chats: [], note: 'no group name matched "' + like + '"' };

  const mask = (ph) => (ph ? '···' + String(ph).slice(-3) : null);
  const out = [];
  for (const g of groups.rows) {
    const r = await p.query(
      `SELECT direction, sender_phone, sender_staff_phone9, deleted_at, payload_encrypted,
              COALESCE(sent_at, created_at) AS eff, created_at, sent_at
       FROM processing_jobs
       WHERE source='whatsapp' AND chat_jid=$1 AND deleted_at IS NULL
       ORDER BY eff DESC LIMIT $2`, [g.jid, lim]
    );
    const messages = r.rows.reverse().map((row) => {
      let msg = null;
      try { msg = JSON.parse(enc.decrypt(row.payload_encrypted || '')); } catch (_) {}
      const isFirm = !!row.sender_staff_phone9 || row.direction === 'out'
        || (row.sender_phone && staff.indexOf(row.sender_phone) !== -1);
      return {
        at: row.eff,
        // Where the time came from. A row whose sent_at is null is timed by
        // when we ingested it, which drifts after a reconnect.
        timeFrom: row.sent_at ? 'sent_at' : 'created_at (ingest time)',
        direction: row.direction,
        kind: messageKind(msg),
        pushName: (msg && (msg.pushName || msg.verifiedBizName)) || null,
        senderPhone: mask(row.sender_phone),
        senderStaffPhone9: row.sender_staff_phone9 || null,
        // THE column that matters: what the unanswered detector thinks this is.
        side: isFirm ? 'FIRM' : 'client/other',
        whyNotFirm: isFirm ? null
          : (!row.sender_phone && !row.sender_staff_phone9
              ? 'no phone (@lid) and no staff match — run the sender-staff backfill, or add this display name to config/staff-directory.json'
              : 'sender is not in config/staff-directory.json'),
      };
    });
    const firm = messages.filter((m) => m.side === 'FIRM');
    const lastFirmAt = firm.length ? firm[firm.length - 1].at : null;
    const block = messages.filter((m) => m.side !== 'FIRM' && (!lastFirmAt || new Date(m.at) > new Date(lastFirmAt)));
    out.push({
      group: g.name,
      lastFirmAt,
      firstUnansweredAt: block.length ? block[0].at : null,
      firstUnansweredKind: block.length ? block[0].kind : null,
      blockCount: block.length,
      // The single most useful line: if this is a reaction, or a message the
      // firm actually sent, the wait shown on the board is measured from the
      // wrong row and this names it.
      verdict: !firm.length
        ? 'NO message in this window counts as a firm reply — that is why the wait reaches back so far'
        : (block.length && block[0].kind === 'reactionMessage'
            ? 'the wait starts at a REACTION (👍) — it is not a message anyone needs to answer'
            : 'looks normal: the wait starts at the first client message after the firm last replied'),
      messages,
    });
  }
  return { chats: out };
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
      -- created_at here = the effective time (real send time when known).
      SELECT chat_jid, COALESCE(sent_at, created_at) AS created_at, client_category,
             CASE WHEN direction = 'out' OR sender_phone IN (SELECT phone9 FROM staff)
                  THEN 'firm' ELSE 'client' END AS side
      FROM processing_jobs
      WHERE source = 'whatsapp' AND chat_jid IS NOT NULL AND deleted_at IS NULL
        AND COALESCE(sent_at, created_at) >= now() - make_interval(days => $2)
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
      -- The two raw instants, NOT their difference. The subtraction is a
      -- working-hours integration now (lib/business-hours.js), so it happens in
      -- JavaScript. These are SPEED figures — the median and average response
      -- time — and the ops dashboard labels them "שעות עבודה" to keep them
      -- apart from the elapsed-time tiles beside them.
      SELECT t.client_at,
             to_char(t.client_at AT TIME ZONE '${TZ_SQL}', 'YYYY-MM-DD') AS day,
             (SELECT MIN(m.created_at) FROM msgs m
               WHERE m.chat_jid = t.chat_jid AND m.side = 'firm' AND m.created_at > t.client_at)
             AS replied_at
      FROM turns t
    )`;
  const rows = (await p.query(CTE + ` SELECT client_at, day, replied_at FROM resp`, [staff, d])).rows;

  // Aggregate here rather than in SQL: percentile_cont cannot see a working
  // clock, and doing it twice (once per query) is how the two halves of a
  // dashboard end up disagreeing.
  const answered = [];
  const byDay = new Map();
  for (const r of rows) {
    if (!r.replied_at) continue;
    const hrs = businessHours.businessSecondsBetween(r.client_at, r.replied_at) / 3600;
    answered.push(hrs);
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(hrs);
  }
  const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
  const avgOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const medianOf = (xs) => {
    if (!xs.length) return null;
    const v = xs.slice().sort((a, b) => a - b);
    const n = v.length;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  };
  const summaryRow = {
    total_turns: rows.length,
    answered_turns: answered.length,
    avg_hours: round1(avgOf(answered)),
    median_hours: round1(medianOf(answered)),
    // "within 3 hours" now means three WORKING hours, which is the only
    // reading that matches the rest of the system.
    pct_within_3h: answered.length
      ? Math.round((answered.filter((h) => h <= 3).length / answered.length) * 100)
      : null,
  };
  const dailyRows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, xs]) => ({ day, avg_hours: round1(avgOf(xs)), n: xs.length }));
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
       AND COALESCE(sent_at, created_at) >= now() - make_interval(days => $2)`,
    [staff, d]
  );
  const s = summaryRow;
  const cb = cats.rows[0] || {};
  return {
    days: d,
    totalTurns: s.total_turns || 0,
    answeredTurns: s.answered_turns || 0,
    avgHours: s.avg_hours != null ? Number(s.avg_hours) : null,
    medianHours: s.median_hours != null ? Number(s.median_hours) : null,
    pctWithin3h: s.pct_within_3h != null ? Number(s.pct_within_3h) : null,
    daily: dailyRows.map((r) => ({ day: r.day, avgHours: r.avg_hours != null ? Number(r.avg_hours) : null, n: r.n })),
    // Every number above is measured on the firm's working clock. Sent so the
    // dashboard can say so instead of leaving a reader to assume wall-clock.
    clockLabel: businessHours.config().label,
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
  markMessageDeleted,
  getChatTriage,
  setChatTriage,
  backfillSentAt,
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
  diagnoseChat,
  backfillMsgKind,
  NON_MESSAGE_KINDS,
  REACTION_KINDS,
  SYSTEM_KINDS,
  undismissChat,
  listDismissals,
  setResponsibleOverride,
  getResponsibleOverrides,
  ITEM_CATEGORIES,
  ITEM_NEEDS,
  stats,
};
