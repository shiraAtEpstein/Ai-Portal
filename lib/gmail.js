// ============================================================
// lib/gmail.js — per-user Gmail connection (READ-ONLY).
//
// Phase 2, Stage 2. Each user connects their own Gmail once, through
// Google's consent screen. We keep only a REFRESH TOKEN, encrypted with
// the existing CHAT_ENC_KEY (so it sits encrypted in Neon; the key lives
// in Render). Read-only scope only. No sending, no writing, ever.
//
// This file is self-contained: it reuses db.getPool() for the connection
// pool and lib/crypto for encryption, but does NOT modify db.js.
// ============================================================
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { getPool } = require('../db');
const enc = require('./crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com';
const CALLBACK_URL = process.env.GMAIL_CALLBACK_URL || (BASE_URL + '/auth/gmail/callback');

// Read-only Gmail + just enough to learn which mailbox was connected.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'openid',
  'email',
];

function configured() { return !!(CLIENT_ID && CLIENT_SECRET); }

// Does a stored connection carry the gmail.compose scope (i.e. can it draft)?
// Connections made before compose was added are read-only: Google issued the
// refresh token against the OLD scope list, and re-asking is the only fix.
function hasDraftScope(scope) {
  return /gmail\.compose/.test(String(scope || ''));
}

function oauthClient() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, CALLBACK_URL);
}

// --- live token health ------------------------------------------------
//
// A row in gmail_connections only means a token was saved ONCE. Google
// expires refresh tokens (~7 days while the OAuth app is in "Testing", and
// on mailbox password change / revoke), and a dead token is invisible to a
// row-existence check — which is why the status pill used to show a green
// "connected" while every read silently failed. So we probe the token.
//
// The probe result is cached briefly so a polled status endpoint doesn't
// hammer Google's token endpoint.
const PROBE_TTL_MS = 60 * 1000;
const _probeCache = new Map(); // userId -> { status, exp }

function clearProbe(userId) { _probeCache.delete(userId); }
function markRevoked(userId) { _probeCache.set(userId, { status: 'revoked', exp: Date.now() + PROBE_TTL_MS }); }

// Returns 'ok' | 'revoked' | 'unknown'. Only 'revoked' means the token is
// truly dead and the user must reconnect. 'unknown' is a transient/network
// error and we deliberately FAIL OPEN (keep showing connected) so a Google
// blip doesn't flip everyone to "disconnected".
async function probeToken(userId, refreshToken) {
  const cached = _probeCache.get(userId);
  if (cached && cached.exp > Date.now()) return cached.status;
  let status = 'unknown';
  try {
    const client = oauthClient();
    client.setCredentials({ refresh_token: refreshToken });
    await client.getAccessToken(); // forces a refresh; throws invalid_grant if the token is dead
    status = 'ok';
  } catch (e) {
    const msg = (e && e.message) || '';
    status = /invalid_grant|unauthorized|invalid_token|\b401\b/i.test(msg) ? 'revoked' : 'unknown';
  }
  _probeCache.set(userId, { status, exp: Date.now() + PROBE_TTL_MS });
  return status;
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
  if (!refreshToken) throw new Error('no refresh token returned');
  await p.query(
    `INSERT INTO gmail_connections (user_id, refresh_token_enc, email, scope, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       email             = EXCLUDED.email,
       scope             = EXCLUDED.scope,
       updated_at        = now()`,
    [userId, enc.encrypt(refreshToken), email, scope]);
  clearProbe(userId); // a freshly saved token should be re-probed, not judged by a stale cache entry
}

async function getConnection(userId) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    'SELECT user_id, refresh_token_enc, email, scope, connected_at FROM gmail_connections WHERE user_id = $1',
    [userId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { userId: row.user_id, refreshToken: enc.decrypt(row.refresh_token_enc), email: row.email, scope: row.scope, connectedAt: row.connected_at };
}

// { connected, email, canDraft, needsReconnect } for the UI.
// Unlike a bare row check, this VERIFIES the stored token still works, so a
// connection whose token has expired/been revoked is reported as
// not-connected (with needsReconnect:true) instead of a misleading green
// "connected". Pass { verify:false } for callers that only need the cheap
// row-existence check and don't want the network round-trip.
async function connectionStatus(userId, opts) {
  const p = getPool();
  if (!p) return { connected: false, email: null, canDraft: false };
  const r = await p.query('SELECT email, scope, refresh_token_enc FROM gmail_connections WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  if (!row) return { connected: false, email: null, canDraft: false };
  const email = row.email || null;
  const canDraft = hasDraftScope(row.scope);
  if (opts && opts.verify === false) return { connected: true, email, canDraft };
  let token = null;
  try { token = enc.decrypt(row.refresh_token_enc); } catch (_) { token = null; }
  if (!token || token.startsWith('[')) {
    return { connected: false, email, canDraft, needsReconnect: true };
  }
  const status = await probeToken(userId, token);
  if (status === 'revoked') {
    return { connected: false, email, canDraft, needsReconnect: true };
  }
  // 'ok' or 'unknown' (transient) -> keep showing connected.
  return { connected: true, email, canDraft };
}

async function isConnected(userId) {
  const p = getPool();
  if (!p) return false;
  const r = await p.query('SELECT 1 FROM gmail_connections WHERE user_id = $1', [userId]);
  return !!r.rows[0];
}

async function deleteConnection(userId) {
  const p = getPool();
  if (!p) return false;
  const r = await p.query('DELETE FROM gmail_connections WHERE user_id = $1', [userId]);
  clearProbe(userId);
  return (r.rowCount || 0) > 0;
}

// The portal email of a user (to verify the connected Gmail matches them).
async function getUserEmail(userId) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query('SELECT email FROM users WHERE id = $1', [userId]);
  return r.rows[0] ? String(r.rows[0].email || '').toLowerCase() : null;
}

