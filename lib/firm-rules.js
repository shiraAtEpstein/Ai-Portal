// ============================================================
// lib/firm-rules.js — §9 of the framework: FIRM-RULE CHANGE APPROVAL FLOW.
//
// Staff can PROPOSE a change to the firm-wide house rules — explicitly via a
// form, or by stating a durable firm-wide directive in chat (auto-detected).
// Every proposal is STAGED as a pending request and changes NOTHING until an
// admin APPROVES it. On approval the rule is written to a versioned DB table
// and injected into every chat's Firm-Core preamble, taking precedence over the
// Dropbox house-rules file (which the portal can only read, not write).
//
// Mirrors lib/memory.js conventions: encrypted at rest (lib/crypto), opaque
// SHA-256 dedup keys, self-provisioning tables (CREATE TABLE IF NOT EXISTS),
// and an injectable store + infer so the whole flow unit-tests with no DB and
// no network. Fail-safe: any error is swallowed so chat never breaks.
// ============================================================
const crypto = require('crypto');
const enc = require('./crypto');
let db = null;
try { db = require('../db'); } catch (_) { db = null; } // absent in unit tests

const ENABLED = process.env.FIRM_RULES_ENABLED !== '0';
const DETECT = process.env.FIRM_RULES_DETECT !== '0';   // chat auto-detection
const MAX_TEXT = parseInt(process.env.FIRM_RULES_MAX_TEXT || '600', 10);
const MAX_ACTIVE = parseInt(process.env.FIRM_RULES_MAX_ACTIVE || '50', 10);
const MODEL = process.env.FIRM_RULES_MODEL || 'claude-haiku-4-5-20251001';

// ---------- pure helpers (unit-tested directly) ----------
function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function keyFor(text) { return crypto.createHash('sha256').update(normalize(text)).digest('hex'); }
function cleanText(t) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); }

// A firm-wide directive worth proposing? Conservative prefilter for chat
// detection: requires firm-scope phrasing so a personal preference is not
// mistaken for a firm rule. English + Hebrew.
const FIRM_SCOPE_RE = /(from now on|going forward|as a firm|firm policy|firm rule|everyone (?:should|must|needs)|all staff|the whole (?:firm|office)|make it (?:a )?(?:rule|policy)|company policy|office policy|מעכשיו|מהיום ואילך|כל הצוות|כל המשרד|כלל משרדי|מדיניות המשרד|נוהל משרדי|כולם צריכים|כולם חייבים)/i;
function looksLikeFirmRule(text) { return FIRM_SCOPE_RE.test(String(text || '')); }

// Render approved updates as an authoritative preamble block.
function renderActiveRules(items) {
  if (!items || !items.length) return '';
  return [
    '===== APPROVED FIRM-RULE UPDATES (authoritative — take precedence over the firm rules above) =====',
    'These changes were proposed by staff and APPROVED by a firm admin. They',
    'OVERRIDE anything conflicting in the firm rules above. Apply them exactly.',
    '',
    ...items.map((i) => '- ' + i.text),
  ].join('\n');
}

