// ============================================================
// google-auth.js — "Sign in with Google" for the Firm AI Portal
//
// HARDENED token exchange (fixes intermittent "Premature close"):
//   IPv4-forced token POST, identity read from the id_token locally
//   (no second network call), auto-retry up to 3 times.
//
// DAY 4 — roles are database-driven (read from DB, fall back to users.json).
// DAY 5 — a successful Google login creates a DATABASE session (revocable,
//   survives restarts). Disabled users (status='disabled') are refused.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

const ALLOWED_DOMAIN = (process.env.GOOGLE_ALLOWED_DOMAIN || 'epsteinlaw.co.il').toLowerCase();

const ipv4Agent = new https.Agent({ family: 4, keepAlive: false });

// Decide whether a person may sign in, given a resolved staff object
// ({ name, roles[], disabled } or null). Pure; exported for testing.
function evaluateLogin(payload, staff, allowedDomain = ALLOWED_DOMAIN) {
  const email = String(payload.email || '').toLowerCase();
  if (!payload.email_verified) return { ok: false, reason: 'Email not verified by Google.' };
  if (payload.hd && payload.hd.toLowerCase() !== allowedDomain) {
    return { ok: false, reason: 'Only ' + allowedDomain + ' accounts can sign in.' };
  }
  if (!email.endsWith('@' + allowedDomain)) {
    return { ok: false, reason: 'Only ' + allowedDomain + ' accounts can sign in.' };
  }
  if (!staff) return { ok: false, reason: 'Your account is not authorised for the portal. Contact your administrator.', email };
  if (staff.disabled) return { ok: false, reason: 'Your access has been disabled. Contact your administrator.', email };
  return { ok: true, email, staff };
}

function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

function validateIdTokenPayload(payload, clientId) {
  const iss = payload && payload.iss;
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') throw new Error('unexpected token issuer');
  if (payload.aud !== clientId) throw new Error('token audience mismatch');
  if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp) + 60) throw new Error('token expired');
}

// createSession(userId, meta) -> token. Injected (database session creator).
function createGoogleAuthRouter({ createSession, findUserByEmail }) {
  const router = express.Router();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackUrl =
    process.env.GOOGLE_CALLBACK_URL ||
    'https://ai-portal-wf42.onrender.com/auth/google/callback';

  const enabled = !!(clientId && clientSecret);
  const client = enabled ? new OAuth2Client(clientId, clientSecret, callbackUrl) : null;

  function postToken(body) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          agent: ipv4Agent,
          family: 4,
          timeout: 15000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'application/json',
            'Connection': 'close',
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on('timeout', () => req.destroy(new Error('token request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function exchangeCodeForTokens(code) {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }).toString();

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { status, body: respBody } = await postToken(body);
        let json;
        try { json = JSON.parse(respBody); } catch (_) { throw new Error('non-JSON token response (HTTP ' + status + ')'); }
        if (status >= 200 && status < 300 && json.id_token) return json;
        const desc = json.error_description || json.error || ('HTTP ' + status);
        const err = new Error('token exchange rejected: ' + desc);
        err.permanent = status >= 400 && status < 500;
        throw err;
      } catch (e) {
        lastErr = e;
        if (e.permanent) break;
        console.warn('[GOOGLE-AUTH] token exchange attempt ' + attempt + '/3 failed: ' + e.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    throw lastErr;
  }

  const stateStore = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore) if (v < now) stateStore.delete(k);
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  router.get('/auth/google/status', (req, res) => res.json({ enabled }));

  router.get('/auth/google/start', (req, res) => {
    if (!enabled) return res.status(503).send('Google sign-in is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, Date.now() + 10 * 60 * 1000);
    const url = client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      hd: ALLOWED_DOMAIN,
      prompt: 'select_account',
    });
    res.redirect(url);
  });

  router.get('/auth/google/callback', async (req, res) => {
    if (!enabled) return res.status(503).send('Google sign-in is not configured.');
    const { code, state } = req.query;
    const fail = (msg) => res.redirect('/?auth_error=' + encodeURIComponent(msg));

    if (!code || !state || !stateStore.has(state)) {
      return fail('Sign-in expired or invalid. Please try again.');
    }
    stateStore.delete(state);

    try {
      const tokens = await exchangeCodeForTokens(code);
      const payload = decodeIdToken(tokens.id_token);
      validateIdTokenPayload(payload, clientId);

      const email = String(payload.email || '').toLowerCase();

      // --- Resolve identity & roles: DATABASE first, else users.json ---
      const fileStaff = findUserByEmail(email);
      let dbUser = null;
      try { dbUser = await db.getUserAuthByEmail(email); } catch (e) { console.error('[GOOGLE-AUTH] auth lookup failed:', e.message); }

      const disabled = (dbUser && dbUser.status === 'disabled') || (fileStaff ? !!fileStaff.disabled : false);
      const roles = (dbUser && dbUser.roles.length) ? dbUser.roles : (fileStaff ? [fileStaff.role] : []);
      const staff = (dbUser || fileStaff) ? {
        name: (dbUser && dbUser.name) || (fileStaff && fileStaff.name) || payload.name || email.split('@')[0],
        roles,
        disabled,
      } : null;

      const decision = evaluateLogin(payload, staff);
      if (!decision.ok) {
        await db.writeAudit({ action: 'auth.login.denied', targetType: 'user', targetId: email || 'unknown', metadata: { via: 'google', reason: decision.reason } });
        return fail(decision.reason);
      }

      // Upsert identity (gives us the canonical database user id).
      let dbUserId = dbUser ? dbUser.id : null;
      try {
        dbUserId = await db.upsertUserOnLogin({ googleSub: payload.sub, email, name: staff.name });
      } catch (e) {
        console.error('[GOOGLE-AUTH] user upsert failed:', e.message);
      }
      await db.writeAudit({ actorId: dbUserId, action: 'auth.login', targetType: 'user', targetId: email, metadata: { via: 'google', roles: staff.roles } });

      // Create a DATABASE session (requires the db user id).
      let token = null;
      if (dbUserId) {
        try { token = await createSession(dbUserId, { userAgent: req.headers['user-agent'] || null }); }
        catch (e) { console.error('[GOOGLE-AUTH] session create failed:', e.message); }
      }
      if (!token) return fail('Sign-in could not complete (database unavailable). Please try again.');

      console.log('[LOGIN] ' + staff.name + ' (' + staff.roles.join('/') + ') signed in via Google at ' + new Date().toISOString());

      const frag =
        '#token=' + encodeURIComponent(token) +
        '&name=' + encodeURIComponent(staff.name) +
        '&role=' + encodeURIComponent(staff.roles[0] || '') +
        '&roles=' + encodeURIComponent(staff.roles.join(','));
      res.redirect('/' + frag);
    } catch (err) {
      console.error('[GOOGLE-AUTH] callback error:', err.message);
      return fail('Sign-in failed. Please try again.');
    }
  });

  return router;
}

module.exports = createGoogleAuthRouter;
module.exports.evaluateLogin = evaluateLogin;
