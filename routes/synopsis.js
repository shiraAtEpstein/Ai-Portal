// ============================================================
// routes/synopsis.js — Synopsis generator, screens 1-3.
//
//   GET  /api/synopsis/deals?q=            -> deal picker (autocomplete)
//   POST /api/synopsis/facts {dealId}      -> everything monday knows + what is missing
//   POST /api/synopsis/fill  {dealId,values} -> write the answers back, per field
//
// NO MODEL IS CALLED ANYWHERE IN THIS FILE. Screens 1-3 are deterministic.
//
// Reads go through monday.readQuery() (mutations blocked there) and are scoped
// to the column ids on config/synopsis-columns.json — nothing else on the item
// is fetched. The single write path is lib/synopsis/write-gate.js.
//
// Deliberately STATELESS: /fill re-reads the deal rather than trusting a cached
// run, so it is correct across restarts and multiple instances, and the
// before-values in the audit line are what monday actually held a moment ago.
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('../lib/sessions');
const { can } = require('../lib/permissions');
const read = require('../lib/synopsis/read');
const { buildFacts, findMissing } = require('../lib/synopsis/missing-fields');
const { applyWrite, READ_ONLY } = require('../lib/synopsis/write-gate');

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));
const MAPPED_COLUMNS = [...new Set(MAP.fields.map(f => f.columnId).filter(Boolean))];
const MAX_VALUES = 80;

const audit = e => console.log('[synopsis]', JSON.stringify(e));
const newRunId = () => 'syn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

/** Read a deal and work out what the synopsis still needs. */
async function loadDeal(dealId) {
  const item = await read.getDeal(dealId, MAPPED_COLUMNS);
  const { values, sources } = buildFacts(MAP, item);
  const { missing, present } = findMissing(MAP, values);
  return {
    item, values, sources, missing, present,
    ownerItemIds: {
      project: item.column_values['connect_boards_165__1']?.linked?.[0]?.id || null,
      client:  item.column_values['connect_boards94__1']?.linked?.[0]?.id || null
    }
  };
}

module.exports = function createSynopsisRouter() {
  const router = express.Router();

  // ---- 1. deal picker -------------------------------------------------
  router.get('/api/synopsis/deals', authenticate, async (req, res) => {
    try {
      if (!can(req.session.roles, 'monday', 'read_board'))
        return res.status(403).json({ error: 'Your roles may not read the monday boards.' });
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ deals: [] });
      res.json({ deals: await read.searchDealsByName(q, MAP.dealBoards) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- 2. everything monday knows, and what it does not -------------
  router.post('/api/synopsis/facts', authenticate, async (req, res) => {
    try {
      if (!can(req.session.roles, 'monday', 'read_board'))
        return res.status(403).json({ error: 'Your roles may not read the monday boards.' });
      const dealId = String(req.body?.dealId || '');
      if (!dealId) return res.status(400).json({ error: 'dealId is required' });

      const d = await loadDeal(dealId);
      const options = await read.optionsFor(MAP.boards.deal.id);
      for (const f of d.missing) f.options = options[f.columnId] || null;

      const runId = newRunId();
      audit({ runId, event: 'facts', dealId, deal: d.item.name, user: req.session.email,
              filled: d.present.length, missing: d.missing.length });

      res.json({
        runId,
        deal: { id: d.item.id, name: d.item.name, board: d.item.boardName, boardId: d.item.boardId },
        groups: MAP.groups, present: d.present, missing: d.missing,
        counts: {
          total: MAP.fields.length, filled: d.present.length, empty: d.missing.length,
          requiredEmpty: d.missing.filter(f => f.required).length,
          readOnly: d.missing.filter(f => !f.writable).length
        },
        canWrite: can(req.session.roles, 'monday', 'write_own'),
        readOnlyMode: READ_ONLY,
        mapVersion: MAP.version
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- 3. write the answers back --------------------------------------
  router.post('/api/synopsis/fill', authenticate, async (req, res) => {
    try {
      const dealId = String(req.body?.dealId || '');
      const runId = String(req.body?.runId || newRunId());
      const entries = Object.entries(req.body?.values || {});
      if (!dealId) return res.status(400).json({ error: 'dealId is required' });
      if (entries.length > MAX_VALUES) return res.status(400).json({ error: 'too many fields in one save' });
      if (!can(req.session.roles, 'monday', 'write_own'))
        return res.status(403).json({ error: 'Your roles may not write to monday.' });

      const d = await loadDeal(dealId);            // re-read: before-values are what monday holds now
      const written = [], rejected = [];

      for (const [fieldKey, value] of entries) {
        if (value === null || value === undefined || String(value).trim() === '') continue;
        try {
          const entry = await applyWrite({ action: 'update_column', fieldKey, value }, {
            map: MAP, dealId: d.item.id, dealBoardId: d.item.boardId,
            ownerItemIds: d.ownerItemIds, session: req.session, runId,
            before: d.values, log: audit
          });
          d.values[fieldKey] = value;
          written.push({ fieldKey, label: entry.proposal.fieldKey, board: entry.board });
        } catch (e) {
          if (e.audit) audit(e.audit);
          rejected.push({ fieldKey, reason: e.message });
        }
      }

      const { missing } = findMissing(MAP, d.values);
      const stillRequired = missing.filter(f => f.required);
      res.json({
        runId, written, rejected,
        remaining: missing.length,
        remainingRequired: stillRequired.length,
        canContinue: stillRequired.filter(f => f.writable).length === 0,
        blockedBy: stillRequired.map(f => ({ label: f.label, board: f.ownerBoard, writable: f.writable })),
        readOnlyMode: READ_ONLY
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