// An OAuth client pre-loaded with this user's refresh token. The Google
// library refreshes the short-lived access token automatically. Returns
// null if the user has not connected (or the token can't be decrypted).
async function authedClientFor(userId) {
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  return client;
}


// --- reading mail (READ-ONLY) -----------------------------------------

// Gmail snippets come HTML-escaped; turn them back into plain text.
function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

// Pull the text/plain part out of a Gmail message payload (best effort).
function extractPlainText(payload) {
  if (!payload) return '';
  function walk(part) {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      try { return Buffer.from(part.body.data, 'base64').toString('utf8'); } catch (_) { return ''; }
    }
    if (Array.isArray(part.parts)) {
      for (const sub of part.parts) { const t = walk(sub); if (t) return t; }
    }
    return '';
  }
  return walk(payload);
}

function renderText(messages) {
  if (!messages.length) return 'No matching emails found.';
  return messages.map(function (m, i) {
    let block = (i + 1) + '. From: ' + m.from + '\n   Date: ' + m.date + '\n   Subject: ' + m.subject + '\n   ' + m.snippet;
    if (m.body) block += '\n   --- body ---\n   ' + m.body.replace(/\n/g, '\n   ');
    return block;
  }).join('\n\n');
}

// Search and read the signed-in user's OWN recent mail. Read-only.
// Returns { connected, count, messages, text }. Never sends or changes anything.
async function searchMail(userId, opts) {
  opts = opts || {};
  const query = String(opts.query || '');
  const includeBody = !!opts.includeBody;
  const cap = Math.min(Math.max(parseInt(opts.maxResults, 10) || 10, 1), 20);

  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) {
    return { connected: false, mailbox: null, count: 0, messages: [], text: 'Gmail is not connected for this user. Ask them to click "Connect Gmail" first.' };
  }
  const mailbox = conn.email || null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });

  try {
    const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + cap +
      (query ? '&q=' + encodeURIComponent(query) : '');
    const list = await client.request({ url: listUrl });
    const ids = ((list.data && list.data.messages) || []).map(function (m) { return m.id; });

    const messages = [];
    for (const id of ids) {
      let url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=' + (includeBody ? 'full' : 'metadata');
      if (!includeBody) url += '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';
      const msg = await client.request({ url });
      const data = msg.data || {};
      const headers = {};
      (((data.payload && data.payload.headers) || [])).forEach(function (h) { headers[h.name.toLowerCase()] = h.value; });
      const entry = {
        id: id,
        from: headers.from || '',
        to: headers.to || '',
        subject: headers.subject || '(no subject)',
        date: headers.date || '',
        snippet: decodeEntities(data.snippet || ''),
      };
      if (includeBody) entry.body = extractPlainText(data.payload).slice(0, 4000);
      messages.push(entry);
    }
    const header = mailbox ? ('Mailbox being read: ' + mailbox + '\n\n') : '';
    return { connected: true, mailbox: mailbox, count: messages.length, messages: messages, text: header + renderText(messages) };
  } catch (e) {
    const msg = (e && e.message) || 'unknown error';
    if (/invalid_grant|unauthorized|401/i.test(msg)) {
      markRevoked(userId); // so the status pill reflects the dead token right away
      return { connected: false, mailbox: mailbox, count: 0, messages: [], text: 'Gmail permission has expired or was revoked. Ask the user to reconnect Gmail.' };
    }
    throw e;
  }
}

// RFC 2047 encode a header value if it contains non-ASCII (e.g. a Hebrew subject).
function encodeHeader(v) {
  const s = String(v || '');
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// Create a Gmail DRAFT for the signed-in user. NEVER sends - only saves a draft.
// Requires the gmail.compose scope (user must have reconnected Gmail to grant it).
async function createDraft(userId, opts) {
  opts = opts || {};
  const conn = await getConnection(userId);
  if (!conn || !conn.refreshToken || conn.refreshToken.startsWith('[')) {
    return { ok: false, error: 'Gmail is not connected for this user.' };
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  const to = String(opts.to || '').trim();
  const cc = String(opts.cc || '').trim();
  const subject = String(opts.subject || '').trim();
  const bodyText = String(opts.body || '');
  const lines = [];
  if (to) lines.push('To: ' + to);
  if (cc) lines.push('Cc: ' + cc);
  lines.push('Subject: ' + encodeHeader(subject));
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  const rfc822 = lines.join('\r\n') + '\r\n\r\n' + Buffer.from(bodyText, 'utf8').toString('base64');
  const raw = Buffer.from(rfc822, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    const r = await client.request({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      method: 'POST',
      data: { message: { raw: raw } },
    });
    return { ok: true, draftId: (r.data && r.data.id) || null, mailbox: conn.email || null, to: to, subject: subject };
  } catch (e) {
    const msg = (e && e.message) || 'unknown error';
    if (/insufficient|scope|403|permission|ACCESS_TOKEN_SCOPE/i.test(msg)) {
      return { ok: false, scope: true, error: 'draft permission missing - reconnect Gmail to grant draft access' };
    }
    if (/invalid_grant|unauthorized|401/i.test(msg)) {
      markRevoked(userId);
      return { ok: false, error: 'Gmail permission expired - reconnect Gmail' };
    }
    return { ok: false, error: msg };
  }
}

module.exports = {
  configured, consentUrl, exchangeCode,
  saveConnection, getConnection, isConnected, connectionStatus, hasDraftScope, deleteConnection, authedClientFor,
  searchMail, createDraft, getUserEmail,
  SCOPES, CALLBACK_URL,
};
