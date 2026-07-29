// ============================================================
// lib/memory.js — Layer 3 of the portal framework stack: AGENT MEMORY.
//
// Scope of this pass: PREFERENCES ONLY — "the how" (tone, language, formatting,
// length, structure, salutations, reasoning style). Shared across every agent
// for a given user. It deliberately does NOT store client/matter facts ("the
// what"); those are forbidden here (see the extractor prompt and the
// looksLikeClientFact guard), so there is no confidentiality wall to get wrong
// in this increment.
//
// Discipline (architecture §6): automation NEVER writes straight to trusted
// memory. It STAGES a candidate with an evidence count, and only PROMOTES it to
// trusted memory after it recurs PROMOTE_AFTER times OR the user confirms once.
// Trusted memories carry a last_reaffirmed date and quietly DECAY when stale.
// Everything is revocable ("forget that").
//
// Storage: PostgreSQL (the portal's Dropbox is read-only, and memory must be
// written). Content is encrypted at rest with lib/crypto, exactly like chat
// messages. The dedup key is an opaque SHA-256 of the normalized text, so no
// readable preference text is stored unencrypted. Tables self-provision with
// CREATE TABLE IF NOT EXISTS (the repo has no migration runner).
//
// Testability: the store (DB) and the extractor (LLM) are both injectable, so
// the whole pipeline unit-tests with no database and no network.
// ============================================================
const crypto = require('crypto');
const enc = require('./crypto');
let db = null;
try { db = require('../db'); } catch (_) { db = null; } // absent in unit tests

const ENABLED = process.env.MEMORY_ENABLED !== '0';            // master switch
const OBSERVE = process.env.MEMORY_OBSERVE !== '0';            // learn from chats
const PROMOTE_AFTER = parseInt(process.env.MEMORY_PROMOTE_AFTER || '3', 10);
const DECAY_DAYS = parseInt(process.env.MEMORY_DECAY_DAYS || '180', 10);
const MAX_MEMORIES = parseInt(process.env.MEMORY_MAX_ITEMS || '20', 10);
const MAX_TEXT = parseInt(process.env.MEMORY_MAX_TEXT || '200', 10);
const MODEL = process.env.MEMORY_MODEL || 'claude-haiku-4-5-20251001';

// --- Layer 3b: matter facts ("the what") ------------------------------------
// Facts are walled PER AGENT and never stored/loaded for externally-publishing
// agents or the general router (which can pivot to a publishing skill).
const FACT_DECAY_DAYS = parseInt(process.env.MEMORY_FACT_DECAY_DAYS || '30', 10);
const FACT_MAX = parseInt(process.env.MEMORY_FACT_MAX_ITEMS || '30', 10);
const FACT_EXCLUDED_AGENTS = new Set(
  String(process.env.MEMORY_FACT_EXCLUDE_AGENTS ||
    'general,marketing_director,content_planner,mkt_copywriter,copywriter')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
function factsAllowedForAgent(agentId) {
  const a = String(agentId || '').trim().toLowerCase();
  return !!a && !FACT_EXCLUDED_AGENTS.has(a);
}

// ---------- pure helpers (unit-tested directly) ----------

// Normalize for dedup: lowercase, unicode-fold, keep letters/numbers only.
// Uses \p{L}/\p{N} so Hebrew folds correctly.
function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function keyFor(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}
function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
// Short, log-safe excerpt of a PREFERENCE for the write-path logs. Never used
// for matter facts (those are confidential and are logged without content).
function snippet(t) {
  return JSON.stringify(String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60));
}

// Defense in depth: even if the extractor slips, drop anything that looks like a
// client/matter fact rather than a durable preference. Preferences only.
function looksLikeClientFact(text) {
  const t = String(text || '').toLowerCase();
  if (/[₪$€]|\d{3,}/.test(t)) return true;                       // money / long numbers
  if (/\b(deal|client|matter|contract|apartment|purchase|invoice|payment)\b/.test(t)) return true;
  if (/(עסקה|לקוח|תיק|חוזה|דירה|תשלום|חשבונית)/.test(t)) return true;
  // NOTE: "address"/"phone"/"כתובת"/"טלפון" were removed from the word lists.
  // An actual address or phone number always carries digits and is already caught
  // by the \d{3,} rule above; the bare words were false-positiving on legitimate
  // preferences like "address me as Tzipora" / "answer the phone politely", which
  // caused real form-of-address preferences to be dropped.
  return false;
}

