// ============================================================
// test/integration.test.js — end-to-end checks over real HTTP.
// Starts the actual Express routers, fakes a logged-in user by stubbing the
// database session lookup, and fires real requests to prove the SERVER (not
// just the UI) enforces auth, sessions, and role boundaries — and that the
// browser cannot bypass them. Run with:  npm test
// ============================================================
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const db = require('../db');

const createChatRouter = require('../routes/chat');
const createAdminRouter = require('../routes/admin');
const createAuthRouter = require('../routes/auth');
const { tokenFromReq } = require('../lib/sessions');

// uuid-shaped tokens (the server only accepts uuid-format session tokens)
const PARA = '11111111-1111-1111-1111-111111111111';
const ADMIN = '22222222-2222-2222-2222-222222222222';
const SESSIONS = {
  [PARA]:  { userId: 'u-para',  name: 'Pat Paralegal', roles: ['paralegal'] },
  [ADMIN]: { userId: 'u-admin', name: 'Ada Admin',     roles: ['admin'] },
};

let server, base;

before(async () => {
  // Fake the DB session lookup: a known token -> active session; otherwise null
  // (null is exactly what the DB returns for expired / revoked / disabled sessions).
  mock.method(db, 'getSession', async (token) => SESSIONS[token] || null);
  mock.method(db, 'listAllUsers', async () => [
    { id: 'u-admin', email: 'ada@epsteinlaw.co.il', name: 'Ada Admin', status: 'active', roles: ['admin'] },
  ]);

  const app = express();
  app.use(express.json());
  app.use(createChatRouter());
  app.use(createAdminRouter({ loadUsers: () => ({ users: [] }) }));
  app.use(createAuthRouter());
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => { if (server) server.close(); mock.reset(); });

function call(path, { method = 'GET', token, cookie, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// ---- token parsing (pure) ----
test('TOKEN: a valid uuid in the Authorization header is accepted; a cookie also works', () => {
  assert.equal(tokenFromReq({ headers: { authorization: 'Bearer ' + PARA } }), PARA);
  assert.equal(tokenFromReq({ headers: { cookie: 'a=1; portal_session=' + PARA } }), PARA);
});
test('TOKEN: a malformed (non-uuid) token is ignored', () => {
  assert.equal(tokenFromReq({ headers: { authorization: 'Bearer not-a-token' } }), '');
});

// ---- session / auth layer over HTTP ----
test('SESSION: no token on a protected endpoint -> 401', async () => {
  assert.equal((await call('/api/agents')).status, 401);
});
test('SESSION: a malformed token -> 401', async () => {
  assert.equal((await call('/api/agents', { token: 'not-a-token' })).status, 401);
});
test('SESSION: an expired/revoked/disabled session (DB returns null) -> 401', async () => {
  assert.equal((await call('/api/agents', { token: '99999999-9999-9999-9999-999999999999' })).status, 401);
});
test('SESSION: the httpOnly cookie also authenticates (stay-logged-in path)', async () => {
  const r = await call('/api/me', { cookie: 'portal_session=' + PARA });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).name, 'Pat Paralegal');
});

// ---- role boundaries enforced by the SERVER over HTTP ----
test('HTTP: /api/agents returns only the agents the role is allowed', async () => {
  const r = await call('/api/agents', { token: PARA });
  assert.equal(r.status, 200);
  const ids = (await r.json()).agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ['calendar', 'daily', 'document_review', 'general', 'lawly', 'paralegal']);
});
test('HTTP BOUNDARY: a paralegal POSTing to a lawyer-only agent is refused (403) — no browser bypass', async () => {
  const r = await call('/api/chat', { method: 'POST', token: PARA, body: { agentId: 'legal_research', message: 'hi' } });
  assert.equal(r.status, 403);
});
test('HTTP BOUNDARY: a non-admin hitting an admin endpoint is refused (403)', async () => {
  assert.equal((await call('/api/admin/all-users', { token: PARA })).status, 403);
});
test('HTTP: an admin can reach the admin endpoint (200)', async () => {
  assert.equal((await call('/api/admin/all-users', { token: ADMIN })).status, 200);
});
test('HTTP: the retired password login returns 410 Gone', async () => {
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'x', password: 'y' } })).status, 410);
});
