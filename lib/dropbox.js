// ============================================================
// lib/dropbox.js — read-only Dropbox access for the portal.
//
// The portal reads authored agent files (firm core, user cores, agent
// rules and files) from a single Dropbox App folder. We keep only a
// long-lived REFRESH TOKEN, encrypted with CHAT_ENC_KEY, in the
// dropbox_connection table (one row for the whole firm). Access tokens
// are short-lived and minted on demand from the refresh token.
//
// Read-only: the app is registered with files.metadata.read and
// files.content.read only. No writes, ever. Dependency-free (uses the
// built-in global fetch), per the js-yaml lesson.
// ============================================================
const enc = require('./crypto');
const { getPool } = require('../db');

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const CALLBACK_URL = process.env.DROPBOX_CALLBACK_URL || (BASE_URL + '/auth/dropbox/callback');
// Sub-path inside the App folder that holds the agent files. '' = folder root.
const ROOT = (process.env.DROPBOX_ROOT || '').replace(/\/+$/, '');

function configured() { return !!(APP_KEY && APP_SECRET); }

function consentUrl(state) {
  const p = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    token_access_type: 'offline',   // get a refresh token, not just a 4h token
    redirect_uri: CALLBACK_URL,
    state: state,
  });
  return 'https://www.dropbox.com/oauth2/authorize?' + p.toString();
}

async function tokenRequest(params) {
  const body = new URLSearchParams(Object.assign({ client_id: APP_KEY, client_secret: APP_SECRET }, params)).toString();
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('dropbox token error: ' + (j.error_description || j.error || r.status));
  return j;
}

// Exchange the one-time authorization code for tokens (incl. refresh token).
async function exchangeCode(code) {
  return tokenRequest({ grant_type: 'authorization_code', code: code, redirect_uri: CALLBACK_URL });
}

// --- storage: single-row table, refresh token encrypted at rest ---
async function saveConnection(refreshToken, account) {
  const p = getPool();
  await p.query(
    `INSERT INTO dropbox_connection (id, refresh_token_enc, account, connected_at, updated_at)
     VALUES (1, $1, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       account = EXCLUDED.account,
       updated_at = now()`,
    [enc.encrypt(refreshToken), account || null]);
}

async function getConnection() {
  const p = getPool();
  const r = await p.query('SELECT refresh_token_enc, account, connected_at FROM dropbox_connection WHERE id = 1');
  const row = r.rows[0];
  if (!row) return null;
  return { refreshToken: enc.decrypt(row.refresh_token_enc), account: row.account, connectedAt: row.connected_at };
}

async function isConnected() {
  const p = getPool();
  const r = await p.query('SELECT 1 FROM dropbox_connection WHERE id = 1');
  return r.rowCount > 0;
}

async function disconnect() {
  const p = getPool();
  await p.query('DELETE FROM dropbox_connection WHERE id = 1');
}

// --- short-lived access token, minted from the refresh token and cached ---
let _access = { token: null, exp: 0 };
async function getAccessToken() {
  if (_access.token && Date.now() < _access.exp - 60000) return _access.token;
  const conn = await getConnection();
  if (!conn || !conn.refreshToken) throw new Error('Dropbox is not connected.');
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refreshToken });
  _access = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 14400) * 1000) };
  return _access.token;
}

// --- read-only helpers ---
// Dropbox-API-Arg must be ASCII (HTTP headers can't carry raw Hebrew/Unicode).
// Escape any non-ASCII to \uXXXX so paths like /ניוזלטר/... work.
function apiArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

async function listFiles(subpath) {
  const token = await getAccessToken();
  let path = ROOT + (subpath || '');
  path = path.replace(/\/+$/, '');   // '' means the App folder root
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path, recursive: false }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('dropbox list error: ' + (j.error_summary || r.status));
  return (j.entries || []).map(function (e) { return { name: e.name, path: e.path_lower, type: e['.tag'] }; });
}

async function readFile(path) {
  const token = await getAccessToken();
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path: path }) },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('dropbox download error: ' + (t || r.status));
  }
  return await r.text();
}

module.exports = {
  configured, consentUrl, exchangeCode,
  saveConnection, getConnection, isConnected, disconnect,
  getAccessToken, listFiles, readFile, CALLBACK_URL,
};
