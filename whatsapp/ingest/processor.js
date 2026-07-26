// ============================================================
// whatsapp/ingest/processor.js — Phase 4B: the deal summary processor.
//
// Turns a deal's pending WhatsApp messages into a maintained STATE summary plus
// a few structured fields (status / next_action / blocking_on / next_deadline)
// so cross-deal questions are DB queries, not a scan of every summary.
//
// Security: Claude only reasons. It receives the current summary + the new
// messages and returns JSON. The BACKEND validates that JSON and is the only
// thing that writes to the database. Claude never runs SQL, never sees a deal
// it wasn't handed, never decides what to persist.
// ============================================================
const enc = require('../../lib/crypto');
const claude = require('../../lib/claude');
const ingestDb = require('./db');

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
  // Media with no caption — note the type so the summary knows something came in.
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
  try {
    const raw = JSON.parse(enc.decrypt(job.payload_encrypted));
    text = messageText(raw);
  } catch (_) { text = ''; }
  const who = job.direction === 'out' ? 'Firm' : 'Client';
  const name = job.monday_client_name || job.display_name || job.sender_phone || '';
  const date = job.created_at instanceof Date ? job.created_at.toISOString().slice(0, 10) : String(job.created_at || '').slice(0, 10);
  return { date, who, name, text };
}

// ---- the prompt -----------------------------------------------------------
const SYSTEM_PROMPT =
  'You maintain a concise, accurate STATE summary of a single real-estate legal matter (a "deal") ' +
  'for Epstein & Co., an Israeli law firm. You are given the deal\'s CURRENT summary and ONLY the NEW ' +
  'WhatsApp messages since it was last updated. Update the summary to reflect the current state.\n\n' +
  'LANGUAGE (critical):\n' +
  '- Write the summary AND every text field (status, next_action, blocking_on) in the SAME language as ' +
  'the chat messages. If the messages are in Hebrew, write ALL of them in Hebrew. Preserve Hebrew ' +
  'exactly — never translate or transliterate names, places, or quotes.\n\n' +
  'DO NOT FABRICATE (critical):\n' +
  '- Use ONLY facts explicitly present in the messages or the existing summary. Never infer, assume, or ' +
  'guess a status, action, or date that is not clearly stated.\n' +
  '- status, next_action and blocking_on must each be directly and explicitly supported by a message. ' +
  'If the messages do not clearly indicate the stage, the firm\'s next action, or what the deal is ' +
  'waiting on, return null for that field. A null field is CORRECT; a guessed one is a bug.\n' +
  '- If the new messages contain no substantive deal information (only greetings, tests, or chatter), ' +
  'leave the summary essentially unchanged and set the fields to null — do NOT invent progress.\n\n' +
  'THE SUMMARY:\n' +
  '- It is the current STATE of the deal, NOT a transcript. Keep it short. Remove outdated / superseded ' +
  'information. Focus on what matters for a real-estate transaction: fee agreement, questionnaire, ' +
  'signing set sent/signed, mortgage approval, payments and expenses, tax, registration, missing ' +
  'documents, scheduled meetings, deadlines. Ignore small talk.\n\n' +
  'STRUCTURED FIELDS (each in the chat language, or null):\n' +
  '  status: short label of the current stage — only if clearly indicated.\n' +
  '  next_action: the single most important thing the FIRM must do next — only if a message makes it clear.\n' +
  '  blocking_on: what the deal is waiting on — only if a message states it.\n' +
  '  next_deadline: the nearest relevant date as YYYY-MM-DD — only if a real date is given. Else null.\n\n' +
  'ITEMS — the specifics that must not be lost to the summary. Return the deal\'s CURRENT OPEN items: ' +
  'carry forward the still-open ones you are given, ADD new ones from the messages, and DROP any that ' +
  'the new messages show are now done. Each item:\n' +
  '  category: one of exactly task | payment | document | date | note\n' +
  '    task = an action to be done · payment = money paid/owed · document = a doc sent/needed/missing · ' +
  'date = a meeting/signing/deadline · note = a key fact or decision.\n' +
  '  text: the item, in the chat language. Be specific (e.g. capture a request like "send the client the ' +
  'email she asked about"). Do NOT invent items that are not in the messages.\n' +
  '  party: firm | client | null — who it is on.\n' +
  '  due_date: YYYY-MM-DD or null.\n' +
  'Only include real, message-supported items. An empty list is fine.\n\n' +
  'Also list the concrete changes you made this round (empty array if nothing substantive changed).\n\n' +
  'Reply with JSON ONLY, nothing else:\n' +
  '{"summary": "...", "status": "..."|null, "next_action": "..."|null, "blocking_on": "..."|null, ' +
  '"next_deadline": "YYYY-MM-DD"|null, ' +
  '"items": [{"category": "task|payment|document|date|note", "text": "...", "party": "firm|client|null", ' +
  '"due_date": "YYYY-MM-DD"|null}], "changes": ["..."]}';

