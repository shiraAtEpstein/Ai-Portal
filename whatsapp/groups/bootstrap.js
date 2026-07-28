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
const ingestDb = require('../ingest/db');
const processor = require('../ingest/processor');
const { BaileysGroupsProvider } = require('./provider');

// Fixed recipient for the "needs a human" alert, per operator's explicit
// choice — not tied to the general admin/notification-preferences system.
// Overridable via env without a code change if it ever needs to move.
const ALERT_EMAIL = process.env.WHATSAPP_DISCONNECT_EMAIL || 'shira@epsteinlaw.co.il';

let provider = null;
let accountId = null;
let latestQr = null; // cleared once status leaves 'auth_required'
let mailer = null; // nodemailer transporter, passed in from server.js
let lastStatus = null;
let hasEverConnected = false;
let alertedThisEpisode = false; // one email per "needs a human" episode, not per re-emit

async function start(transporter) {
  if (transporter) mailer = transporter;
  console.log(`[whatsapp/groups] boot: mailer=${!!mailer} alertEmail=${ALERT_EMAIL}`);
  if (provider) return provider; // already started

  const account = await db.getOrCreateAccount('WhatsApp groups monitor');
  if (!account) {
    console.warn('[whatsapp/groups] DATABASE_URL not set — WhatsApp groups connector disabled.');
    return null;
  }
  accountId = account.id;

  // Provision the ingestion tables (wa_contacts, processing_jobs) at boot,
  // rather than lazily on the first message. Two reasons: (1) you can query
  // them immediately instead of hitting "relation does not exist" before any
  // traffic, and (2) a future background processor can safely read them even
  // before the first message arrives. Best-effort — a failure here must not
  // stop the connector from starting.
  try {
    await ingestDb.ensureTables();
    console.log('[whatsapp/ingest] tables ensured at boot (wa_contacts, processing_jobs)');
  } catch (e) {
    console.error('[whatsapp/ingest] could not ensure tables at boot:', e.message);
  }

  provider = new BaileysGroupsProvider(accountId);

  provider.on('status', (status, detail) => {
    console.log(`[whatsapp/groups] status: ${status}`);
    if (status !== 'auth_required') latestQr = null;

    if (status === 'connected') {
      hasEverConnected = true;
      alertedThisEpisode = false; // recovered — arm the alert for next time
    } else if (status === 'auth_required' && hasEverConnected && !alertedThisEpisode) {
      // Only alert on a genuine drop from a working session, not the very
      // first-ever setup (nobody has connected yet, so an admin is already
      // at the screen scanning). Fires once per episode, not once per QR
      // re-emit while it sits waiting to be scanned.
      alertedThisEpisode = true;
      notifyNeedsHuman(detail).catch((e) =>
        console.warn('[whatsapp/groups] disconnect-alert email failed:', e.message)
      );
    }
    lastStatus = status;
  });
  provider.on('qr', (qr) => {
    latestQr = qr;
  });
  provider.on('group', (group) => {
    console.log(`[whatsapp/groups] group seen: ${group.name} (${group.provider_group_jid})`);
  });

  await provider.connect();
  startProcessorSchedule();
  return provider;
}

// Twice-a-day summary batch. Times are firm-local (Asia/Jerusalem), overridable
// via WHATSAPP_PROCESS_TIMES (comma-separated HH:MM). On-demand refresh
// (ensureDealFresh) covers anything asked about between runs. We check every few
// minutes and fire once per slot per day (tracked in memory).
let _scheduleTimer = null;
let _lastFiredSlot = null;
const PROCESS_TZ = 'Asia/Jerusalem';

function _processTimes() {
  return (process.env.WHATSAPP_PROCESS_TIMES || '07:00,14:00')
    .split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
}

function _localParts() {
  // HH:MM and YYYY-MM-DD in the firm timezone (runtime Date is fine here).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: PROCESS_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const hhmm = `${parts.hour}:${parts.minute}`;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { hhmm, date };
}

function startProcessorSchedule() {
  if (_scheduleTimer) return;
  const tick = () => {
    try {
      const { hhmm, date } = _localParts();
      const times = _processTimes();
      if (!times.includes(hhmm)) return;
      const slot = `${date} ${hhmm}`;
      if (_lastFiredSlot === slot) return; // already fired this slot today
      _lastFiredSlot = slot;
      console.log(`[whatsapp/processor] scheduled batch firing at ${slot} (${PROCESS_TZ})`);
      processor.processPendingDeals({ limit: 500 }).catch((e) =>
        console.error('[whatsapp/processor] scheduled batch failed:', e.message)
      );
    } catch (e) {
      console.error('[whatsapp/processor] schedule tick failed:', e.message);
    }
  };
  // Every 60s so we don't miss a one-minute slot window.
  _scheduleTimer = setInterval(tick, 60 * 1000);
  console.log(`[whatsapp/processor] schedule armed for ${_processTimes().join(', ')} (${PROCESS_TZ})`);
}

// Best-effort email to ALERT_EMAIL. Never throws into the caller — a
// failed notification should not affect the connector itself.
// Kill switch: WHATSAPP_DISCONNECT_EMAILS=0.
async function notifyNeedsHuman(detail) {
  if (process.env.WHATSAPP_DISCONNECT_EMAILS === '0') return;
  if (!mailer || !process.env.EMAIL_USER) return;
  const base = process.env.PORTAL_URL || process.env.APP_URL || process.env.BASE_URL || '';
  const statusUrl = base ? (base.replace(/\/$/, '') + '/api/admin/whatsapp-groups/status') : '/api/admin/whatsapp-groups/status';
  const qrUrl = base ? (base.replace(/\/$/, '') + '/api/admin/whatsapp-groups/qr') : '/api/admin/whatsapp-groups/qr';
  const body =
    'Hi,\n\n' +
    'The WhatsApp groups connector has disconnected and needs a human to rescan a QR code' +
    (detail ? (' (' + detail + ')') : '') + '. It will keep retrying on its own for ordinary ' +
    'network blips, but this specific state does not resolve without a rescan.\n\n' +
    'Check status: ' + statusUrl + '\n' +
    'Get the QR code (once status shows auth_required): ' + qrUrl + '\n\n' +
    '— Lawly · Epstein & Co.';
  await mailer.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: ALERT_EMAIL,
    subject: 'WhatsApp connector needs a rescan',
    text: body,
  }).catch((e) => console.warn('[whatsapp/groups] alert email to ' + ALERT_EMAIL + ' failed:', e.message));
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

// Read-only ingestion health for the admin endpoint: connection status, job
// counts, contact resolution, recent contacts, and recent offline windows.
async function getIngestHealth() {
  const status = await getStatus();
  const ingest = await ingestDb.stats({ recentLimit: 10 });
  let gaps = [];
  if (accountId) {
    try { gaps = await db.listConnectionGaps(accountId, 10); }
    catch (e) { console.error('[whatsapp/gap] listConnectionGaps failed:', e.message); }
  }
  return { status, ingest, recentGaps: gaps };
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
  alertedThisEpisode = false;
  await start();
  return { ok: true };
}

module.exports = { start, getStatus, getLatestQr, getGroups, reset, getIngestHealth };
