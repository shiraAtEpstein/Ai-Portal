// ============================================================
// routes/memory-admin.js — admin-only, READ-ONLY view of a user's learned
// memory (Layer 3). Lets an admin verify exactly what is stored for someone:
// trusted (promoted/confirmed) preferences and staged candidates, decrypted,
// with counts and dates. It never writes anything.
//
//   GET /api/admin/memory?email=<address>
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../lib/sessions');
const memory = require('../lib/memory');

module.exports = function createMemoryAdminRouter() {
  const router = express.Router();

  router.get('/api/admin/memory', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query parameter is required.' });
    try {
      const user = await db.getUserAuthByEmail(email);
      if (!user) return res.status(404).json({ error: 'No such user in the database.' });
      const mem = await memory.listForUser(user.id);
      res.json({
        email,
        name: user.name,
        promoteAfter: memory.PROMOTE_AFTER,   // sightings needed to trust a staged item
        decayDays: memory.DECAY_DAYS,
        trustedCount: mem.trusted.length,
        stagedCount: mem.staged.length,
        trusted: mem.trusted,   // the preferences currently shaping this user's chats
        staged: mem.staged,     // candidates not yet trusted (with seen_count)
      });
    } catch (e) {
      console.error('[ADMIN] memory view failed:', e.message);
      res.status(500).json({ error: 'Could not load the memory view.' });
    }
  });

  return router;
};
