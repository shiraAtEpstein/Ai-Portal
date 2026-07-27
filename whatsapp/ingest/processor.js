// ============================================================
// whatsapp/ingest/processor.js — Phase 4B: the task-extraction processor.
//
// Turns a deal's new WhatsApp messages into TASKS (deal_items), using the
// id-based close/add model: the task agent is shown the deal's current OPEN
// items (with ids) + the new messages, and returns which items to CLOSE (done)
// and which to ADD. No summary, no AI-guessed status/deadlines — those come from
// Monday live at answer time.
//
// Security: Claude only reasons and returns JSON. The BACKEND validates and is
// the only thing that writes to the DB. The agent's instructions live in Dropbox
// (see task-prompt.js) so they can be taught/corrected without a redeploy.
// ============================================================
const enc = require('../../lib/crypto');
const claude = require('../../lib/claude');
const ingestDb = require('./db');
const { loadTaskPrompt } = require('./task-prompt');

// ---- message text extraction (from a decrypted Baileys message) -----------
function messageText(msg) {
  const outer = (msg && msg.message) || {};
  const m =
    (outer.ephemeralMessage && outer.ephemeralMessage.message) ||
    (outer.viewOnceMessage && outer.viewOnceMessage.message) ||
    (outer.viewOnceMessageV2 && outer.viewOnceMessageV2.message) ||
    outer;
  const t =
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText) ||
    (m.listResponseMessage && m.listResponseMessage.title) ||
    '';
  if (t) return String(t).trim();
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice message]' : '[audio]';
  if (m.imageMessage) return '[image]';
  if (m.videoMessage) return '[video]';
  if (m.documentMessage) return '[document' + (m.documentMessage.fileName ? ': ' + m.documentMessage.fileName : '') + ']';
  if (m.stickerMessage) return '[sticker]';
  if (m.locationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
  return '';
}

function decodeJob(job) {
  let text = '';
  try { text = messageText(JSON.parse(enc.decrypt(job.payload_encrypted))); } catch (_) { text = ''; }
  const who = job.direction === 'out' ? 'Firm' : 'Client';
  const name = job.monday_client_name || job.display_name || job.sender_phone || '';
  const date = job.created_at instanceof Date ? job.created_at.toISOString().slice(0, 10) : String(job.created_at || '').slice(0, 10);
  return { date, who, name, text };
}