function buildUserPrompt(deal, decoded, openItems) {
  const cur = (deal.ai_summary && deal.ai_summary.trim()) || '(no summary yet)';
  const lines = decoded
    .filter((d) => d.text)
    .map((d) => `[${d.date}] ${d.who} ${d.name}: ${d.text}`.trim());
  const itemsBlock = (openItems && openItems.length)
    ? openItems.map((it) => `- [${it.category}${it.due_date ? ' due ' + (it.due_date instanceof Date ? it.due_date.toISOString().slice(0, 10) : it.due_date) : ''}${it.party ? ' · ' + it.party : ''}] ${it.text}`).join('\n')
    : '(none)';
  return (
    `DEAL: ${deal.name || deal.monday_item_id}\n\n` +
    `CURRENT SUMMARY:\n${cur}\n\n` +
    `CURRENT FIELDS: status=${deal.status || 'null'}; next_action=${deal.next_action || 'null'}; ` +
    `blocking_on=${deal.blocking_on || 'null'}; next_deadline=${deal.next_deadline || 'null'}\n\n` +
    `CURRENT OPEN ITEMS:\n${itemsBlock}\n\n` +
    `NEW MESSAGES (oldest first):\n${lines.join('\n') || '(no readable text in the new messages)'}\n\n` +
    `Update the summary, fields, and open items to reflect these new messages. JSON only.`
  );
}

// ---- validation of Claude's reply (backend owns what gets written) --------
function clip(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function validItemDate(d) {
  const s = clip(d, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function validateItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const category = clip(it.category, 20);
    const text = clip(it.text, 1000);
    if (!text || !ingestDb.ITEM_CATEGORIES.includes(category)) continue; // drop invalid
    let party = clip(it.party, 20);
    if (party !== 'firm' && party !== 'client') party = null;
    out.push({ category, text, party, due_date: validItemDate(it.due_date) });
    if (out.length >= 100) break;
  }
  return out;
}
function validate(out) {
  if (!out || typeof out !== 'object') return null;
  const summary = clip(out.summary, 6000);
  if (!summary) return null; // a summary is required
  let deadline = clip(out.next_deadline, 10);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) deadline = null;
  return {
    summary,
    status: clip(out.status, 200),
    next_action: clip(out.next_action, 500),
    blocking_on: clip(out.blocking_on, 200),
    next_deadline: deadline,
    items: validateItems(out.items),
    changes: Array.isArray(out.changes) ? out.changes.map((c) => clip(c, 300)).filter(Boolean).slice(0, 20) : [],
  };
}

// ---- process one deal -----------------------------------------------------
async function processDeal(dealId) {
  const deal = await ingestDb.getDeal(dealId);
  if (!deal) return { ok: false, reason: 'deal not found' };

  const jobs = await ingestDb.getPendingJobsForDeal(dealId);
  if (!jobs.length) {
    // Nothing pending — just clear the flag so we don't keep re-selecting it.
    await ingestDb.applyDealUpdate(dealId, {
      summary: deal.ai_summary, status: deal.status, next_action: deal.next_action,
      blocking_on: deal.blocking_on, next_deadline: deal.next_deadline,
    }, []);
    return { ok: true, processed: 0 };
  }

  if (!claude.isConfigured()) return { ok: false, reason: 'ANTHROPIC_API_KEY not set', pending: jobs.length };

  const decoded = jobs.map(decodeJob);
  const openItems = await ingestDb.getOpenItemsForDeal(dealId);
  const out = await claude.askJSON({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(deal, decoded, openItems),
    // default model (Sonnet) for summary quality
    maxTokens: 2000,
  });
  const fields = validate(out);
  if (!fields) {
    // Leave the messages pending + needs_update true so the next run retries.
    console.warn(`[whatsapp/processor] invalid AI output for deal ${dealId} — leaving ${jobs.length} pending`);
    return { ok: false, reason: 'invalid ai output', pending: jobs.length };
  }

  const applied = await ingestDb.applyDealUpdate(dealId, fields, jobs.map((j) => j.id));
  if (!applied) return { ok: false, reason: 'apply failed', pending: jobs.length };
  console.log(`[whatsapp/processor] deal ${dealId}: summarized ${jobs.length} message(s); status="${fields.status || ''}"`);
  return { ok: true, processed: jobs.length, changes: fields.changes };
}

// ---- batch: process everything that needs an update -----------------------
async function processPendingDeals({ limit = 100 } = {}) {
  const ids = await ingestDb.listDealsNeedingUpdate(limit);
  let ok = 0, failed = 0, messages = 0;
  for (const id of ids) {
    try {
      const r = await processDeal(id);
      if (r.ok) { ok++; messages += r.processed || 0; } else { failed++; }
    } catch (e) {
      failed++;
      console.error('[whatsapp/processor] deal failed:', e.message);
    }
  }
  if (ids.length) console.log(`[whatsapp/processor] batch: ${ids.length} deal(s), ${ok} ok, ${failed} failed, ${messages} message(s) summarized`);
  return { deals: ids.length, ok, failed, messagesProcessed: messages };
}

// ---- on-demand: make one deal fresh before answering a question -----------
async function ensureDealFresh(dealId) {
  const deal = await ingestDb.getDeal(dealId);
  if (!deal) return { ok: false, reason: 'deal not found' };
  if (deal.needs_update || (await ingestDb.dealHasPending(dealId))) {
    return await processDeal(dealId);
  }
  return { ok: true, processed: 0, alreadyFresh: true };
}

module.exports = { processDeal, processPendingDeals, ensureDealFresh, messageText, validate };
