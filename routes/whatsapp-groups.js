// ============================================================
// routes/whatsapp-groups.js — admin-only status + QR for the Baileys
// groups connector (whatsapp/groups/*).
//
//   GET /api/admin/whatsapp-groups/status   -> connection status
//   GET /api/admin/whatsapp-groups/qr       -> PNG QR code (when auth_required)
//   GET /api/admin/whatsapp-groups/groups   -> groups seen so far
//
// Admin-gated (requireAdmin) since scanning the QR ties a physical phone
// number to LAWLY — same tier of action as connecting Gmail/Dropbox.
// ============================================================
const express = require('express');
const QRCode = require('qrcode');
const { authenticate, requireAdmin } = require('../lib/sessions');
const bootstrap = require('../whatsapp/groups/bootstrap');
const processor = require('../whatsapp/ingest/processor');

module.exports = function createWhatsappGroupsRouter() {
  const router = express.Router();

  router.get('/api/admin/whatsapp-groups/status', authenticate, requireAdmin, async (req, res) => {
    try {
      const status = await bootstrap.getStatus();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read status.' });
    }
  });

  router.get('/api/admin/whatsapp-groups/qr', authenticate, requireAdmin, async (req, res) => {
    const qr = bootstrap.getLatestQr();
    if (!qr) return res.status(404).json({ error: 'No QR pending — already connected or not yet generated.' });
    try {
      const png = await QRCode.toBuffer(qr, { width: 320, margin: 1 });
      res.type('png').send(png);
    } catch (e) {
      res.status(500).json({ error: 'Failed to render QR code.' });
    }
  });

  // Clears a stuck/corrupted session (e.g. the noise-handshake Buffer bug)
  // and forces a fresh QR. Same admin tier as the initial connect, since
  // it invalidates the current device link.
  router.post('/api/admin/whatsapp-groups/reset', authenticate, requireAdmin, async (req, res) => {
    try {
      const result = await bootstrap.reset();
      if (!result.ok) return res.status(409).json({ error: result.error || 'Reset failed.' });
      res.json({ ok: true, message: 'Session cleared — a new QR will be available shortly.' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to reset connector.' });
    }
  });

  router.get('/api/admin/whatsapp-groups/groups', authenticate, requireAdmin, async (req, res) => {
    try {
      const groups = await bootstrap.getGroups();
      res.json({
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          isMonitored: g.is_monitored,
          participantCount: g.participant_count,
          lastMessageAt: g.last_message_at,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to list groups.' });
    }
  });

  // Ingestion health — read-only. Lets an admin verify from the browser that
  // messages are being captured and linked, without touching the database
  // directly. No message content is exposed (it stays encrypted at rest).
  router.get('/api/admin/whatsapp-groups/ingest-health', authenticate, requireAdmin, async (req, res) => {
    try {
      const health = await bootstrap.getIngestHealth();
      res.json(health);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read ingest health.' });
    }
  });

  // Phase 4B — run the summary processor now (manual trigger for testing; the
  // batch also runs twice a day on its own). Optional ?dealId=<uuid> to process
  // just one deal. Accepts GET too, so it can be triggered straight from the
  // browser like the other admin endpoints.
  const runProcessor = async (req, res) => {
    try {
      const dealId = (req.query && req.query.dealId) || (req.body && req.body.dealId);
      const result = dealId
        ? await processor.processDeal(String(dealId))
        : await processor.processPendingDeals({ limit: 200 });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: 'Failed to run processor.', detail: e.message });
    }
  };
  router.get('/api/admin/whatsapp-groups/process', authenticate, requireAdmin, runProcessor);
  router.post('/api/admin/whatsapp-groups/process', authenticate, requireAdmin, runProcessor);

  return router;
};
