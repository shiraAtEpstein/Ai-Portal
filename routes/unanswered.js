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
const { buildDigest, sendDigests, buildBoard } = require('../lib/unanswered-digest');
const ingestDb = require('../whatsapp/ingest/db');
const { loadDirectory, routeGroupToStaff } = require('../lib/routing');

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

  // Backfill: resolve still-unresolved WhatsApp contacts to their monday CLIENT
  // by phone (same match the ingest path does). Run this BEFORE relink — it's
  // what lets relink then find each group's deal via its now-resolved client.
  //   POST /api/admin/unanswered/resolve-clients?limit=500  -> run until remaining stops dropping
  router.post('/api/admin/unanswered/resolve-clients', authenticate, requireAdmin, async (req, res) => {
    try {
      const { resolveUnresolvedContacts } = require('../lib/resolve-contacts');
      const limit = parseInt((req.query && req.query.limit) || '500', 10);
      const result = await resolveUnresolvedContacts({ limit });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Resolve-clients failed.', detail: e.message });
    }
  });

  // Re-link a batch of still-unlinked groups to their monday deal + responsible,
  // on demand (rebuilds links without waiting for new messages).
  //   POST /api/admin/unanswered/relink?limit=25   -> run again until remaining=0
  router.post('/api/admin/unanswered/relink', authenticate, requireAdmin, async (req, res) => {
    try {
      const { relinkUnlinked } = require('../lib/relink');
      const limit = parseInt((req.query && req.query.limit) || '25', 10);
      const result = await relinkUnlinked({ limit });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Relink failed.', detail: e.message });
    }
  });

  // Control board (verification): every currently-unanswered chat with status,
  // wait time, and who's in charge. Answered chats aren't here.
  router.get('/api/admin/unanswered/board', authenticate, requireAdmin, async (req, res) => {
    try {
      const board = await buildBoard();
      res.json(board);
    } catch (e) {
      res.status(500).json({ error: 'Failed to build board.', detail: e.message });
    }
  });

  // Management dashboard data: live "waiting now" numbers (consistent with the
  // digest/page) + historical response-time stats.
  //   GET /api/admin/unanswered/dashboard?days=30
  router.get('/api/admin/unanswered/dashboard', authenticate, requireAdmin, async (req, res) => {
    try {
      const dir = loadDirectory();
      const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
      const dRaw = parseInt((req.query && req.query.days) || '30', 10);
      const days = Math.min(Math.max(Number.isFinite(dRaw) ? dRaw : 30, 1), 180);

      // Live: everything currently waiting (hours=0), same source as the page.
      const chats = await ingestDb.listUnansweredChats({ hours: 0, staffPhones });
      let oldest = 0;
      const aging = { lt3: 0, h3to24: 0, gt24: 0 };
      const perStaff = {};
      for (const c of chats) {
        const h = Number(c.hoursWaiting) || 0;
        if (h > oldest) oldest = h;
        if (h < 3) aging.lt3++; else if (h < 24) aging.h3to24++; else aging.gt24++;
        const { responsible } = routeGroupToStaff(c.participant_phones, dir);
        for (const person of responsible) perStaff[person.name] = (perStaff[person.name] || 0) + 1;
      }
      const perStaffArr = Object.entries(perStaff)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      const history = await ingestDb.responseStats({ days, staffPhones });

      res.json({
        days,
        live: {
          waitingNow: chats.length,
          oldestHours: Math.round(oldest * 10) / 10,
          aging,
          perStaff: perStaffArr,
        },
        history,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build dashboard.', detail: e.message });
    }
  });

  // Testing aid: the most recent ingested WhatsApp messages (read-only, no text).
  //   GET /api/admin/unanswered/ingest-recent?limit=40&chat=teller
  // Lets you send a WhatsApp message and confirm it landed with the right
  // direction ('in' = client, 'out' = LAWLY line) and time.
  router.get('/api/admin/unanswered/ingest-recent', authenticate, requireAdmin, async (req, res) => {
    try {
      const limit = parseInt((req.query && req.query.limit) || '40', 10);
      const chat = (req.query && req.query.chat) || null;
      const rows = await ingestDb.listRecentJobs({ limit, chatLike: chat });
      res.json({ count: rows.length, rows });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read recent ingest.', detail: e.message });
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
