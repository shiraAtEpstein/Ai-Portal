// ============================================================
// lib/calendar.js — per-user Google Calendar connection.
//
// Mirrors lib/gmail.js. Each user connects their own Google Calendar once,
// through Google's consent screen. We keep only a REFRESH TOKEN, encrypted
// with the existing CHAT_ENC_KEY (so it sits encrypted in Neon; the key lives
// in Render). Scopes: read events + create/edit events (no calendar deletion,
// no sharing changes). A create is a real write, so the agent must confirm
// with the user before calling calendar_create.
//
// Self-contained: reuses db.getPool() for the connection pool and lib/crypto
// for encryption, but does NOT modify db.js.
// ============================================================
const { OAuth2Client } = require('google-auth-library');
const { getPool } = require('../db');
const enc = require('./crypto');

// Self-provisioning table (same convention as the memory/settings stores):
// the connection table creates itself on first use, so there is no manual
// migration to run in Neon.
let _ready = false;
async function ensureTable() {
  const p = getPool();
  if (!p) return false;
  if (_ready) return true;
  await p.query(
    `CREATE TABLE IF NOT EXISTS calendar_connections (
       user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       refresh_token_enc text NOT NULL,
       email             text,
       scope             text,
       connected_at      timestamptz NOT NULL DEFAULT now(),
       updated_at        timestamptz NOT NULL DEFAULT now()
     )`);
  _ready = true;
  return true;
}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com';
const CALLBACK_URL = process.env.CALENDAR_CALLBACK_URL || (BASE_URL + '/auth/calendar/callback');

// Read events + create/edit events. calendar.readonly lets us list events and
// calendars; calendar.events lets us create/update events. No delete scope.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
];

function configured() { return !!(CLIENT_ID && CLIENT_SECRET); }

// Does a stored connection carry the events (write) scope? Connections made
// before write was added are read-only: Google issued the refresh token
// against the OLD scope list, and re-asking is the only fix.
function hasWriteScope(scope) {
  return /calendar\.events|auth\/calendar(?![.\w])/.test(String(scope || ''));
}

function oauthClient() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, CALLBACK_URL);
}

// The Google consent URL the user is sent to. access_type=offline +
// prompt=consent guarantees we receive a refresh token every time.
function consentUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });
}

// Exchange the one-time code for tokens. Returns { refreshToken, email, scope }.
async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  let email = null;
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
      email = (payload.email || '').toLowerCase() || null;
    } catch (_) { /* ignore */ }
  }
  return { refreshToken: tokens.refresh_token || null, email, scope: tokens.scope || '' };
}

// --- storage (own table; refresh token encrypted at rest) -------------
async function saveConnection(userId, { refreshToken, email, scope }) {
  const p = getPool();
  if (!p) throw new Error('database unavailable');
  await ensureTable();
  if (!refreshToken) throw new Error('no refresh token returned');
  await p.query(
    `INSERT INTO calendar_connections (user_id, refresh_token_enc, email, scope, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       email             = EXCLUDED.email,
       scope             = EXCLUDED.scope,
       updated_at        = now()`,
    [userId, enc.encrypt(refreshToken), email, scope]);
}

