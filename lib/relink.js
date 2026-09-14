// ============================================================
// lib/relink.js — on-demand re-linking of WhatsApp groups to their monday deal,
// driven from data we ALREADY have (no need to wait for a new message). Runs the
// same chain the ingest path uses:
//   1) group-id column on a deal   2) the group's client -> their deals ->
//   name match (deterministic + AI)   3) name match with project context.
// Then resolves + caches the responsible. Batched so one call can't run away.
// ============================================================
const { getPool } = require('../db');
const monday = require('./monday');
const groupsDb = require('../whatsapp/groups/db');
const ingestDb = require('../whatsapp/ingest/db');
const responsible = require('./responsible');
const { loadDirectory } = require('./routing');
const { pickDealByGroupName } = require('../whatsapp/ingest/match');
const { pickDealByGroupNameAI } = require('../whatsapp/ingest/ai-match');

// How many failed link attempts a group gets before relinkUnlinked() gives up
// on it. Each attempt can re-run the AI name matcher on an ambiguous case, and
// each of THOSE can land on a different (wrong) deal — so this isn't just a
// cost cap, it's what stops a non-deal group's responsible_email from being
// overwritten with a fresh wrong guess every time this job runs.
const DEAL_LINK_MAX_ATTEMPTS = 3;

// The monday client item for a group, taken from its ingested client messages.
// Returns { itemId, phone } so the caller can also pull in co-buyers who share
// the same phone (a couple), not just the one row we happened to store.
async function clientMondayItemForChat(chatJid) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT c.monday_item_id, c.phone_normalized
     FROM processing_jobs pj JOIN wa_contacts c ON c.id = pj.contact_id
     WHERE pj.chat_jid = $1 AND pj.direction = 'in' AND c.monday_item_id IS NOT NULL
     ORDER BY pj.created_at DESC LIMIT 1`,
    [chatJid]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { itemId: row.monday_item_id, phone: row.phone_normalized || null };
}

// De-dupe a flat list of deal descriptors by (board, item).
function dedupeDeals(list) {
  const seen = new Set();
  const out = [];
  for (const d of (list || [])) {
    if (!d || !d.monday_item_id) continue;
    const k = `${d.monday_board_id}:${d.monday_item_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

async function relinkOne(group, dir) {
  const jid = group.provider_group_jid;
  const groupName = group.name;

  // 1) group-id column on a deal (most reliable)
  let dealDesc = await monday.resolveDealForGroupId(jid);

  // 2) the group's client -> their deals -> name match (+ 3) project context)
  if (!dealDesc) {
    const client = await clientMondayItemForChat(jid);
    if (client && client.itemId) {
      // Gather every client row sharing this phone (the couple), so a deal that
      // is linked only to the OTHER spouse still shows up as a candidate.
      const itemIds = [String(client.itemId)];
      if (client.phone) {
        const shared = await monday.findClientsByPhone(client.phone);
        for (const s of shared) {
          if (s.monday_item_id && !itemIds.includes(String(s.monday_item_id))) {
            itemIds.push(String(s.monday_item_id));
          }
        }
      }
      const lists = await Promise.all(itemIds.map((id) => monday.resolveDealsForClient(id)));
      const candidates = dedupeDeals(lists.flat());
      dealDesc = pickDealByGroupName(groupName, candidates);
      if (!dealDesc) dealDesc = await pickDealByGroupNameAI(groupName, candidates);
      if (!dealDesc && candidates.length) {
        await monday.enrichDealsWithContext(candidates);
        dealDesc = await pickDealByGroupNameAI(groupName, candidates);
      }
    }
  }

  let linked = false;
  if (dealDesc) {
    const dealRow = await ingestDb.upsertDeal(dealDesc);
    if (dealRow) { await groupsDb.setGroupDealByJid(jid, dealRow.id); linked = true; }
  }
  // This run ended with no deal linked — count it. A group that keeps landing
  // here (a personal/social/vendor chat that was never going to be a deal)
  // stops being retried once it hits DEAL_LINK_MAX_ATTEMPTS in
  // relinkUnlinked() below, instead of being re-run against the AI name
  // matcher forever — see the deal_link_attempts comment in
  // whatsapp/groups/db.js's ensureTables().
  if (!linked) await groupsDb.incrementDealLinkAttempts(jid);
  // Resolve + cache the responsible (reads the now-set deal, or group-id column).
  await responsible.resolveAndStore(jid, dir);
  return { name: groupName, linked };
}

// Re-link a batch of still-unlinked groups. Returns { processed, linked, remaining, gaveUp }.
async function relinkUnlinked({ limit = 25 } = {}) {
  const p = getPool();
  if (!p) return { processed: 0, linked: 0, remaining: 0 };
  const dir = loadDirectory();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
  const r = await p.query(
    `SELECT provider_group_jid, name FROM whatsapp_groups
     WHERE removed_at IS NULL AND deal_id IS NULL AND deal_link_attempts < $2
     ORDER BY last_message_at DESC NULLS LAST LIMIT $1`,
    [lim, DEAL_LINK_MAX_ATTEMPTS]
  );
  let linked = 0;
  for (const g of r.rows) {
    try { const res = await relinkOne(g, dir); if (res.linked) linked++; }
    catch (e) { console.error('[relink] failed for', g.name, e.message); }
  }
  const rem = await p.query(
    `SELECT
       count(*) FILTER (WHERE deal_link_attempts < $1)::int AS retryable,
       count(*) FILTER (WHERE deal_link_attempts >= $1)::int AS gave_up
     FROM whatsapp_groups WHERE removed_at IS NULL AND deal_id IS NULL`,
    [DEAL_LINK_MAX_ATTEMPTS]
  );
  const remaining = (rem.rows[0] && rem.rows[0].retryable) || 0;
  const gaveUp = (rem.rows[0] && rem.rows[0].gave_up) || 0;
  console.log(`[relink] processed ${r.rows.length}, newly linked ${linked}, still retryable ${remaining}, gave up (no deal after ${DEAL_LINK_MAX_ATTEMPTS} tries) ${gaveUp}`);
  return { processed: r.rows.length, linked, remaining, gaveUp };
}

module.exports = { relinkUnlinked, relinkOne };
