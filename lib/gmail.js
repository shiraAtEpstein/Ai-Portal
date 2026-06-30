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

module.exports = {
  configured, consentUrl, exchangeCode,
  saveConnection, getConnection, isConnected, deleteConnection, authedClientFor,
  SCOPES, CALLBACK_URL,
};