async function getConnection(userId) {
  const p = getPool();
  if (!p) return null;
  await ensureTable();
  const r = await p.query(
    'SELECT user_id, refresh_token_enc, email, scope, connected_at FROM calendar_connections WHERE user_id = $1',
    [userId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { userId: row.user_id, refreshToken: enc.decrypt(row.refresh_token_enc), email: row.email, scope: row.scope, connectedAt: row.connected_at };
}

// { connected, email, canWrite } for the UI — no token is touched.
async function connectionStatus(userId) {
  const p = getPool();
  if (!p) return { connected: false, email: null, canWrite: false };
  await ensureTable();
  const r = await p.query('SELECT email, scope FROM calendar_connections WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  if (!row) return { connected: false, email: null, canWrite: false };
  return { connected: true, email: row.email || null, canWrite: hasWriteScope(row.scope) };
}

async function isConnected(userId) {
  const p = getPool();
  if (!p) return false;
  await ensureTable();
  const r = await p.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [userId]);
  return !!r.rows[0];
}

async function deleteConnection(userId) {
  const p = getPool();
  if (!p) return false;
  await ensureTable();
  const r = await p.query('DELETE FROM calendar_connections WHERE user_id = $1', [userId]);
  return (r.rowCount || 0) > 0;
}

// The portal email of a user (to verify the connected Google account matches).
async function getUserEmail(userId) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query('SELECT email FROM users WHERE id = $1', [userId]);
  return r.rows[0] ? String(r.rows[0].email || '').toLowerCase() : null;
}

// An OAuth client pre-loaded with this user's refresh token. Returns null if
// the user has not connected (or the token can't be decrypted).
async function authedClientFor(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  return client;
}

// --- reading events ----------------------------------------------------

function fmtWhen(ev, key) {
  const t = ev[key] || {};
  if (t.dateTime) {
    try { return new Date(t.dateTime).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return t.dateTime; }
  }
  return t.date ? (t.date + ' (all day)') : '';
}

function renderEvents(events) {
  if (!events.length) return 'No events found in that range.';
  return events.map(function (ev, i) {
    const who = (ev.attendees || []).map(function (a) { return a.email; }).filter(Boolean).join(', ');
    let block = (i + 1) + '. ' + (ev.summary || '(no title)') +
      '\n   Start: ' + fmtWhen(ev, 'start') +
      '\n   End:   ' + fmtWhen(ev, 'end');
    if (ev.location) block += '\n   Where: ' + ev.location;
    if (who) block += '\n   With:  ' + who;
    if (ev.description) block += '\n   Notes: ' + String(ev.description).replace(/\n/g, ' ').slice(0, 300);
    return block;
  }).join('\n\n');
}

// List the signed-in user's OWN upcoming (or queried) events. Read-only.
// Returns { connected, count, events, text }.
async function listEvents(userId, opts) {
  opts = opts || {};
  const cap = Math.min(Math.max(parseInt(opts.maxResults, 10) || 10, 1), 25);
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) {
    return { connected: false, calendar: null, count: 0, events: [], text: 'Google Calendar is not connected for this user. Ask them to click "Connect Calendar" first.' };
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  const params = new URLSearchParams({
    maxResults: String(cap),
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: opts.timeMin || new Date().toISOString(),
  });
  if (opts.timeMax) params.set('timeMax', opts.timeMax);
  if (opts.query) params.set('q', String(opts.query));
  try {
    const r = await client.request({
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params.toString(),
    });
    const events = (r.data && r.data.items) || [];
    const header = conn.email ? ('Calendar being read: ' + conn.email + '\n\n') : '';
    return { connected: true, calendar: conn.email || null, count: events.length, events, text: header + renderEvents(events) };
  } catch (e) {
    const msg = (e && e.message) || 'unknown error';
    if (/invalid_grant|unauthorized|401/i.test(msg)) {
      return { connected: false, calendar: conn.email || null, count: 0, events: [], text: 'Calendar permission has expired or was revoked. Ask the user to reconnect Calendar.' };
    }
    throw e;
  }
}

// Create an event on the signed-in user's PRIMARY calendar. This is a real
// write — the agent must confirm details with the user before calling it.
// times are ISO 8601 strings. Requires the calendar.events scope.
async function createEvent(userId, opts) {
  opts = opts || {};
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) {
    return { ok: false, error: 'Google Calendar is not connected for this user.' };
  }
  if (!hasWriteScope(conn.scope)) {
    return { ok: false, scope: true, error: 'create permission missing - reconnect Calendar to grant event-creation access' };
  }
  const summary = String(opts.summary || '').trim();
  const start = String(opts.start || '').trim();
  const end = String(opts.end || '').trim();
  if (!summary) return { ok: false, error: 'an event title (summary) is required' };
  if (!start || !end) return { ok: false, error: 'both a start and end time are required (ISO 8601)' };

  const tz = opts.timeZone || 'Asia/Jerusalem';
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  const body = {
    summary,
    start: allDay ? { date: start } : { dateTime: start, timeZone: tz },
    end: allDay ? { date: end } : { dateTime: end, timeZone: tz },
  };
  if (opts.description) body.description = String(opts.description);
  if (opts.location) body.location = String(opts.location);
  if (Array.isArray(opts.attendees) && opts.attendees.length) {
    body.attendees = opts.attendees.map(function (a) { return { email: String(a) }; });
  }

  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  try {
    const r = await client.request({
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      method: 'POST',
      data: body,
    });
    return { ok: true, id: (r.data && r.data.id) || null, htmlLink: (r.data && r.data.htmlLink) || null, calendar: conn.email || null, summary, start, end };
  } catch (e) {
    const msg = (e && e.message) || 'unknown error';
    if (/insufficient|scope|403|permission|ACCESS_TOKEN_SCOPE/i.test(msg)) {
      return { ok: false, scope: true, error: 'create permission missing - reconnect Calendar to grant event-creation access' };
    }
    if (/invalid_grant|unauthorized|401/i.test(msg)) {
      return { ok: false, error: 'Calendar permission expired - reconnect Calendar' };
    }
    return { ok: false, error: msg };
  }
}

module.exports = {
  configured, consentUrl, exchangeCode,
  saveConnection, getConnection, isConnected, connectionStatus, hasWriteScope, deleteConnection, authedClientFor,
  listEvents, createEvent, getUserEmail,
  SCOPES, CALLBACK_URL,
};
