// ============================================================
// test/auth.test.js — proves the Google sign-in policy boundaries.
// Tests evaluateLogin() from google-auth.js (the real function the login
// flow uses) — who is allowed to sign in and who is refused. Run with: npm test
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { evaluateLogin } = require('../google-auth');

const DOMAIN = 'epsteinlaw.co.il';
const activeStaff = { name: 'Test User', roles: ['lawyer'], disabled: false };

function payload(over = {}) {
  return Object.assign({ email: 'user@' + DOMAIN, email_verified: true, hd: DOMAIN }, over);
}

test('a verified firm user with an active account is allowed in', () => {
  const d = evaluateLogin(payload(), activeStaff, DOMAIN);
  assert.equal(d.ok, true);
});

test('BOUNDARY: a non-firm email is refused', () => {
  const d = evaluateLogin(payload({ email: 'someone@gmail.com', hd: undefined }), activeStaff, DOMAIN);
  assert.equal(d.ok, false);
  assert.match(d.reason, /accounts can sign in/i);
});

test('BOUNDARY: a Google account from another Workspace (hd mismatch) is refused', () => {
  const d = evaluateLogin(payload({ hd: 'someother.com' }), activeStaff, DOMAIN);
  assert.equal(d.ok, false);
});

test('BOUNDARY: an unverified Google email is refused', () => {
  const d = evaluateLogin(payload({ email_verified: false }), activeStaff, DOMAIN);
  assert.equal(d.ok, false);
});

test('BOUNDARY: a firm email that is NOT a known user (not invited) is refused', () => {
  const d = evaluateLogin(payload(), null, DOMAIN);
  assert.equal(d.ok, false);
  assert.match(d.reason, /not authoris|administrator/i);
});

test('BOUNDARY: a disabled user is refused', () => {
  const d = evaluateLogin(payload(), { name: 'X', roles: ['lawyer'], disabled: true }, DOMAIN);
  assert.equal(d.ok, false);
  assert.match(d.reason, /disabled/i);
});

test('email casing is normalised (uppercase firm email still allowed)', () => {
  const d = evaluateLogin(payload({ email: 'USER@EpsteinLaw.co.il' }), activeStaff, DOMAIN);
  assert.equal(d.ok, true);
});
