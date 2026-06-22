// ============================================================
// db.js — PostgreSQL (Neon) connection + helpers
// Added for Phase 2 (auth & connections). Safe to load even when
// DATABASE_URL is unset: every helper degrades gracefully so the
// existing email/password login keeps working with no database.
// ============================================================
const { Pool } = require('pg');

let pool = null;

// Neon (and any non-local host) requires SSL. A local Postgres used
// for testing does not, so we switch SSL off for localhost/127.0.0.1.
function sslFor(url) {
  if (!url) return false;
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[DB] DATABASE_URL not set — database features are disabled.');
    return null;
  }
  pool = new Pool({ connectionString: url, ssl: sslFor(url) });
  pool.on('error', (e) => console.error('[DB] idle client error:', e.message));
  return pool;
}

// Simple connectivity check used at startup and by /healthz.
async function ping() {
  const p = getPool();
  if (!p) return false;
  await p.query('SELECT 1');
  return true;
}

// Insert or update the canonical identity row on each Google login.
// Keyed by google_sub (the stable Google user id). Returns the row's uuid.
async function upsertUserOnLogin({ googleSub, email, name }) {
  const p = getPool();
  if (!p) return null;
  const sql = `
    INSERT INTO users (google_sub, email, display_name, status, last_login_at)
    VALUES ($1, $2, $3, 'active', now())
    ON CONFLICT (google_sub) DO UPDATE
      SET email         = EXCLUDED.email,
          display_name  = EXCLUDED.display_name,
          last_login_at = now()
    RETURNING id;`;
  const r = await p.query(sql, [googleSub, email, name]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Append-only audit log writer. Never throws into the request path —
// callers wrap it, but we also swallow here so logging can't block login.
async function writeAudit({ actorId = null, action, targetType = null, targetId = null, metadata = {} }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, action, targetType, targetId, JSON.stringify(metadata)]
    );
  } catch (e) {
    console.error('[DB] audit write failed:', e.message);
  }
}

module.exports = { getPool, ping, upsertUserOnLogin, writeAudit };