// ---------- default detector (LLM); injectable for tests ----------
let _client = null;
function anthropic() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}
async function defaultInfer({ userText }) {
  const client = anthropic();
  const sys = [
    'A staff member at a law firm may be stating a NEW FIRM-WIDE rule/policy that should',
    'apply to EVERYONE and every chat — not a personal preference, not a one-off request,',
    'not a client/matter fact. If and ONLY if the user is clearly proposing such a durable',
    'firm-wide rule, return it as a single clear imperative sentence. Otherwise return "".',
    'STRICT: a personal style preference ("reply to ME in Hebrew") is NOT a firm rule.',
    'A client/matter fact (names, amounts, deals, dates) is NOT a firm rule. When unsure, "".',
    'Output STRICT JSON only: {"rule":"<the firm-wide rule, or empty string>"}. No prose.',
  ].join('\n');
  const user = 'The staff member wrote:\n' + String(userText || '').slice(0, 1500) +
    '\n\nReturn {"rule":"..."} with the firm-wide rule, or {"rule":""} if this is not one.';
  const r = await client.messages.create({ model: MODEL, max_tokens: 200, system: sys, messages: [{ role: 'user', content: user }] });
  return (r.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
}
function parseRule(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    try { obj = JSON.parse(m ? m[0] : raw); } catch (_) { return ''; }
  }
  if (!obj || typeof obj !== 'object') return '';
  return cleanText(obj.rule || '');
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
    await pool.query(`CREATE TABLE IF NOT EXISTS firm_rule_requests (
      id bigserial PRIMARY KEY,
      norm_key text NOT NULL,
      proposal_enc text NOT NULL,
      source text NOT NULL DEFAULT 'form',
      agent_id text,
      requested_by uuid,
      requested_by_name text,
      requested_by_email text,
      status text NOT NULL DEFAULT 'pending',
      decided_by uuid,
      decided_by_name text,
      decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS firm_rules (
      id bigserial PRIMARY KEY,
      version int NOT NULL,
      rule_enc text NOT NULL,
      request_id bigint,
      approved_by uuid,
      approved_by_name text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );`);
  })().catch((e) => { _ensured = null; throw e; });
  return _ensured;
}