function fmtDue(d) {
  if (!d) return '';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function buildUserPrompt(deal, openItems, decoded) {
  const itemsBlock = (openItems && openItems.length)
    ? openItems.map((it) => `${it.id} — [${it.category}/${it.needs || 'action'}/${it.party || '-'}${it.due_date ? ' due ' + fmtDue(it.due_date) : ''}] ${it.text}`).join('\n')
    : '(none)';
  const lines = decoded.filter((d) => d.text).map((d) => `[${d.date}] ${d.who} ${d.name}: ${d.text}`.trim());
  return (
    `DEAL: ${deal.name || deal.monday_item_id}\n\n` +
    `CURRENT OPEN ITEMS (id — [category/needs/party] text):\n${itemsBlock}\n\n` +
    `NEW MESSAGES (oldest first):\n${lines.join('\n') || '(no readable text)'}\n\n` +
    `Return JSON only: {"close": [ids of finished open items], "add": [new tasks]}.`
  );
}

// ---- validation (backend owns what gets written) --------------------------
function clip(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? (s.length > max ? s.slice(0, max) : s) : null;
}
function validDate(d) { const s = clip(d, 10); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

// Returns { closeIds, addItems } or null (null only when the reply is unusable →
// leave messages pending for retry). Empty arrays are a valid "no change".
function validate(out, openItems) {
  if (!out || typeof out !== 'object') return null;
  const openIds = new Set((openItems || []).map((it) => String(it.id)));
  const closeIds = (Array.isArray(out.close) ? out.close : [])
    .map((x) => String(x)).filter((id) => openIds.has(id));   // only close ids we actually gave it
  const addItems = [];
  for (const it of (Array.isArray(out.add) ? out.add : [])) {
    if (!it || typeof it !== 'object') continue;
    const category = clip(it.category, 20);
    const text = clip(it.text, 1000);
    if (!text || !ingestDb.ITEM_CATEGORIES.includes(category)) continue;
    let needs = clip(it.needs, 20);
    if (!ingestDb.ITEM_NEEDS.includes(needs)) needs = 'action';
    let party = clip(it.party, 20);
    if (party !== 'firm' && party !== 'client') party = null;
    addItems.push({ category, needs, text, party, due_date: validDate(it.due_date) });
    if (addItems.length >= 100) break;
  }
  return { closeIds, addItems };
}

// ---- process one deal -----------------------------------------------------
async function processDeal(dealId) {
  const deal = await ingestDb.getDeal(dealId);
  if (!deal) return { ok: false, reason: 'deal not found' };

  const jobs = await ingestDb.getPendingJobsForDeal(dealId);
  if (!jobs.length) {
    // Nothing new — just clear needs_update (and recompute awaiting_reply).
    await ingestDb.applyTaskUpdate(dealId, { closeIds: [], addItems: [] }, []);
    return { ok: true, processed: 0 };
  }
  if (!claude.isConfigured()) return { ok: false, reason: 'ANTHROPIC_API_KEY not set', pending: jobs.length };

  // Load the agent from Dropbox. NO fallback — if it can't load, surface the
  // error and leave the messages pending, so a misconfiguration is visible.
  let system;
  try {
    system = await loadTaskPrompt();
  } catch (e) {
    console.error('[whatsapp/processor] task agent NOT loaded — refusing to run:', e.message);
    return { ok: false, reason: 'task agent not loaded: ' + e.message, pending: jobs.length };
  }

  const openItems = await ingestDb.getOpenItemsForDeal(dealId);
  const decoded = jobs.map(decodeJob);
  const out = await claude.askJSON({ system, user: buildUserPrompt(deal, openItems, decoded), maxTokens: 2000 });

  const result = validate(out, openItems);
  if (!result) {
    console.warn(`[whatsapp/processor] unusable AI output for deal ${dealId} — leaving ${jobs.length} pending`);
    return { ok: false, reason: 'invalid ai output', pending: jobs.length };
  }

  const applied = await ingestDb.applyTaskUpdate(dealId, result, jobs.map((j) => j.id));
  if (!applied) return { ok: false, reason: 'apply failed', pending: jobs.length };
  console.log(`[whatsapp/processor] deal ${dealId}: ${jobs.length} msg(s) → +${result.addItems.length} task(s), closed ${result.closeIds.length}`);
  return { ok: true, processed: jobs.length, added: result.addItems.length, closed: result.closeIds.length };
}

// ---- batch: everything that needs an update -------------------------------
async function processPendingDeals({ limit = 100 } = {}) {
  const ids = await ingestDb.listDealsNeedingUpdate(limit);
  let ok = 0, failed = 0, messages = 0;
  for (const id of ids) {
    try {
      const r = await processDeal(id);
      if (r.ok) { ok++; messages += r.processed || 0; } else failed++;
    } catch (e) { failed++; console.error('[whatsapp/processor] deal failed:', e.message); }
  }
  if (ids.length) console.log(`[whatsapp/processor] batch: ${ids.length} deal(s), ${ok} ok, ${failed} failed, ${messages} msg(s)`);
  return { deals: ids.length, ok, failed, messagesProcessed: messages };
}

// ---- on-demand: make one deal fresh before answering a question -----------
async function ensureDealFresh(dealId) {
  const deal = await ingestDb.getDeal(dealId);
  if (!deal) return { ok: false, reason: 'deal not found' };
  if (deal.needs_update || (await ingestDb.dealHasPending(dealId))) return await processDeal(dealId);
  return { ok: true, processed: 0, alreadyFresh: true };
}

module.exports = { processDeal, processPendingDeals, ensureDealFresh, messageText, validate };
