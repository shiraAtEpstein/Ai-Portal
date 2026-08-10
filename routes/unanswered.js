// ============================================================
// routes/unanswered.js — admin-only "unanswered client chats" endpoints.
//
//   GET  /api/admin/unanswered/whatsapp     -> preview, grouped by responsible person
//   POST /api/admin/unanswered/send-digest  -> build + send the digests now
//
// Deterministic: reads ingested WhatsApp data + the staff directory only. No
// Dropbox, no Claude, no dependency on the (blocked) summary processor.
// Admin-gated, same idiom as routes/whatsapp-groups.js.
//
// Scope: WhatsApp only. The email side (unanswered Gmail threads) is a later PR.
// ============================================================
const express = require('express');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { buildDigest, sendDigests } = require('../lib/unanswered-digest');

const DEFAULT_HOURS = parseInt(process.env.UNANSWERED_HOURS || '3', 10);

function hoursFrom(req) {
  const raw = (req.query && req.query.hours) || (req.body && req.body.hours);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOURS;
}

module.exports = function createUnansweredRouter() {
  const router = express.Router();

  // Preview Shira opens to see real results before any email goes out.
  router.get('/api/admin/unanswered/whatsapp', authenticate, requireAdmin, async (req, res) => {
    try {
      const hours = hoursFrom(req);
      const digest = await buildDigest({ hours });
      res.json({
        hours: digest.hours,
        generatedAt: digest.generatedAt,
        total: digest.all.length,
        byPerson: digest.byPerson,
        all: digest.all,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build unanswered list.', detail: e.message });
    }
  });

  // Diagnostic: does the firm SENDER token (GMAIL_REFRESH_TOKEN) still work?
  // Reads the GMAIL_* env vars, asks Google for an access token exactly like
  // lib/firm-mailer does, and returns Google's RAW answer so we can see the
  // real words ("invalid_grant: Token has been expired or revoked", etc.).
  // Never returns any secret value or the access token itself. Sends no email.
  router.get('/api/admin/mail-health', authenticate, requireAdmin, async (req, res) => {
    const clientId = process.env.GMAIL_CLIENT_ID || '';
    const clientSecret = process.env.GMAIL_CLIENT_SECRET || '';
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN || '';
    const present = {
      GMAIL_CLIENT_ID: !!clientId,
      GMAIL_CLIENT_SECRET: !!clientSecret,
      GMAIL_REFRESH_TOKEN: !!refreshToken,
      EMAIL_FROM: !!(process.env.EMAIL_FROM || ''),
    };
    // A quick fingerprint (NOT the secret) so we can tell if a value looks empty
    // or truncated without ever printing it: length + last 6 chars of the client id.
    const clientIdTail = clientId ? ('…' + clientId.slice(-6)) : null;
    if (!clientId || !clientSecret || !refreshToken) {
      return res.json({ ok: false, stage: 'config', present, clientIdTail,
        message: 'One or more GMAIL_* env vars are missing in Render.' });
    }
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const google = await resp.json().catch(() => ({}));
      const ok = resp.ok && !!google.access_token;
      return res.json({
        ok,
        stage: 'token',
        httpStatus: resp.status,             // 200 = good, 400/401 = rejected
        googleError: google.error || null,             // e.g. "invalid_grant"
        googleErrorDescription: google.error_description || null, // Google's words
        gotAccessToken: !!google.access_token,         // true = token is ALIVE
        present,
        clientIdTail,
      });
    } catch (e) {
      return res.json({ ok: false, stage: 'network', message: e.message, present, clientIdTail });
    }
  });

  // Manual trigger: build + send the digests right now.
  router.post('/api/admin/unanswered/send-digest', authenticate, requireAdmin, async (req, res) => {
    try {
      const hours = hoursFrom(req);
      // ?to=someone@epsteinlaw.co.il -> TEST MODE: send only there (no staff).
      const testEmail = (req.query && req.query.to) || (req.body && req.body.to) || null;
      const result = await sendDigests({ hours, testEmail });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Failed to send digests.', detail: e.message });
    }
  });

  return router;
};
