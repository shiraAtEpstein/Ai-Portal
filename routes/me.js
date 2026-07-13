// ============================================================
// routes/me.js — user self-service for their OWN learned memory.
// Every staff member can see and delete the preferences the assistant has
// learned about them, and the matter notes stored for them (per agent). This
// is the user-facing counterpart to the admin viewer; it is scoped strictly to
// the signed-in user (req.session.userId) and only ever reads/deletes their own.
//
//   GET  /api/me/memory            -> { preferences, facts }
//   POST /api/me/memory/forget     -> { kind:'preference'|'fact', text, agentId? }
// ============================================================
const express = require('express');
const { authenticate } = require('../lib/sessions');
const memory = require('../lib/memory');

module.exports = function createMeRouter() {
  const router = express.Router();

  // Everything a user has stored about themselves (active items only).
  router.get('/api/me/memory', authenticate, async (req, res) => {
    try {
      const mem = await memory.listForUser(req.session.userId);
      const allFacts = await memory.listFactsForAdmin(req.session.userId);
      const preferences = (mem.trusted || []).filter((p) => !p.revoked).map((p) => ({
        text: p.text, source: p.source, createdAt: p.createdAt, lastReaffirmed: p.lastReaffirmed,
      }));
      const facts = (allFacts || []).filter((f) => !f.revoked).map((f) => ({
        agentId: f.agentId, text: f.text, createdAt: f.createdAt, lastReaffirmed: f.lastReaffirmed,
      }));
      res.json({ preferences, facts });
    } catch (e) {
      console.error('[ME] memory view failed:', e.message);
      res.status(500).json({ error: 'Could not load your memory.' });
    }
  });

  // Delete one of the signed-in user's own items. Preferences are revoked by
  // text; facts by (agentId, text). Uses only the memory module's exported
  // helpers, scoped to req.session.userId — a user can only ever delete their own.
  router.post('/api/me/memory/forget', authenticate, async (req, res) => {
    const kind = String((req.body && req.body.kind) || 'preference').toLowerCase();
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required.' });
    try {
      if (kind === 'fact') {
        const agentId = String((req.body && req.body.agentId) || '').trim().toLowerCase();
        if (!agentId) return res.status(400).json({ error: 'agentId is required to forget a matter note.' });
        await memory.pgStore.revokeFact(req.session.userId, agentId, memory.keyFor(text));
      } else {
        await memory.forget(req.session.userId, text);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[ME] forget failed:', e.message);
      res.status(500).json({ error: 'Could not delete that item.' });
    }
  });

  return router;
};
