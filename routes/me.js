// ============================================================
// routes/me.js — user self-service for their OWN data.
// Every staff member can see and delete the preferences the assistant has
// learned about them, the matter notes stored for them (per agent), AND now
// (Phase 2) manage their own profile + notification settings. Everything here
// is scoped strictly to the signed-in user (req.session.userId).
//
//   GET  /api/me                   -> { name, email, roles, isAdmin }
//   GET  /api/me/memory            -> { preferences, facts }
//   POST /api/me/memory/forget     -> { kind:'preference'|'fact', text, agentId? }
//   GET  /api/me/settings          -> { name, settings }
//   PUT  /api/me/settings          -> { name?, profile?, notifications? } -> { name, settings }
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate } = require('../lib/sessions');
const memory = require('../lib/memory');
const settings = require('../lib/user-settings');
const store = require('../lib/settings-store');

module.exports = function createMeRouter() {
  const router = express.Router();

  // Who am I — lets the settings page greet the user and show the admin section
  // only to admins. Read-only; no memory access.
  router.get('/api/me', authenticate, (req, res) => {
    const roles = (req.session && req.session.roles) || [];
    res.json({
      name: (req.session && req.session.name) || null,
      email: (req.session && req.session.email) || null,
      roles,
      isAdmin: roles.includes('admin'),
    });
  });

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

  // ── Phase 2: profile + notification settings ──

  // Read the signed-in user's settings (always a complete shape via defaults).
  router.get('/api/me/settings', authenticate, async (req, res) => {
    try {
      const stored = await store.getSettings(req.session.userId);
      res.json({ name: req.session.name || null, settings: settings.withDefaults(stored) });
    } catch (e) {
      console.error('[ME] settings load failed:', e.message);
      res.status(500).json({ error: 'Could not load your settings.' });
    }
  });

  // Save settings. Optionally rename the user (firm identity — unique + audited).
  // Preferences/notifications are strictly whitelisted before persistence.
  router.put('/api/me/settings', authenticate, async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    let newName = req.session.name || null;

    // 1) Optional display-name change (only if actually different).
    if (typeof body.name === 'string') {
      const requested = body.name.trim();
      const current = String(req.session.name || '').trim();
      if (requested && requested !== current) {
        try {
          const row = await store.updateDisplayName(req.session.userId, requested);
          newName = (row && row.name) || requested;
          req.session.name = newName; // reflect within this request
          db.writeAudit({
            actorId: req.session.userId, actorName: newName,
            action: 'user.name_changed', targetType: 'user', targetName: newName,
            metadata: { from: current },
          }).catch(function () {});
        } catch (e) {
          if (e.code === 'NAME_TAKEN') return res.status(409).json({ error: 'That name is already taken by another staff member.' });
          if (e.code === 'NAME_REQUIRED') return res.status(400).json({ error: 'Name cannot be empty.' });
          if (e.code === 'NAME_TOO_LONG') return res.status(400).json({ error: 'Name is too long (max 80 characters).' });
          console.error('[ME] rename failed:', e.message);
          return res.status(500).json({ error: 'Could not update your name.' });
        }
      }
    }

    // 2) Whitelist + persist profile/notification prefs (merged over current).
    try {
      const current = await store.getSettings(req.session.userId);
      const clean = settings.sanitize(body, settings.withDefaults(current));
      const saved = await store.saveSettings(req.session.userId, clean);
      res.json({ name: newName, settings: settings.withDefaults(saved) });
    } catch (e) {
      console.error('[ME] settings save failed:', e.message);
      res.status(500).json({ error: 'Could not save your settings.' });
    }
  });

  return router;
};
