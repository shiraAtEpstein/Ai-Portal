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

// The monday client item for a group, taken from its ingested client messages.
async function clientMondayItemForChat(chatJid) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT c.monday_item_id
     FROM processing_jobs pj JOIN wa_contacts c ON c.id = pj.contact_id
     WHERE pj.chat_jid = $1 AND pj.direction = 'in' AND c.monday_item_id IS NOT NULL
     ORDER BY pj.created_at DESC LIMIT 1`,
    [chatJid]
  );
  return (r.rows[0] && r.rows[0].monday_item_id) || null;
}

async function relinkOne(group, dir) {
  const jid = group.provider_group_jid;
  const groupName = group.name;

  // 1) group-id column on a deal (most reliable)
  let dealDesc = await monday.resolveDealForGroupId(jid);

  // 2) the group's client -> their deals -> name match (+ 3) project context)
  if (!dealDesc) {
    const clientItem = await clientMondayItemForChat(jid);
    if (clientItem) {
      const candidates = await monday.resolveDealsForClient(clientItem);
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
  // Resolve + cache the responsible (reads the now-set deal, or group-id column).
  await responsible.resolveAndStore(jid, dir);
  return { name: groupName, linked };
}

// Re-link a batch of still-unlinked groups. Returns { processed, linked, remaining }.
async function relinkUnlinked({ limit = 25 } = {}) {
  const p = getPool();
  if (!p) return { processed: 0, linked: 0, remaining: 0 };
  const dir = loadDirectory();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
  const r = await p.query(
    `SELECT provider_group_jid, name FROM whatsapp_groups
     WHERE removed_at IS NULL AND deal_id IS NULL
     ORDER BY last_message_at DESC NULLS LAST LIMIT $1`,
    [lim]
  );
  let linked = 0;
  for (const g of r.rows) {
    try { const res = await relinkOne(g, dir); if (res.linked) linked++; }
    catch (e) { console.error('[relink] failed for', g.name, e.message); }
  }
  const rem = await p.query(
    `SELECT count(*)::int AS n FROM whatsapp_groups WHERE removed_at IS NULL AND deal_id IS NULL`
  );
  const remaining = (rem.rows[0] && rem.rows[0].n) || 0;
  console.log(`[relink] processed ${r.rows.length}, newly linked ${linked}, still unlinked ${remaining}`);
  return { processed: r.rows.length, linked, remaining };
}

module.exports = { relinkUnlinked, relinkOne };
