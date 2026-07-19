// ============================================================
// routes/me.js — user self-service for their OWN data.
// Every staff member can see and delete the preferences the assistant has
// learned about them, the matter notes stored for them (per agent), add a
// preference by hand, edit their own AI Profile, AND manage their own profile
// settings + notifications. Everything here is scoped strictly to the signed-in
// user (req.session.userId / req.session.email).
//
//   GET  /api/me                   -> { name, email, roles, isAdmin }
//   GET  /api/me/memory            -> { preferences, facts }
//   POST /api/me/memory/forget     -> { kind:'preference'|'fact', text, agentId? }
//   POST /api/me/memory/add        -> { text }                    (add a preference)
//   GET  /api/me/settings          -> { name, settings }
//   GET  /api/me/core              -> { text, files }  (User Framework Layer 2, assembled)
//   GET  /api/me/core/docs         -> { docs:[{key,label,file,text}], editable }
//   PUT  /api/me/core/doc          -> { key, text } -> { ok, text }   (edit a profile section)
//   PUT  /api/me/settings          -> { name?, profile?, notifications? } -> { name, settings }
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate } = require('../lib/sessions');
const memory = require('../lib/memory');
const settings = require('../lib/user-settings');
const store = require('../lib/settings-store');
const userFramework = require('../lib/user-framework');
const dropbox = require('../lib/dropbox');

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
      // Case-insensitive: roles may be stored capitalized (e.g. "Admin").
      isAdmin: roles.some((r) => String(r).toLowerCase() === 'admin'),
    });
  });

  // The signed-in user's AI Profile (CORE): their User Framework (Layer 2) text,
  // read from Dropbox via lib/user-framework. Empty text means no personal
  // profile yet (pure Firm Core). Scoped to the signed-in user's own email.
  router.get('/api/me/core', authenticate, async (req, res) => {
    try {
      const email = (req.session && req.session.email) || '';
      const fw = await userFramework.loadForEmail(email);
      // Dropbox unreachable is NOT the same as "no profile" — say so, rather
      // than telling a user with a real CORE that they don't have one.
      if (fw && fw.error) {
        return res.status(503).json({ error: 'Your AI profile is temporarily unavailable.' });
      }
      res.json({ text: (fw && fw.text) || '', files: (fw && fw.files) || [] });
    } catch (e) {
      console.error('[ME] core load failed:', e.message);
      res.status(500).json({ error: 'Could not load your AI profile.' });
    }
  });

  // The four editable AI Profile sections (raw text, per file). `editable` says
  // whether saving is currently possible (firm Dropbox configured + connected).
  // A real Dropbox failure is reported as 503, not an empty profile.
  router.get('/api/me/core/docs', authenticate, async (req, res) => {
    try {
      const email = (req.session && req.session.email) || '';
      const docs = await userFramework.listDocs(email);
      let editable = false;
      try { editable = dropbox.configured() && (await dropbox.isConnected()); }
      catch (_) { editable = false; }
      res.json({ docs, editable });
    } catch (e) {
      console.error('[ME] core docs load failed:', e.message);
      res.status(503).json({ error: 'Your AI profile is temporarily unavailable.' });
    }
  });

  // Save one AI Profile section back to the user's own Dropbox folder. Only the
  // four whitelisted keys are writable (enforced in lib/user-framework). Needs
  // the Dropbox app's write scope; a missing scope is reported clearly so an
  // admin can enable it rather than the user seeing a generic failure.
  router.put('/api/me/core/doc', authenticate, async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const key = String(body.key || '').trim();
    const text = (typeof body.text === 'string') ? body.text : '';
    if (!key) return res.status(400).json({ error: 'Which profile section? (key is required)' });
    try {
      const email = (req.session && req.session.email) || '';
      const saved = await userFramework.writeDoc(email, key, text);
      db.writeAudit({
        actorId: req.session.userId, actorName: req.session.name || null,
        action: 'user.profile_edited', targetType: 'user', targetName: req.session.email || null,
        metadata: { section: key },
      }).catch(function () {});
      res.json({ ok: true, text: saved });
    } catch (e) {
      if (e.code === 'BAD_KEY') return res.status(400).json({ error: 'Unknown profile section.' });
      if (e.code === 'NO_USER') return res.status(400).json({ error: 'Could not identify your account.' });
      if (e.missingScope) return res.status(403).json({ error: 'Saving to your profile needs Dropbox write access, which an administrator must enable for the firm.' });
      if (/not connected/i.test(e.message || '')) return res.status(503).json({ error: 'The firm Dropbox isn’t connected, so your profile can’t be saved right now.' });
      console.error('[ME] profile save failed:', e.message);
      res.status(500).json({ error: 'Could not save your profile.' });
    }
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

  // Add a PREFERENCE by hand (no chat needed). Preferences only — memory stores
  // "how you like to work", never client/matter facts. memory.remember() applies
  // the same looksLikeClientFact guard used by the chat pipeline; when it rejects
  // the text we tell the user why instead of failing silently.
  router.post('/api/me/memory/add', authenticate, async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Please type the preference to remember.' });
    try {
      const ok = await memory.remember(req.session.userId, text);
      if (!ok) {
        return res.status(422).json({
          error: 'Memory stores how you like to work, not client or matter details. Try a preference like “always reply in Hebrew” or “keep answers short.”',
        });
      }
      db.writeAudit({
        actorId: req.session.userId, actorName: req.session.name || null,
        action: 'user.memory_added', targetType: 'user', targetName: req.session.email || null,
        metadata: { kind: 'preference' },
      }).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[ME] memory add failed:', e.message);
      res.status(500).json({ error: 'Could not save that preference.' });
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