// Parse + validate the extractor output into [{kind, action, text}].
function sanitizeItems(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\[[\s\S]*\]/);           // tolerate prose around the JSON
    try { arr = JSON.parse(m ? m[0] : raw); } catch (_) { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const kind = String(it.kind || 'preference').toLowerCase() === 'fact' ? 'fact' : 'preference';
    const text = cleanText(it.text != null ? it.text : it.preference);
    if (!text) continue;
    if (kind === 'fact') {
      // A matter fact ("the what"). Explicit-only; stored walled per agent by
      // observe(). NOT subject to the looksLikeClientFact drop — it IS the what.
      const action = ['forget', 'remove', 'delete'].includes(String(it.action || '').toLowerCase()) ? 'forget' : 'remember';
      out.push({ kind: 'fact', action, text });
    } else {
      const action = String(it.action || 'prefer').toLowerCase();
      if (!['prefer', 'confirm', 'forget'].includes(action)) continue;
      if (action !== 'forget' && looksLikeClientFact(text)) continue; // preferences never store the "what"
      out.push({ kind: 'preference', action, text });
    }
  }
  return out.slice(0, 6);
}

function isDecayed(lastReaffirmed, now, decayDays) {
  const t = new Date(lastReaffirmed).getTime();
  if (isNaN(t)) return false;
  return (now - t) > decayDays * 24 * 3600 * 1000;
}

// Render trusted memories as a system-prompt block, clearly subordinate.
function renderMemories(items, name) {
  if (!items || !items.length) return '';
  const who = name ? (' for ' + name) : '';
  return [
    '===== LEARNED PREFERENCES' + who + ' (remembered from past chats) =====',
    'These are durable working/style preferences learned from previous',
    'conversations. Apply them when helpful, but the FIRM RULES and the personal',
    'profile above ALWAYS win, and a direct instruction in THIS conversation wins',
    'over them. They are preferences only — never client or matter facts. If one',
    'is wrong, the user can say so and it will be dropped.',
    '',
    ...items.map((i) => '- ' + i.text),
  ].join('\n');
}

// Render a WALLED matter-fact block for one agent, with a strong confidentiality
// + staleness warning.
function renderFacts(items) {
  if (!items || !items.length) return '';
  return [
    '===== REMEMBERED MATTER NOTES (internal — THIS agent only) =====',
    'Notes a staff member explicitly asked you to remember for their matters, for',
    'this agent alone. They are CONFIDENTIAL: never repeat, quote, or imply them in',
    'anything that could reach a client or the public. They may be OUTDATED — verify',
    'against monday or the file before relying on them. If one is wrong, the user',
    'can say "forget that" to drop it.',
    '',
    ...items.map((i) => '- ' + i.text),
  ].join('\n');
}

