// ============================================================
// whatsapp/groups/owner-lease.js — only ONE server may hold the WhatsApp
// connection at a time (2026-10-05).
//
// Why: WhatsApp allows one connection per linked device. During a Render
// deploy the old and new server run side by side for up to ~1 minute (more
// if two deploys land back to back), and both connected — WhatsApp kicked
// one ("stream:error conflict/replaced"), it reconnected and kicked the
// other, and both wrote the encryption keys (the source of "Bad MAC").
//
// How: a one-row "lease" table in Postgres. The server that holds the lease
// renews it every RENEW_MS. A new server waits until the lease is free —
// released by the old server on shutdown, or expired because the old server
// stopped renewing (it was killed) — and only then connects WhatsApp. If a
// server finds that someone else now owns the lease, it closes its own
// WhatsApp connection immediately.
//
// A row lease (not pg_advisory_lock) on purpose: it works through Neon's
// connection pooler, where session locks are not reliable.
// ============================================================
const crypto = require('crypto');
const { getPool } = require('../../db');

const RENEW_MS = 10 * 1000;
const EXPIRE_SECONDS = Math.max(15, parseInt(process.env.WA_LEASE_EXPIRE_SECONDS || '35', 10));
const ME = `${process.env.RENDER_INSTANCE_ID || 'local'}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

let _held = false;
let _renewTimer = null;
let _onLost = null;
let _ensured = false;

async function ensureTable(pool) {
  if (_ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_owner_lease (
    id int PRIMARY KEY,
    owner text,
    renewed_at timestamptz
  )`);
  await pool.query(`INSERT INTO whatsapp_owner_lease (id, owner, renewed_at) VALUES (1, NULL, NULL)
                    ON CONFLICT (id) DO NOTHING`);
  _ensured = true;
}

// One attempt. True if this server now holds the lease.
async function tryClaim() {
  const pool = getPool();
  if (!pool) return true; // no database -> nothing to coordinate
  await ensureTable(pool);
  const r = await pool.query(
    `UPDATE whatsapp_owner_lease SET owner = $1, renewed_at = now()
      WHERE id = 1 AND (owner IS NULL OR owner = $1
                        OR renewed_at IS NULL OR renewed_at < now() - ($2 || ' seconds')::interval)
      RETURNING owner`,
    [ME, String(EXPIRE_SECONDS)]
  );
  return r.rowCount === 1;
}

// Waits (checking every 5s) until the lease is ours. Logs once while waiting.
async function acquire(isCancelled) {
  let logged = false;
  for (;;) {
    if (isCancelled && isCancelled()) return false;
    try {
      if (await tryClaim()) {
        _held = true;
        console.log(`[whatsapp/lease] this server now owns the WhatsApp connection${logged ? ' (the previous server let go)' : ''}`);
        return true;
      }
      if (!logged) {
        console.log(`[whatsapp/lease] another server still owns WhatsApp — waiting for it to stop (up to ~${EXPIRE_SECONDS}s after it dies)`);
        logged = true;
      }
    } catch (e) {
      console.warn('[whatsapp/lease] claim failed (will retry):', e.message);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// Renews every RENEW_MS. If another server took over, calls onLost once.
// A database error is NOT a loss (we keep the connection; renewal retries).
function startRenewing(onLost) {
  _onLost = onLost;
  if (_renewTimer) return;
  _renewTimer = setInterval(async () => {
    if (!_held) return;
    try {
      const pool = getPool();
      if (!pool) return;
      const r = await pool.query(
        `UPDATE whatsapp_owner_lease SET renewed_at = now() WHERE id = 1 AND owner = $1`, [ME]
      );
      if (r.rowCount === 0) {
        _held = false;
        console.warn('[whatsapp/lease] another server took over WhatsApp — closing this connection');
        clearInterval(_renewTimer); _renewTimer = null;
        try { _onLost && _onLost(); } catch (_) {}
      }
    } catch (e) {
      console.warn('[whatsapp/lease] renew failed (will retry):', e.message);
    }
  }, RENEW_MS);
  if (_renewTimer.unref) _renewTimer.unref();
}

function isHeld() { return _held; }

// On shutdown: free the lease right away so the new server connects without
// waiting for it to expire.
async function release() {
  if (_renewTimer) { clearInterval(_renewTimer); _renewTimer = null; }
  if (!_held) return;
  _held = false;
  try {
    const pool = getPool();
    if (pool) await pool.query(`UPDATE whatsapp_owner_lease SET owner = NULL, renewed_at = NULL WHERE id = 1 AND owner = $1`, [ME]);
    console.log('[whatsapp/lease] released');
  } catch (e) {
    console.warn('[whatsapp/lease] release failed (it will expire on its own):', e.message);
  }
}

module.exports = { acquire, startRenewing, release, isHeld, tryClaim, ME };
