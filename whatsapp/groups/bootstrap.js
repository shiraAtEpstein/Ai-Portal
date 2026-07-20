// ============================================================
// whatsapp/groups/bootstrap.js — wiring, not logic.
//
// Creates (or loads) the single WhatsApp groups account row, starts the
// Baileys provider, and keeps the latest QR/status in memory so the
// admin route (routes/whatsapp-groups.js) can serve them without holding
// a reference to the live socket itself.
//
// This is the one place in the codebase that imports both db.js and
// provider.js together — routes/ and any future LAWLY ingestion code
// should go through the exports here, not reach into whatsapp/groups/*
// directly.
// ============================================================
const db = require('./db');
const { BaileysGroupsProvider } = require('./provider');

let provider = null;
let accountId = null;
let latestQr = null; // cleared once status leaves 'auth_required'

async function start() {
  if (provider) return provider; // already started

  const account = await db.getOrCreateAccount('WhatsApp groups monitor');
  if (!account) {
    console.warn('[whatsapp/groups] DATABASE_URL not set — WhatsApp groups connector disabled.');
    return null;
  }
  accountId = account.id;

  provider = new BaileysGroupsProvider(accountId);

  provider.on('status', (status) => {
    console.log(`[whatsapp/groups] status: ${status}`);
    if (status !== 'auth_required') latestQr = null;
  });
  provider.on('qr', (qr) => {
    latestQr = qr;
  });
  provider.on('group', (group) => {
    console.log(`[whatsapp/groups] group seen: ${group.name} (${group.provider_group_jid})`);
  });

  await provider.connect();
  return provider;
}

async function getStatus() {
  if (!accountId) return { status: 'not_configured' };
  const row = await db.getAccountStatus(accountId);
  return {
    status: row ? row.status : 'unknown',
    detail: row ? row.status_detail : null,
    lastConnectedAt: row ? row.last_connected_at : null,
    hasQr: row && row.status === 'auth_required' && !!latestQr,
  };
}

function getLatestQr() {
  return latestQr;
}

async function getGroups() {
  if (!accountId) return [];
  return db.listGroups(accountId);
}

// Clears a corrupted/stuck session and forces a fresh QR. Disconnects the
// live socket (if any), wipes the stored auth state, then reconnects —
// Baileys' initAuthCreds() kicks in on the next connect() since
// loadAuthState() will now return null.
async function reset() {
  if (!accountId) return { ok: false, error: 'not_configured' };
  if (provider) {
    try {
      await provider.disconnect();
    } catch (e) {
      console.warn('[whatsapp/groups] disconnect during reset failed:', e.message);
    }
  }
  await db.resetAuthState(accountId);
  latestQr = null;
  provider = null;
  await start();
  return { ok: true };
}

module.exports = { start, getStatus, getLatestQr, getGroups, reset };
