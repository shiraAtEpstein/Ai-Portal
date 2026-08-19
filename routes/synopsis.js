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
const synopsis = require('../lib/synopsis');
const { buildFacts, findMissing, applyWrite, READ_ONLY } = synopsis;

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));
const MAX_VALUES = 80;

const audit = require('../lib/synopsis/audit');

/** Only roles with the 'synopsis' capability may open the generator at all. */
function requireSynopsis(req, res, next) {
  if (!can(req.session.roles, 'synopsis', 'use')) {
    audit.record({ event: 'access.denied', ok: false, user: req.session.email,
                   userId: req.session.userId, roles: req.session.roles,
                   reason: 'role has no synopsis capability' });
    return res.status(403).json({ error: 'הפקת סינופסיס פתוחה לפרליגל, אדמין וטק בלבד.' });
  }
  next();
}
const newRunId = () => 'syn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

/** Columns to fetch per board, derived from the map — nothing else is read. */
const DEAL_COLUMNS  = [...new Set(MAP.fields.filter(f => f.readFrom === 'deal').map(f => f.columnId).filter(Boolean))]
                        .concat(['connect_boards_165__1', 'connect_boards94__1', 'link_to_______2__1']);
const ownerCols = owner => [...new Set(
  MAP.fields.filter(f => f.readFrom === 'owner' && f.owner === owner).map(f => f.ownerColumnId).filter(Boolean))];
const OWNER_COLUMNS = { client: ownerCols('client'), client2: ownerCols('client2'), project: ownerCols('project') };

/**
 * Status / dropdown labels for every board on the map, cached for the process.
 * Only the deal board was fetched before, which is why a status column on the
 * client or project card rendered as a plain text box instead of a dropdown.
 */
let _options = null;
async function loadOptions() {
  if (_options) return _options;
  const byBoardId = {};
  for (const owner of Object.keys(MAP.boards)) {
    const id = MAP.boards[owner].id;
    if (!byBoardId[id]) byBoardId[id] = await synopsis.optionsFor(id);
  }
  _options = {};
  for (const owner of Object.keys(MAP.boards)) _options[owner] = byBoardId[MAP.boards[owner].id];
  return _options;
}

/** Read the deal, then its linked client and project items, and work out what is missing. */
async function loadDeal(dealId) {
  const item = await synopsis.getDeal(dealId, [...new Set(DEAL_COLUMNS)]);
  const ownerItemIds = {
    project: item.column_values['connect_boards_165__1']?.linked?.[0]?.id || null,
    client:  item.column_values['connect_boards94__1']?.linked?.[0]?.id || null,
    client2: item.column_values['link_to_______2__1']?.linked?.[0]?.id || null
  };
  // Owner-board fields are read from the real item, never through a mirror.
  const [client, client2, project] = await Promise.all([
    synopsis.getItemColumns(ownerItemIds.client,  OWNER_COLUMNS.client),
    synopsis.getItemColumns(ownerItemIds.client2, OWNER_COLUMNS.client2),
    synopsis.getItemColumns(ownerItemIds.project, OWNER_COLUMNS.project)
  ]);
  const { values, sources, linkedIds } = buildFacts(MAP, item, { client, client2, project });
  const context = { clientLinked: !!ownerItemIds.client, client2Linked: !!ownerItemIds.client2,
                    projectLinked: !!ownerItemIds.project };
  const { missing, present, hidden } = findMissing(MAP, values, context);
  return { item, values, sources, linkedIds, missing, present, hidden, ownerItemIds, context };
}

module.exports = function createSynopsisRouter() {
  const router = express.Router();

  // ---- 1. deal picker -------------------------------------------------
  router.get('/api/synopsis/deals', authenticate, requireSynopsis, async (req, res) => {
    try {
      if (!can(req.session.roles, 'monday', 'read_board'))
        return res.status(403).json({ error: 'Your roles may not read the monday boards.' });
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ deals: [] });
      res.json({ deals: await synopsis.searchDealsByName(q, MAP.dealBoards) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- 2. everything monday knows, and what it does not -------------
  router.post('/api/synopsis/facts', authenticate, requireSynopsis, async (req, res) => {
    try {
      if (!can(req.session.roles, 'monday', 'read_board'))
        return res.status(403).json({ error: 'Your roles may not read the monday boards.' });
      const dealId = String(req.body?.dealId || '');
      if (!dealId) return res.status(400).json({ error: 'dealId is required' });

      const d = await loadDeal(dealId);
      const options = await loadOptions();
      for (const f of d.missing) f.options = options[f.owner]?.[f.columnId] || null;

      const runId = newRunId();
      audit.record({ runId, event: 'run.open', ok: true, dealId, dealName: d.item.name,
                     user: req.session.email, userId: req.session.userId, roles: req.session.roles,
                     detail: { filled: d.present.length, missing: d.missing.length,
                               requiredMissing: d.missing.filter(f => f.required).length,
                               linked: d.context } });

      res.json({
        runId,
        hidden: d.hidden,
        linked: d.context,
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

  // ---- 2b. pick an item to link (client / project) --------------------
  router.get('/api/synopsis/lookup', authenticate, requireSynopsis, async (req, res) => {
    try {
      if (!can(req.session.roles, 'monday', 'read_board'))
        return res.status(403).json({ error: 'Your roles may not read the monday boards.' });
      const board = String(req.query.board || '');
      const q = String(req.query.q || '').trim();
      if (!MAP.boards[board]) return res.status(400).json({ error: 'unknown board' });
      if (q.length < 2) return res.json({ items: [] });
      res.json({ items: await synopsis.lookupItems(MAP.boards[board].id, q) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- 3. write the answers back --------------------------------------
  router.post('/api/synopsis/fill', authenticate, requireSynopsis, async (req, res) => {
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
        runId,
        hidden: d.hidden,
        linked: d.context, written, rejected,
        remaining: missing.length,
        remainingRequired: stillRequired.length,
        canContinue: stillRequired.filter(f => f.writable).length === 0,
        blockedBy: stillRequired.map(f => ({ label: f.label, board: f.ownerBoard, writable: f.writable })),
        readOnlyMode: READ_ONLY
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- 4. the log, for admin / tech -----------------------------------
  router.get('/api/synopsis/audit', authenticate, requireSynopsis, async (req, res) => {
    try {
      const isAdmin = (req.session.roles || []).some(r => ['admin', 'tech'].includes(String(r).toLowerCase()));
      if (!isAdmin) return res.status(403).json({ error: 'Admin or tech only.' });
      const { rows, stored } = await audit.recent({
        dealId: req.query.dealId || null, runId: req.query.runId || null, limit: req.query.limit });
      res.json({ rows, stored });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