// ---------- default extractor (LLM); injectable for tests ----------
let _client = null;
function anthropic() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}
async function defaultInfer({ userText, assistantText }) {
  const client = anthropic();
  // Capture ONLY preferences the USER explicitly states. Never infer a preference
  // from the assistant's own reply/formatting or from the topic — that produced a
  // lot of staged noise (e.g. "use emoji bullets") the user never asked for.
  const sys = [
    "You capture a user's EXPLICIT, durable preferences about HOW they want the assistant",
    "to respond, for long-term memory at a law firm. Extract a preference ONLY when the",
    'USER directly states or requests it (e.g. "reply in Hebrew", "keep answers short",',
    '"always greet me by name", "stop using emojis"). STRICT RULES:',
    "1. Source ONLY from the USER's message. NEVER infer a preference from the assistant's",
    '   reply, its formatting, or the topic being discussed. The assistant text is context',
    '   only — do not extract anything from it.',
    '2. Capture only DURABLE, general style/working preferences (tone, language, length,',
    '   format, structure, greeting, reasoning) — NOT a one-off request about this specific',
    '   task (e.g. "make THIS email shorter" is one-off, not a durable preference).',
    '3. NEVER output client names, matter/deal facts, numbers, amounts, dates, addresses,',
    '   or anything specific to a case AS A PREFERENCE. Forbidden.',
    '4. action="confirm" if the user explicitly asks you to remember / always do something;',
    '   action="forget" if they ask you to stop / forget something; otherwise action="prefer".',
    '5. When in doubt, return []. It is far better to miss a preference than to invent one.',
    '',
    'FACTS (a separate kind): ONLY if the user EXPLICITLY asks you to remember or forget a',
    'specific case/matter fact (e.g. "remember for the Levi matter that the survey is delayed",',
    '"note that the Cohen counterparty is difficult", "forget what I said about the Katz file"),',
    'output it as {"kind":"fact","action":"remember"|"forget","text":"<the fact; name the matter>"}.',
    'NEVER infer a fact on your own — only on an explicit remember/forget request. A preference',
    'uses kind="preference" (or omit kind).',
    'Output STRICT JSON only: an array of {"kind":"preference|fact", "action":..., "text":...} objects',
    'as described. Max 3 items. No prose.',
  ].join('\n');
  const user = "The USER just wrote:\n" + String(userText || '').slice(0, 2000) +
    '\n\n(Context only — DO NOT extract preferences from this. The assistant replied:\n' +
    String(assistantText || '').slice(0, 500) + ')\n\n' +
    'Return JSON of ONLY preferences the USER explicitly expressed, plus any matter fact they\n' +
    'explicitly asked to remember or forget, or [] if none.';
  const r = await client.messages.create({ model: MODEL, max_tokens: 400, system: sys, messages: [{ role: 'user', content: user }] });
  return (r.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
}

// ---------- default store (PostgreSQL) ----------
let _ensured = null;
function getPool() {
  const p = db && db.getPool && db.getPool();
  if (!p) throw new Error('database unavailable');
  return p;
}
function ensureSchema(pool) {
  if (_ensured) return _ensured;
  _ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS memory_candidates (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL,
      norm_key text NOT NULL,
      content_enc text NOT NULL,
      seen_count int NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'staged',
      first_seen timestamptz NOT NULL DEFAULT now(),
      last_seen timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, norm_key)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_memory (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL,
      norm_key text NOT NULL,
      content_enc text NOT NULL,
      source text NOT NULL DEFAULT 'promoted',
      created_at timestamptz NOT NULL DEFAULT now(),
      last_reaffirmed timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      UNIQUE (user_id, norm_key)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS agent_facts (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL,
      agent_id text NOT NULL,
      norm_key text NOT NULL,
      content_enc text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_reaffirmed timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      UNIQUE (user_id, agent_id, norm_key)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS muted_conversations (
      conversation_id text PRIMARY KEY,
      user_id uuid,
      muted_at timestamptz NOT NULL DEFAULT now()
    );`);
  })().catch((e) => { _ensured = null; throw e; });
  return _ensured;
}

const pgStore = {
  async listActive(userId) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query(
      `SELECT norm_key, content_enc, last_reaffirmed FROM user_memory
       WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_reaffirmed DESC`, [userId]);
    return r.rows.map((row) => ({ norm_key: row.norm_key, text: enc.decrypt(row.content_enc), last_reaffirmed: row.last_reaffirmed }));
  },
  async hasMemory(userId, key) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query('SELECT 1 FROM user_memory WHERE user_id=$1 AND norm_key=$2 AND revoked_at IS NULL', [userId, key]);
    return r.rowCount > 0;
  },
  async reaffirm(userId, key) {
    const p = getPool(); await ensureSchema(p);
    await p.query('UPDATE user_memory SET last_reaffirmed=now() WHERE user_id=$1 AND norm_key=$2', [userId, key]);
  },
  async bumpOrInsertCandidate(userId, key, text) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query(
      `INSERT INTO memory_candidates (user_id, norm_key, content_enc) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, norm_key) DO UPDATE SET seen_count = memory_candidates.seen_count + 1, last_seen = now()
       RETURNING seen_count, status`, [userId, key, enc.encrypt(text)]);
    return r.rows[0];
  },
  async markCandidatePromoted(userId, key) {
    const p = getPool(); await ensureSchema(p);
    await p.query("UPDATE memory_candidates SET status='promoted' WHERE user_id=$1 AND norm_key=$2", [userId, key]);
  },
  async upsertConfirmed(userId, key, text, source) {
    const p = getPool(); await ensureSchema(p);
    await p.query(
      `INSERT INTO user_memory (user_id, norm_key, content_enc, source) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, norm_key) DO UPDATE SET last_reaffirmed = now(), revoked_at = NULL, content_enc = EXCLUDED.content_enc`,
      [userId, key, enc.encrypt(text), source]);
  },
  async revoke(userId, key) {
    const p = getPool(); await ensureSchema(p);
    await p.query('UPDATE user_memory SET revoked_at=now() WHERE user_id=$1 AND norm_key=$2 AND revoked_at IS NULL', [userId, key]);
  },
  // Read-only admin view: everything stored for a user (decrypted), trusted and
  // staged, with metadata. Used by the admin memory-viewer endpoint only.
  async adminListForUser(userId) {
    const p = getPool(); await ensureSchema(p);
    const t = await p.query(
      `SELECT content_enc, source, created_at, last_reaffirmed, revoked_at FROM user_memory
       WHERE user_id = $1 ORDER BY last_reaffirmed DESC`, [userId]);
    const s = await p.query(
      `SELECT content_enc, seen_count, status, first_seen, last_seen FROM memory_candidates
       WHERE user_id = $1 ORDER BY last_seen DESC`, [userId]);
    return {
      trusted: t.rows.map((row) => ({
        text: enc.decrypt(row.content_enc), source: row.source,
        createdAt: row.created_at, lastReaffirmed: row.last_reaffirmed,
        revoked: !!row.revoked_at, revokedAt: row.revoked_at,
      })),
      staged: s.rows.map((row) => ({
        text: enc.decrypt(row.content_enc), seenCount: row.seen_count, status: row.status,
        firstSeen: row.first_seen, lastSeen: row.last_seen,
      })),
    };
  },
  // Delete a user's STAGED candidates (not yet trusted). Trusted memory in
  // user_memory is untouched. Returns how many rows were removed.
  async clearStaged(userId) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query("DELETE FROM memory_candidates WHERE user_id=$1 AND status='staged'", [userId]);
    return r.rowCount || 0;
  },
  // --- Layer 3b: walled matter facts, keyed by (user, agent_id) ---
  async listFacts(userId, agentId) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query(
      `SELECT norm_key, content_enc, last_reaffirmed FROM agent_facts
       WHERE user_id=$1 AND agent_id=$2 AND revoked_at IS NULL ORDER BY last_reaffirmed DESC`, [userId, agentId]);
    return r.rows.map((row) => ({ norm_key: row.norm_key, text: enc.decrypt(row.content_enc), last_reaffirmed: row.last_reaffirmed }));
  },
  async upsertFact(userId, agentId, key, text) {
    const p = getPool(); await ensureSchema(p);
    await p.query(
      `INSERT INTO agent_facts (user_id, agent_id, norm_key, content_enc) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, agent_id, norm_key) DO UPDATE SET last_reaffirmed=now(), revoked_at=NULL, content_enc=EXCLUDED.content_enc`,
      [userId, agentId, key, enc.encrypt(text)]);
  },
  async revokeFact(userId, agentId, key) {
    const p = getPool(); await ensureSchema(p);
    await p.query('UPDATE agent_facts SET revoked_at=now() WHERE user_id=$1 AND agent_id=$2 AND norm_key=$3 AND revoked_at IS NULL', [userId, agentId, key]);
  },
  // All facts across every agent for a user (decrypted) — admin viewer only.
  async adminListFacts(userId) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query(
      `SELECT agent_id, content_enc, created_at, last_reaffirmed, revoked_at FROM agent_facts
       WHERE user_id=$1 ORDER BY last_reaffirmed DESC`, [userId]);
    return r.rows.map((row) => ({
      agentId: row.agent_id, text: enc.decrypt(row.content_enc),
      createdAt: row.created_at, lastReaffirmed: row.last_reaffirmed, revoked: !!row.revoked_at,
    }));
  },
  // --- Layer 4: session context. Mark a conversation as "do not remember" so the
  // observe pass never learns from it (preferences OR facts). Idempotent. ---
  async muteConversation(convId, userId) {
    const p = getPool(); await ensureSchema(p);
    await p.query(
      `INSERT INTO muted_conversations (conversation_id, user_id) VALUES ($1, $2)
       ON CONFLICT (conversation_id) DO NOTHING`, [String(convId), userId || null]);
  },
  async isConversationMuted(convId) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query('SELECT 1 FROM muted_conversations WHERE conversation_id = $1', [String(convId)]);
    return r.rowCount > 0;
  },
};

// ---------- orchestration (store + infer injectable) ----------

// Load a user's trusted, non-decayed memories as a prompt block.
async function loadForUser(userId, opts = {}) {
  if (!ENABLED || !userId) return { text: '', items: [] };
  const store = opts.store || pgStore;
  let rows = [];
  try { rows = await store.listActive(userId); }
  catch (e) { console.error('[MEMORY] list failed:', e.message); return { text: '', items: [] }; }
  const now = opts.now || Date.now();
  const items = rows
    .filter((r) => !isDecayed(r.last_reaffirmed, now, DECAY_DAYS))
    .slice(0, MAX_MEMORIES)
    .map((r) => ({ text: r.text }));
  return { text: renderMemories(items, opts.name), items };
}

// Observe one exchange: stage/promote/confirm/forget preferences, and store or
// forget explicit matter FACTS (walled to the current agent). Fire-and-forget.
async function observe(userId, opts = {}) {
  const res = { staged: 0, promoted: 0, confirmed: 0, forgotten: 0, factsSaved: 0, factsForgotten: 0 };
  if (!ENABLED || !OBSERVE || !userId) return res;
  const store = opts.store || pgStore;
  const infer = opts.infer || defaultInfer;
  // Facts are walled to the CURRENT agent, and only for fact-eligible agents.
  const agentId = String(opts.agentId || '').trim().toLowerCase();
  const factsOk = factsAllowedForAgent(agentId);
  let raw;
  try { raw = await infer({ userText: opts.userText, assistantText: opts.assistantText }); }
  catch (e) { console.error('[MEMORY] infer failed:', e.message); return res; }
  for (const it of sanitizeItems(raw)) {
    const key = keyFor(it.text);
    try {
      if (it.kind === 'fact') {
        // WALL: publishing / general agents never store or touch matter facts.
        if (!factsOk) continue;
        // Matter facts are confidential: log THAT one was written and for which
        // agent, but NEVER the fact text itself.
        if (it.action === 'forget') { await store.revokeFact(userId, agentId, key); res.factsForgotten++; console.log('[MEMORY] fact-forgotten (agent=' + agentId + ')'); }
        else { await store.upsertFact(userId, agentId, key, it.text); res.factsSaved++; console.log('[MEMORY] fact-saved (agent=' + agentId + ')'); }
        continue;
      }
      if (it.action === 'forget') { await store.revoke(userId, key); res.forgotten++; console.log('[MEMORY] preference forgotten: ' + snippet(it.text)); continue; }
      if (it.action === 'confirm') { await store.upsertConfirmed(userId, key, it.text, 'confirmed'); res.confirmed++; console.log('[MEMORY] preference CONFIRMED -> trusted immediately (user said "always"): ' + snippet(it.text)); continue; }
      if (await store.hasMemory(userId, key)) { await store.reaffirm(userId, key); console.log('[MEMORY] preference reaffirmed: ' + snippet(it.text)); continue; } // already trusted
      const c = await store.bumpOrInsertCandidate(userId, key, it.text);
      if (c && c.seen_count >= PROMOTE_AFTER && c.status !== 'promoted') {
        await store.upsertConfirmed(userId, key, it.text, 'promoted');
        await store.markCandidatePromoted(userId, key);
        res.promoted++;
        console.log('[MEMORY] preference PROMOTED to trusted (seen ' + c.seen_count + '/' + PROMOTE_AFTER + '): ' + snippet(it.text));
      } else { res.staged++; console.log('[MEMORY] preference staged (' + (c ? c.seen_count : 1) + '/' + PROMOTE_AFTER + '): ' + snippet(it.text)); }
    } catch (e) { console.error('[MEMORY] observe item failed:', e.message); }
  }
  return res;
}

// Explicit user actions (available for future tools / admin).
async function remember(userId, text, opts = {}) {
  if (!userId) return false;
  const store = opts.store || pgStore;
  const t = cleanText(text);
  if (!t || looksLikeClientFact(t)) return false;
  await store.upsertConfirmed(userId, keyFor(t), t, 'confirmed');
  return true;
}
async function forget(userId, text, opts = {}) {
  if (!userId) return false;
  const store = opts.store || pgStore;
  await store.revoke(userId, keyFor(text));
  return true;
}

// ── Explicit, verdict-returning writes (for the `remember` / `forget` tools) ──
// Unlike observe(), these are called INSIDE the chat loop and return a structured
// result so the model can tell the user the truth: saved / rejected (with a
// reason) / already_known. The looksLikeClientFact check here becomes a REJECTION
// reason the model can explain, NOT a silent drop. Store/verdict are unit-testable
// via opts.store.
async function rememberExplicit(userId, { kind, text, agentId } = {}, opts = {}) {
  if (!ENABLED) return { status: 'rejected', reason: 'memory_disabled' };
  if (!userId) return { status: 'rejected', reason: 'no_user' };
  const store = opts.store || pgStore;
  const t = cleanText(text);
  if (!t) return { status: 'rejected', reason: 'empty' };
  const key = keyFor(t);
  try {
    if (String(kind).toLowerCase() === 'fact') {
      const aid = String(agentId || '').trim().toLowerCase();
      if (!factsAllowedForAgent(aid)) return { status: 'rejected', reason: 'facts_not_allowed_here', text: t };
      await store.upsertFact(userId, aid, key, t);
      console.log('[MEMORY] fact-saved via tool (agent=' + aid + ')');
      return { status: 'saved', tier: 'agent-fact', agentId: aid, text: t };
    }
    if (looksLikeClientFact(t)) {
      console.log('[MEMORY] remember rejected (looks_like_client_data): ' + snippet(t));
      return { status: 'rejected', reason: 'looks_like_client_data', text: t };
    }
    if (await store.hasMemory(userId, key)) {
      await store.reaffirm(userId, key);
      console.log('[MEMORY] preference already-known, reaffirmed via tool: ' + snippet(t));
      return { status: 'already_known', text: t };
    }
    await store.upsertConfirmed(userId, key, t, 'confirmed');
    console.log('[MEMORY] preference SAVED via tool (trusted): ' + snippet(t));
    return { status: 'saved', tier: 'trusted', text: t };
  } catch (e) {
    console.error('[MEMORY] rememberExplicit failed:', e.message);
    return { status: 'rejected', reason: 'error', detail: e.message };
  }
}

async function forgetExplicit(userId, { text, kind, agentId } = {}, opts = {}) {
  if (!userId) return { status: 'not_found' };
  const store = opts.store || pgStore;
  const t = cleanText(text);
  if (!t) return { status: 'not_found' };
  const key = keyFor(t);
  try {
    if (String(kind).toLowerCase() === 'fact') {
      const aid = String(agentId || '').trim().toLowerCase();
      await store.revokeFact(userId, aid, key);
      console.log('[MEMORY] fact-forgotten via tool (agent=' + aid + ')');
      return { status: 'forgotten', scope: 'fact', text: t };
    }
    const had = await store.hasMemory(userId, key);
    await store.revoke(userId, key);
    console.log('[MEMORY] preference forgotten via tool (' + (had ? 'had' : 'not_found') + '): ' + snippet(t));
    return { status: had ? 'forgotten' : 'not_found', text: t };
  } catch (e) {
    console.error('[MEMORY] forgetExplicit failed:', e.message);
    return { status: 'error', detail: e.message };
  }
}

// Read-only: the full memory picture for a user (trusted + staged), for the
// admin viewer. Fail-safe: returns empties on any error.
async function listForUser(userId, opts = {}) {
  if (!userId) return { trusted: [], staged: [] };
  const store = opts.store || pgStore;
  try { return await store.adminListForUser(userId); }
  catch (e) { console.error('[MEMORY] admin list failed:', e.message); return { trusted: [], staged: [] }; }
}

// Clear a user's staged (not-yet-trusted) candidates. Trusted memory is kept.
// Returns the number removed. Fail-safe.
async function clearStaged(userId, opts = {}) {
  if (!userId) return 0;
  const store = opts.store || pgStore;
  try { return await store.clearStaged(userId); }
  catch (e) { console.error('[MEMORY] clearStaged failed:', e.message); return 0; }
}

// Load a user's WALLED matter facts for one agent as a prompt block. Empty for
// fact-excluded agents (general/publishing) or on any error.
async function loadFactsForAgent(userId, agentId, opts = {}) {
  if (!ENABLED || !userId || !factsAllowedForAgent(agentId)) return { text: '', items: [] };
  const store = opts.store || pgStore;
  const aid = String(agentId).trim().toLowerCase();
  let rows = [];
  try { rows = await store.listFacts(userId, aid); }
  catch (e) { console.error('[MEMORY] facts list failed:', e.message); return { text: '', items: [] }; }
  const now = opts.now || Date.now();
  const items = rows
    .filter((r) => !isDecayed(r.last_reaffirmed, now, FACT_DECAY_DAYS))
    .slice(0, FACT_MAX)
    .map((r) => ({ text: r.text }));
  return { text: renderFacts(items), items };
}

// Read-only: every matter fact stored for a user, across agents (admin viewer).
async function listFactsForAdmin(userId, opts = {}) {
  if (!userId) return [];
  const store = opts.store || pgStore;
  try { return await store.adminListFacts(userId); }
  catch (e) { console.error('[MEMORY] admin facts list failed:', e.message); return []; }
}

// Layer 4 — mark a conversation "do not remember" (the observe pass will skip it).
async function muteConversation(convId, userId, opts = {}) {
  if (!convId) return false;
  const store = opts.store || pgStore;
  try { await store.muteConversation(convId, userId); return true; }
  catch (e) { console.error('[MEMORY] muteConversation failed:', e.message); return false; }
}
// Fail-safe: on any error return FALSE (i.e. "not muted") so a DB blip never
// causes us to silently drop learning without the user asking.
async function isConversationMuted(convId, opts = {}) {
  if (!convId) return false;
  const store = opts.store || pgStore;
  try { return await store.isConversationMuted(convId); }
  catch (e) { console.error('[MEMORY] isConversationMuted failed:', e.message); return false; }
}

module.exports = {
  loadForUser, observe, remember, forget, rememberExplicit, forgetExplicit, listForUser, clearStaged,
  loadFactsForAgent, listFactsForAdmin, factsAllowedForAgent, renderFacts,
  muteConversation, isConversationMuted,
  // exposed for tests / reuse
  normalize, keyFor, cleanText, looksLikeClientFact, sanitizeItems, isDecayed, renderMemories,
  pgStore, ensureSchema,
  ENABLED, OBSERVE, PROMOTE_AFTER, DECAY_DAYS, FACT_DECAY_DAYS,
};
