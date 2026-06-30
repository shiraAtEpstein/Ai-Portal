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
  'openid',
  'email',
];

function configured() { return !!(CLIENT_ID && CLIENT_SECRET); }

function oauthClient() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, CALLBACK_URL);
}

// The Google consent URL the user is sent to. access_type=offline +
// prompt=consent guarantees we receive a refresh token every time.
function consentUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
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
  return (r.rowCount || 0) > 0;
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

  const client = await authedClientFor(userId);
  if (!client) {
    return { connected: false, count: 0, messages: [], text: 'Gmail is not connected for this user. Ask them to click "Connect Gmail" first.' };
  }

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
    return { connected: true, count: messages.length, messages: messages, text: renderText(messages) };
  } catch (e) {
    const msg = (e && e.message) || 'unknown error';
    if (/invalid_grant|unauthorized|401/i.test(msg)) {
      return { connected: false, count: 0, messages: [], text: 'Gmail permission has expired or was revoked. Ask the user to reconnect Gmail.' };
    }
    throw e;
  }
}

module.exports = {
  configured, consentUrl, exchangeCode,
  saveConnection, getConnection, isConnected, deleteConnection, authedClientFor,
  searchMail,
  SCOPES, CALLBACK_URL,
};
