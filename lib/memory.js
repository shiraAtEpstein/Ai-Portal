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

// Defense in depth: even if the extractor slips, drop anything that looks like a
// client/matter fact rather than a durable preference. Preferences only.
function looksLikeClientFact(text) {
  const t = String(text || '').toLowerCase();
  if (/[₪$€]|\d{3,}/.test(t)) return true;                       // money / long numbers
  if (/\b(deal|client|matter|contract|apartment|purchase|invoice|payment|address|phone)\b/.test(t)) return true;
  if (/(עסקה|לקוח|תיק|חוזה|דירה|תשלום|חשבונית|כתובת|טלפון)/.test(t)) return true;
  return false;
}

// Parse + validate the extractor output into [{action, text}].
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
    const action = String(it.action || 'prefer').toLowerCase();
    if (!['prefer', 'confirm', 'forget'].includes(action)) continue;
    const text = cleanText(it.text != null ? it.text : it.preference);
    if (!text) continue;
    if (action !== 'forget' && looksLikeClientFact(text)) continue; // never store the "what"
    out.push({ action, text });
  }
  return out.slice(0, 5);
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
  const sys = [
    'You extract STABLE PERSONAL WORKING/STYLE PREFERENCES of the user from one chat exchange,',
    "for a law-firm assistant's long-term memory. STRICT RULES:",
    '1. Output ONLY durable preferences about HOW the user likes the assistant to work —',
    '   tone, language, formatting, length, structure, salutations, reasoning style.',
    '2. NEVER output client names, matter/deal facts, numbers, amounts, dates, addresses,',
    '   tasks, or anything specific to one case. Those are forbidden.',
    '3. action="confirm" if the user explicitly asked to remember something;',
    '   action="forget" if they asked to stop/forget something; otherwise action="prefer".',
    '4. If there is no clear durable preference, return [].',
    'Output STRICT JSON only: [{"action":"prefer|confirm|forget","text":"<short imperative preference>"}].',
    'Max 3 items. No prose.',
  ].join('\n');
  const user = 'USER said:\n' + String(userText || '').slice(0, 2000) +
    '\n\nASSISTANT replied:\n' + String(assistantText || '').slice(0, 1500) +
    '\n\nExtract durable preferences as JSON.';
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

// Observe one exchange: stage/promote/confirm/forget. Fire-and-forget from chat.
async function observe(userId, opts = {}) {
  const res = { staged: 0, promoted: 0, confirmed: 0, forgotten: 0 };
  if (!ENABLED || !OBSERVE || !userId) return res;
  const store = opts.store || pgStore;
  const infer = opts.infer || defaultInfer;
  let raw;
  try { raw = await infer({ userText: opts.userText, assistantText: opts.assistantText }); }
  catch (e) { console.error('[MEMORY] infer failed:', e.message); return res; }
  for (const it of sanitizeItems(raw)) {
    const key = keyFor(it.text);
    try {
      if (it.action === 'forget') { await store.revoke(userId, key); res.forgotten++; continue; }
      if (it.action === 'confirm') { await store.upsertConfirmed(userId, key, it.text, 'confirmed'); res.confirmed++; continue; }
      if (await store.hasMemory(userId, key)) { await store.reaffirm(userId, key); continue; } // already trusted
      const c = await store.bumpOrInsertCandidate(userId, key, it.text);
      if (c && c.seen_count >= PROMOTE_AFTER && c.status !== 'promoted') {
        await store.upsertConfirmed(userId, key, it.text, 'promoted');
        await store.markCandidatePromoted(userId, key);
        res.promoted++;
      } else { res.staged++; }
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

// Read-only: the full memory picture for a user (trusted + staged), for the
// admin viewer. Fail-safe: returns empties on any error.
async function listForUser(userId, opts = {}) {
  if (!userId) return { trusted: [], staged: [] };
  const store = opts.store || pgStore;
  try { return await store.adminListForUser(userId); }
  catch (e) { console.error('[MEMORY] admin list failed:', e.message); return { trusted: [], staged: [] }; }
}

module.exports = {
  loadForUser, observe, remember, forget, listForUser,
  // exposed for tests / reuse
  normalize, keyFor, cleanText, looksLikeClientFact, sanitizeItems, isDecayed, renderMemories,
  pgStore, ensureSchema,
  ENABLED, OBSERVE, PROMOTE_AFTER, DECAY_DAYS,
};
