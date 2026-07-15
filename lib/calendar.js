const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { getPool } = require('../db');
const enc = require('./crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com';
const CALLBACK_URL = process.env.CALENDAR_CALLBACK_URL || (BASE_URL + '/auth/calendar/callback');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
];

function configured() { return !!(CLIENT_ID && CLIENT_SECRET); }

function oauthClient() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, CALLBACK_URL);
}

function consentUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });
}

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

async function saveConnection(userId, { refreshToken, email, scope }) {
  const p = getPool();
  if (!p) throw new Error('database unavailable');
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
  const r = await p.query(
    'SELECT user_id, refresh_token_enc, email, scope, connected_at FROM calendar_connections WHERE user_id = $1',
    [userId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { userId: row.user_id, refreshToken: enc.decrypt(row.refresh_token_enc), email: row.email, scope: row.scope, connectedAt: row.connected_at };
}

async function isConnected(userId) {
  const p = getPool();
  if (!p) return false;
  const r = await p.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [userId]);
  return !!r.rows[0];
}

async function deleteConnection(userId) {
  const p = getPool();
  if (!p) return false;
  const r = await p.query('DELETE FROM calendar_connections WHERE user_id = $1', [userId]);
  return (r.rowCount || 0) > 0;
}

async function getUserEmail(userId) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query('SELECT email FROM users WHERE id = $1', [userId]);
  return r.rows[0] ? String(r.rows[0].email || '').toLowerCase() : null;
}

async function authedClientFor(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  return client;
}

const CAL_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

async function listEvents(userId, opts) {
  opts = opts || {};
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) {
    return { connected: false, count: 0, events: [], text: 'Google Calendar is not connected.' };
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  const maxResults = Math.min(Math.max(parseInt(opts.maxResults, 10) || 10, 1), 50);
  const timeMin = encodeURIComponent(new Date().toISOString());
  const url = CAL_EVENTS_URL +
    '?singleEvents=true&orderBy=startTime&maxResults=' + maxResults +
    '&timeMin=' + timeMin;
  try {
    const r = await client.request({ url });
    const items = (r.data && r.data.items) || [];
    const events = items.map(function (ev) {
      const start = ev.start ? (ev.start.dateTime || ev.start.date || null) : null;
      const end = ev.end ? (ev.end.dateTime || ev.end.date || null) : null;
      return { id: ev.id, summary: ev.summary || '(no title)', start: start, end: end, htmlLink: ev.htmlLink || null };
    });
    const text = events.length
      ? events.map(function (e) { return '- ' + e.summary + ' (' + (e.start || '?') + ')'; }).join('\n')
      : 'No upcoming events.';
    return { connected: true, count: events.length, events: events, text: text };
  } catch (e) {
    if (/invalid_grant|unauthorized|401/i.test(e.message)) {
      return { connected: false, count: 0, events: [], text: 'Google Calendar access expired. Please reconnect.' };
    }
    throw e;
  }
}

async function createEvent(userId, { summary, description, start, end }) {
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) {
    return { ok: false, connected: false, error: 'Google Calendar is not connected.' };
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  const tz = process.env.CALENDAR_TIME_ZONE || 'Asia/Jerusalem';
  const toWhen = function (v) {
    if (!v) return undefined;
    if (typeof v === 'string') return { dateTime: v, timeZone: tz };
    return { dateTime: v.dateTime, timeZone: v.timeZone || tz };
  };
  const body = {
    summary: summary || '(no title)',
    description: description || undefined,
    start: toWhen(start),
    end: toWhen(end),
  };
  try {
    const r = await client.request({
      url: CAL_EVENTS_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = r.data || {};
    return { ok: true, id: data.id || null, htmlLink: data.htmlLink || null };
  } catch (e) {
    if (/invalid_grant|unauthorized|401/i.test(e.message)) {
      return { ok: false, connected: false, error: 'Google Calendar access expired. Please reconnect.' };
    }
    throw e;
  }
}

module.exports = {
  configured, consentUrl, exchangeCode,
  saveConnection, getConnection, isConnected, deleteConnection, authedClientFor,
  getUserEmail, listEvents, createEvent,
  SCOPES, CALLBACK_URL,
};
