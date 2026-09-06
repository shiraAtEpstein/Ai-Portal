// ============================================================
// whatsapp/agent/db.js — tables for the WhatsApp responder.
// Self-provisioning (CREATE IF NOT EXISTS), same idiom as whatsapp/ingest/db.js.
//
//   wa_skills / wa_skill_active  — the agent's editable pages (voice, rules,
//                                  classify, compose). Content, versioned, with an
//                                  active pointer. Seeded by Shira through the Neon
//                                  SQL editor; edited later from the admin screen.
//   wa_answer_bank               — approved general answers (AB-01 …). Only
//                                  status='active' rows are ever shown to a client.
//   wa_drafts                    — one row per pipeline run: classifier output,
//                                  slots with sources, draft, validation result,
//                                  the four skill version ids. Never deleted.
//   wa_review_actions            — what a human did with a draft.
//
// Nothing here sends anything. There is no send path in this module.
// ============================================================
const { getPool } = require('../../db');

let ensured = false;
async function ensureTables() {
  if (ensured) return;
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS wa_skills (
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      body_md TEXT NOT NULL,
      tool_allowlist TEXT[] NOT NULL DEFAULT '{}',
      model TEXT,
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_by TEXT,
      approved_on DATE,
      review_due DATE,
      UNIQUE (key, version)
    );`);
  await p.query(`ALTER TABLE wa_skills ADD COLUMN IF NOT EXISTS approved_by TEXT;`);
  await p.query(`ALTER TABLE wa_skills ADD COLUMN IF NOT EXISTS approved_on DATE;`);
  await p.query(`ALTER TABLE wa_skills ADD COLUMN IF NOT EXISTS review_due DATE;`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wa_skill_active (
      key TEXT PRIMARY KEY,
      skill_id BIGINT NOT NULL REFERENCES wa_skills(id),
      activated_by TEXT NOT NULL,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wa_answer_bank (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'en',
      question_forms TEXT[] NOT NULL,
      answer_md TEXT NOT NULL,
      notes TEXT,
      support TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      approved_by TEXT,
      approved_on DATE,
      review_due DATE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wa_drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mode TEXT NOT NULL,                      -- 'offline' | 'shadow' | 'review'
      job_id UUID,                             -- processing_jobs.id when live; null offline
      chat_jid TEXT,
      deal_id UUID,
      message_text TEXT NOT NULL,
      outcome TEXT NOT NULL,                   -- 'dropped' | 'silence' | 'escalate' | 'draft' | 'blocked' | 'error'
      outcome_reason TEXT,
      classification JSONB,
      slots JSONB,                             -- { slot: { value, source } }
      answer_bank_code TEXT,
      draft_text TEXT,
      facts_used JSONB,
      validation JSONB,
      skill_versions JSONB,                    -- { voice: id, rules: id, classify: id, compose: id }
      model_classify TEXT,
      model_compose TEXT,
      tokens_in INT,
      tokens_out INT,
      reference_text TEXT,                     -- offline: what staff actually sent
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await p.query(`CREATE INDEX IF NOT EXISTS wa_drafts_created_idx ON wa_drafts (created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS wa_drafts_deal_idx ON wa_drafts (deal_id);`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wa_review_actions (
      id BIGSERIAL PRIMARY KEY,
      draft_id UUID NOT NULL REFERENCES wa_drafts(id),
      reviewer TEXT NOT NULL,
      action TEXT NOT NULL,                    -- 'approve' | 'edit' | 'reject'
      final_text TEXT,
      reject_reason TEXT,
      seconds_to_review INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  ensured = true;
}

// ---- skills ---------------------------------------------------------------
// Active pages, keyed by key. Cached by the set of active ids, so an activation
// in the admin screen (or the SQL editor) invalidates immediately.
let _skillsCache = null;
let _skillsCacheKey = '';
async function loadActiveSkills() {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT a.key, s.id, s.version, s.body_md, s.model, s.review_due
     FROM wa_skill_active a JOIN wa_skills s ON s.id = a.skill_id`
  );
  const key = r.rows.map((x) => x.key + ':' + x.id).sort().join('|');
  if (!_skillsCache || _skillsCacheKey !== key) {
    const out = {};
    for (const row of r.rows) {
      out[row.key] = { id: row.id, version: row.version, body: row.body_md, model: row.model || null, review_due: row.review_due ? String(row.review_due).slice(0, 10) : null, expired: false };
    }
    _skillsCache = out; _skillsCacheKey = key;
  }
  // `expired` is recomputed on every load (not at cache time) so a page whose
  // review_due passes while the process is running stops being used the same day.
  const today = new Date().toISOString().slice(0, 10);
  for (const k of Object.keys(_skillsCache)) _skillsCache[k].expired = !!(_skillsCache[k].review_due && _skillsCache[k].review_due < today);
  return _skillsCache;
}

// wa_drafts.job_id / deal_id are UUID columns. Offline runs pass synthetic ids
// ('offline-deal'); anything that is not a UUID is stored as NULL instead of
// making the INSERT throw.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v) { return v && UUID_RE.test(String(v)) ? String(v) : null; }

// ---- answer bank ----------------------------------------------------------
async function listAnswerBank({ activeOnly = true } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT code, topic, lang, question_forms, answer_md, notes, status, review_due
     FROM wa_answer_bank ${activeOnly ? `WHERE status = 'active' AND (review_due IS NULL OR review_due >= CURRENT_DATE)` : ''}
     ORDER BY code`
  );
  return r.rows;
}

// ---- drafts ---------------------------------------------------------------
async function insertDraft(d) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `INSERT INTO wa_drafts (mode, job_id, chat_jid, deal_id, message_text, outcome, outcome_reason, classification, slots,
       answer_bank_code, draft_text, facts_used, validation, skill_versions, model_classify, model_compose, tokens_in, tokens_out, reference_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [d.mode, uuidOrNull(d.job_id), d.chat_jid || null, uuidOrNull(d.deal_id), d.message_text, d.outcome, d.outcome_reason || null,
     d.classification ? JSON.stringify(d.classification) : null, d.slots ? JSON.stringify(d.slots) : null,
     d.answer_bank_code || null, d.draft_text || null, d.facts_used ? JSON.stringify(d.facts_used) : null,
     d.validation ? JSON.stringify(d.validation) : null, d.skill_versions ? JSON.stringify(d.skill_versions) : null,
     d.model_classify || null, d.model_compose || null, d.tokens_in || null, d.tokens_out || null, d.reference_text || null]
  );
  return r.rows[0] && r.rows[0].id;
}

async function recordReview({ draft_id, reviewer, action, final_text, reject_reason, seconds_to_review }) {
  await ensureTables();
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `INSERT INTO wa_review_actions (draft_id, reviewer, action, final_text, reject_reason, seconds_to_review)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [draft_id, reviewer, action, final_text || null, reject_reason || null, seconds_to_review || null]
  );
  return r.rows[0] && r.rows[0].id;
}

// The five or so numbers the learning loop starts from.
async function outcomeStats({ days = 7 } = {}) {
  await ensureTables();
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT mode, outcome, classification->>'type' AS type, count(*)::int AS n
     FROM wa_drafts WHERE created_at > now() - make_interval(days => $1::int)
     GROUP BY 1,2,3 ORDER BY 1,3,2`, [Math.max(1, parseInt(days, 10) || 7)]
  );
  return r.rows;
}

module.exports = { ensureTables, loadActiveSkills, listAnswerBank, insertDraft, recordReview, outcomeStats };