const pgStore = {
  async findPendingByKey(key) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query("SELECT id FROM firm_rule_requests WHERE norm_key=$1 AND status='pending' LIMIT 1", [key]);
    return r.rowCount ? r.rows[0].id : null;
  },
  async insertRequest(row) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query(
      `INSERT INTO firm_rule_requests (norm_key, proposal_enc, source, agent_id, requested_by, requested_by_name, requested_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [row.key, enc.encrypt(row.text), row.source, row.agentId || null, row.userId || null, row.name || null, row.email || null]);
    return r.rows[0].id;
  },
  async getRequest(id) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query('SELECT * FROM firm_rule_requests WHERE id=$1', [id]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return { id: row.id, text: enc.decrypt(row.proposal_enc), source: row.source, agentId: row.agent_id,
      status: row.status, requestedByName: row.requested_by_name, requestedByEmail: row.requested_by_email, createdAt: row.created_at };
  },
  async listPending() {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query("SELECT * FROM firm_rule_requests WHERE status='pending' ORDER BY created_at ASC");
    return r.rows.map((row) => ({ id: row.id, text: enc.decrypt(row.proposal_enc), source: row.source,
      requestedByName: row.requested_by_name, requestedByEmail: row.requested_by_email, createdAt: row.created_at }));
  },
  async listRecent(limit) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query('SELECT * FROM firm_rule_requests ORDER BY created_at DESC LIMIT $1', [limit || 50]);
    return r.rows.map((row) => ({ id: row.id, text: enc.decrypt(row.proposal_enc), source: row.source, status: row.status,
      requestedByName: row.requested_by_name, requestedByEmail: row.requested_by_email,
      decidedByName: row.decided_by_name, decidedAt: row.decided_at, createdAt: row.created_at }));
  },
  async setStatus(id, status, deciderId, deciderName) {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query(
      "UPDATE firm_rule_requests SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=now() WHERE id=$1 AND status='pending'",
      [id, status, deciderId || null, deciderName || null]);
    return r.rowCount > 0;
  },
  async insertActiveRule({ requestId, text, approvedById, approvedByName }) {
    const p = getPool(); await ensureSchema(p);
    const v = await p.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM firm_rules');
    const version = v.rows[0].v;
    await p.query(
      `INSERT INTO firm_rules (version, rule_enc, request_id, approved_by, approved_by_name)
       VALUES ($1,$2,$3,$4,$5)`, [version, enc.encrypt(text), requestId || null, approvedById || null, approvedByName || null]);
    return version;
  },
  async listActiveRules() {
    const p = getPool(); await ensureSchema(p);
    const r = await p.query('SELECT version, rule_enc, created_at FROM firm_rules WHERE active=true AND revoked_at IS NULL ORDER BY created_at ASC');
    return r.rows.map((row) => ({ version: row.version, text: enc.decrypt(row.rule_enc), createdAt: row.created_at }));
  },
};

// ---------- orchestration (store + infer injectable) ----------
async function submitRequest(opts = {}) {
  const store = opts.store || pgStore;
  const text = cleanText(opts.text);
  if (!ENABLED || !text) return { ok: false, error: 'empty' };
  const key = keyFor(text);
  try {
    const existing = await store.findPendingByKey(key);
    if (existing) return { ok: true, id: existing, status: 'pending', duplicate: true };
    const id = await store.insertRequest({ key, text, source: opts.source === 'chat' ? 'chat' : 'form',
      agentId: opts.agentId, userId: opts.userId, name: opts.name, email: opts.email });
    return { ok: true, id, status: 'pending', duplicate: false };
  } catch (e) { console.error('[FIRM-RULES] submit failed:', e.message); return { ok: false, error: 'store' }; }
}

// Background chat detection: prefilter for firm-scope phrasing, then confirm via
// the injectable inferer, then file a pending request. Never auto-applies.
async function detectFromChat(opts = {}) {
  if (!ENABLED || !DETECT) return { filed: false };
  const text = String(opts.userText || '');
  if (!looksLikeFirmRule(text)) return { filed: false };
  const store = opts.store || pgStore;
  const infer = opts.infer || defaultInfer;
  let rule = '';
  try { rule = parseRule(await infer({ userText: text })); }
  catch (e) { console.error('[FIRM-RULES] detect infer failed:', e.message); return { filed: false }; }
  if (!rule) return { filed: false };
  const r = await submitRequest({ store, text: rule, source: 'chat', agentId: opts.agentId, userId: opts.userId, name: opts.name, email: opts.email });
  return { filed: !!(r && r.ok && !r.duplicate), duplicate: !!(r && r.duplicate), text: rule };
}

async function listPending(opts = {}) {
  const store = opts.store || pgStore;
  try { return await store.listPending(); } catch (e) { console.error('[FIRM-RULES] listPending failed:', e.message); return []; }
}
async function listRecent(opts = {}) {
  const store = opts.store || pgStore;
  try { return await store.listRecent(opts.limit || 50); } catch (e) { console.error('[FIRM-RULES] listRecent failed:', e.message); return []; }
}
async function approve(id, opts = {}) {
  const store = opts.store || pgStore;
  try {
    const req = await store.getRequest(id);
    if (!req || req.status !== 'pending') return { ok: false, error: 'not_pending' };
    const ok = await store.setStatus(id, 'approved', opts.adminId, opts.adminName);
    if (!ok) return { ok: false, error: 'not_pending' };
    const version = await store.insertActiveRule({ requestId: id, text: req.text, approvedById: opts.adminId, approvedByName: opts.adminName });
    return { ok: true, version, text: req.text };
  } catch (e) { console.error('[FIRM-RULES] approve failed:', e.message); return { ok: false, error: 'store' }; }
}
async function reject(id, opts = {}) {
  const store = opts.store || pgStore;
  try { return { ok: await store.setStatus(id, 'rejected', opts.adminId, opts.adminName) }; }
  catch (e) { console.error('[FIRM-RULES] reject failed:', e.message); return { ok: false, error: 'store' }; }
}
async function loadActiveRules(opts = {}) {
  if (!ENABLED) return { text: '', items: [] };
  const store = opts.store || pgStore;
  let rows = [];
  try { rows = await store.listActiveRules(); }
  catch (e) { console.error('[FIRM-RULES] loadActiveRules failed:', e.message); return { text: '', items: [] }; }
  const items = rows.slice(-MAX_ACTIVE).map((r) => ({ text: r.text, version: r.version }));
  return { text: renderActiveRules(items), items };
}

module.exports = {
  submitRequest, detectFromChat, listPending, listRecent, approve, reject, loadActiveRules,
  normalize, keyFor, cleanText, looksLikeFirmRule, parseRule, renderActiveRules,
  pgStore, ensureSchema, ENABLED, DETECT,
};
