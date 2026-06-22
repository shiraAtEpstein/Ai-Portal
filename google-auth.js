// ============================================================
// google-auth.js — "Sign in with Google" for the Firm AI Portal
// Phase 2. Adds /auth/google/start and /auth/google/callback.
// Sits ALONGSIDE the existing email/password login — does not replace it.
//
// Flow:
//   1) /auth/google/start  -> redirect to Google (domain-restricted)
//   2) Google authenticates the user, redirects back with a code
//   3) /auth/google/callback -> verify ID token, check domain,
//      match to the firm staff list for the role, create a session,
//      record the user + an audit row in Neon, hand the token to the SPA.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

const ALLOWED_DOMAIN = (process.env.GOOGLE_ALLOWED_DOMAIN || 'epsteinlaw.co.il').toLowerCase();

// --- Pure decision logic (exported for unit testing) -------------------
// Given a verified Google token payload and a staff lookup, decide whether
// this person may sign in and with what role. No side effects.
function evaluateLogin(payload, findUserByEmail, allowedDomain = ALLOWED_DOMAIN) {
  const email = String(payload.email || '').toLowerCase();
  if (!payload.email_verified) return { ok: false, reason: 'Email not verified by Google.' };
  if (payload.hd && payload.hd.toLowerCase() !== allowedDomain) {
    return { ok: false, reason: 'Only ' + allowedDomain + ' accounts can sign in.' };
  }
  if (!email.endsWith('@' + allowedDomain)) {
    return { ok: false, reason: 'Only ' + allowedDomain + ' accounts can sign in.' };
  }
  const staff = findUserByEmail(email);
  if (!staff) return { ok: false, reason: 'Your account is not authorised for the portal. Contact your administrator.', email };
  if (staff.disabled) return { ok: false, reason: 'Your access has been disabled. Contact your administrator.', email };
  return { ok: true, email, staff };
}

function createGoogleAuthRouter({ createSession, findUserByEmail }) {
  const router = express.Router();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackUrl =
    process.env.GOOGLE_CALLBACK_URL ||
    'https://ai-portal-wf42.onrender.com/auth/google/callback';

  const enabled = !!(clientId && clientSecret);
  const client = enabled ? new OAuth2Client(clientId, clientSecret, callbackUrl) : null;

  // Short-lived state store for CSRF protection (state -> expiry).
  const stateStore = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore) if (v < now) stateStore.delete(k);
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  // Lets the frontend know whether to show the Google button.
  router.get('/auth/google/status', (req, res) => res.json({ enabled }));

  router.get('/auth/google/start', (req, res) => {
    if (!enabled) return res.status(503).send('Google sign-in is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, Date.now() + 10 * 60 * 1000);
    const url = client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      hd: ALLOWED_DOMAIN,        // hint Google to the firm domain
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
      const { tokens } = await client.getToken(code);
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();

      const decision = evaluateLogin(payload, findUserByEmail);
      if (!decision.ok) {
        await db.writeAudit({
          action: 'auth.login.denied',
          targetType: 'user',
          targetId: decision.email || (payload && payload.email) || 'unknown',
          metadata: { via: 'google', reason: decision.reason },
        });
        return fail(decision.reason);
      }

      const { staff, email } = decision;

      // Record identity in Neon (best-effort; never blocks login).
      let dbUserId = null;
      try {
        dbUserId = await db.upsertUserOnLogin({
          googleSub: payload.sub,
          email,
          name: staff.name,
        });
      } catch (e) {
        console.error('[GOOGLE-AUTH] user upsert failed:', e.message);
      }
      await db.writeAudit({
        actorId: dbUserId,
        action: 'auth.login',
        targetType: 'user',
        targetId: email,
        metadata: { via: 'google', role: staff.role },
      });

      // Create the same kind of session the email/password path uses.
      const token = createSession({ userId: staff.id, name: staff.name, role: staff.role });
      console.log('[LOGIN] ' + staff.name + ' (' + staff.role + ') signed in via Google at ' + new Date().toISOString());

      // Hand the token to the single-page app via the URL fragment, which
      // (unlike a query string) is never sent to the server or logged.
      const frag =
        '#token=' + encodeURIComponent(token) +
        '&name=' + encodeURIComponent(staff.name) +
        '&role=' + encodeURIComponent(staff.role);
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
