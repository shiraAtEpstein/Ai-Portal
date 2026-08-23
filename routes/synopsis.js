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
const { can, capabilitiesFor } = require('../lib/permissions');
const PERMISSIONS = require('../config/permissions.json');
const synopsis = require('../lib/synopsis');
const { buildFacts, findMissing, paymentRows, paymentChecks, derive, compare,
        applyWrite, READ_ONLY } = synopsis;

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

/** A field key in words, for the screen and the log. */
function labelFor(key, d) {
  if (String(key).startsWith('payment:')) {
    const [, itemId, columnId] = String(key).split(':');
    const row = (d.payments || []).find(p => String(p.id) === String(itemId));
    const col = MAP.payments.columns.find(c => c.id === columnId);
    return `${row ? row.title : 'תשלום'} · ${col ? col.label : columnId}`;
  }
  const f = MAP.fields.find(x => x.key === key);
  return f ? f.label : key;
}

/** Columns to fetch per board, derived from the map — nothing else is read. */
const DEAL_COLUMNS  = [...new Set(MAP.fields.filter(f => f.readFrom === 'deal').map(f => f.columnId).filter(Boolean))]
                        .concat(['connect_boards_165__1', 'connect_boards94__1', 'link_to_______2__1',
                                 MAP.payments.linkColumn]);
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
  // The payment schedule, from the linked לוח תשלומים rows.
  const payIds = (item.column_values[MAP.payments.linkColumn]?.linked || []).map(l => l.id);
  const payCols = MAP.payments.columns.map(c => c.id);
  const payments = paymentRows(MAP, await synopsis.getPayments(payIds, payCols));

  const { values, sources, linkedIds } = buildFacts(MAP, item, { client, client2, project });

  // Fees and tax are a percentage of the price — computed, never typed. Where the
  // board also holds a figure, a disagreement is surfaced rather than hidden.
  // The board's own figure remains the value — it is what the firm recorded.
  // The arithmetic is shown beneath it, and a disagreement is flagged, but the
  // computation never silently replaces what a person put on the board.
  const computed = derive(MAP, values);
  const comparison = compare(computed, values);
  const mismatches = comparison.filter(r => r.agrees === false);
  const context = { clientLinked: !!ownerItemIds.client, client2Linked: !!ownerItemIds.client2,
                    projectLinked: !!ownerItemIds.project };
  const { missing, present, hidden, fields } = findMissing(MAP, values, context, computed);
  const checks = paymentChecks(payments, values.purchase_price);
  return { item, values, sources, linkedIds, missing, present, hidden, fields,
           payments, checks, computed, mismatches, ownerItemIds, context };
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
      for (const f of d.fields) f.options = options[f.owner]?.[f.columnId] || null;

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
        fields: d.fields, values: d.values,
        payments: d.payments, checks: d.checks,
        computed: d.computed, mismatches: d.mismatches,
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
      // Fields the paralegal deliberately emptied. Kept as their own list, never
      // as an empty string inside `values`, so a field can never be wiped by an
      // input that merely happened to arrive blank.
      const clears = Array.isArray(req.body?.clear)
        ? [...new Set(req.body.clear.map(String))].slice(0, MAX_VALUES) : [];
      if (!dealId) return res.status(400).json({ error: 'dealId is required' });
      if (entries.length + clears.length > MAX_VALUES)
        return res.status(400).json({ error: 'too many fields in one save' });
      if (!can(req.session.roles, 'monday', 'write_own'))
        return res.status(403).json({ error: 'Your roles may not write to monday.' });

      const d = await loadDeal(dealId);            // re-read: before-values are what monday holds now
      const written = [], rejected = [], unchanged = [];

      for (const [fieldKey, value] of entries) {
        if (value === null || value === undefined || String(value).trim() === '') continue;
        // Identical to what monday already holds: nothing to do, but say so —
        // "I sent it and nothing happened" must never look like "it saved".
        const before = d.values[fieldKey];
        if (before !== undefined && String(before).trim() === String(value).trim()) {
          unchanged.push({ fieldKey, label: labelFor(fieldKey, d), value });
          continue;
        }
        try {
          const entry = await applyWrite({ action: 'update_column', fieldKey, value }, {
            map: MAP, dealId: d.item.id, dealBoardId: d.item.boardId,
            ownerItemIds: d.ownerItemIds, session: req.session, runId,
            before: d.values,
            // the recorder itself, with the deal stamped on every line
            log: entry => audit.record({ ...entry, event: 'write.ok',
                                         dealId: d.item.id, dealName: d.item.name })
          });
          d.values[fieldKey] = value;
          written.push({ fieldKey, label: labelFor(fieldKey, d), board: entry.board,
                         before: entry.before, after: value });
        } catch (e) {
          if (e.audit) audit(e.audit);
          rejected.push({ fieldKey, label: labelFor(fieldKey, d), reason: e.message });
        }
      }

      // Emptying a field goes through exactly the same gate as filling one, and
      // is refused if the board is already empty there — so a clear that does
      // nothing can never be reported as a clear that worked.
      const cleared = [];
      for (const fieldKey of clears) {
        try {
          const entry = await applyWrite(
            { action: 'update_column', fieldKey, value: '', clear: true }, {
              map: MAP, dealId: d.item.id, dealBoardId: d.item.boardId,
              ownerItemIds: d.ownerItemIds, session: req.session, runId,
              before: d.values, log: audit
            });
          cleared.push({ fieldKey, label: labelFor(fieldKey, d), board: entry.board,
                         before: entry.before, after: '' });
          d.values[fieldKey] = '';
        } catch (e) {
          if (e.audit) audit(e.audit);
          rejected.push({ fieldKey, label: labelFor(fieldKey, d), reason: e.message });
        }
      }

      // d.values already carries every successful write, and the page re-reads
      // the deal straight after this call — so recompute in memory rather than
      // spending another five monday calls on a second read.
      const after = findMissing(MAP, d.values, d.context, derive(MAP, d.values));
      const paymentValue = c => {
        const v = pendingPayments[`payment:${c._row}:${c.columnId}`];
        return v !== undefined ? v : c.value;
      };
      const pendingPayments = {};
      for (const w of written) if (String(w.fieldKey).startsWith('payment:')) {
        const [, itemId, columnId] = w.fieldKey.split(':');
        pendingPayments[`payment:${itemId}:${columnId}`] = w.after;
      }
      const stillRequired = after.missing.filter(f => f.required).concat(
        d.payments.flatMap(p => p.cells
          .filter(c => c.required && c.writable && !paymentValue({ ...c, _row: p.id }))
          .map(c => ({ label: p.title + ' · ' + c.label, ownerBoard: MAP.payments.boardName, writable: true }))));
      res.json({
        runId,
        hidden: d.hidden,
        linked: d.context, written, cleared, rejected,
        remaining: after.missing.length,
        remainingRequired: stillRequired.length,
        checks: d.checks,
        canContinue: stillRequired.filter(f => f.writable).length === 0,
        blockedBy: stillRequired.map(f => ({ label: f.label, board: f.ownerBoard, writable: f.writable })),
        readOnlyMode: READ_ONLY
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- 4. the reference letter this project builds from ----------------
  router.get('/api/synopsis/reference', authenticate, requireSynopsis, async (req, res) => {
    try {
      const dealId = String(req.query.dealId || '');
      if (!dealId) return res.status(400).json({ error: 'dealId is required' });
      const item = await synopsis.getDeal(dealId, ['connect_boards_165__1', 'connect_boards94__1']);
      const projectItemId = item.column_values['connect_boards_165__1']?.linked?.[0]?.id || null;
      const projectName   = item.column_values['connect_boards_165__1']?.linked?.[0]?.name || null;
      if (!projectItemId)
        return res.json({ error: null, deal: { id: item.id, name: item.name },
          projectItemId: null, projectName: null, reference: null, candidates: [],
          blocked: 'לעסקה הזו אין פרויקט מקושר — אי אפשר לדעת מאיזה מכתב לבנות.' });

      const st = await synopsis.reference.state(projectItemId, dealId);
      audit.record({ event: 'reference.view', ok: true, dealId, dealName: item.name,
                     user: req.session.email, roles: req.session.roles,
                     detail: { projectItemId, hasReference: !!st.reference,
                               candidates: st.candidates.length } });
      res.json({ deal: { id: item.id, name: item.name }, projectName: projectName || st.projectName, ...st });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Upload the project's reference letter. Raw body, so no multipart dependency:
  // the browser sends the file as the request body and the name in the query.
  //
  // Replacing an existing reference DELETES the old file — monday can only clear
  // a file column wholesale, and that cannot be undone. So a replace must name
  // the asset it expects to be replacing and carry confirm=1, and the old file
  // is backed up and restored if the new upload fails.
  router.post('/api/synopsis/reference',
    authenticate, requireSynopsis,
    express.raw({ type: '*/*', limit: '25mb' }),
    async (req, res) => {
      try {
        const dealId = String(req.query.dealId || '');
        const projectItemId = String(req.query.projectItemId || '');
        const fileName = String(req.query.fileName || '').slice(0, 200);
        const replace = String(req.query.replace || '') === '1';
        const confirmed = String(req.query.confirm || '') === '1';
        const replacingAssetId = String(req.query.replacingAssetId || '') || null;

        if (!projectItemId || !fileName)
          return res.status(400).json({ error: 'projectItemId and fileName are required' });
        if (!can(req.session.roles, 'monday', 'write_own'))
          return res.status(403).json({ error: 'Your roles may not write to monday.' });

        // Whose letter this is, read from monday rather than taken from the
        // browser. Recorded in LAWLY's own table only - monday is never told,
        // because the reference the firm cares about lives here, not there.
        let dealName = null;
        if (dealId) {
          try { dealName = (await loadDeal(dealId)).item.name || null; }
          catch (e) {
            audit.record({ event: 'reference.dealname.failed', ok: false, dealId,
                           user: req.session.email, roles: req.session.roles, reason: e.message });
          }
        }

        const asset = await synopsis.reference.uploadToProject(projectItemId, fileName, req.body, {
          replace, confirmed, replacingAssetId,
          log: e => audit.record({ ...e, dealId, user: req.session.email, roles: req.session.roles })
        });

        const saved = await synopsis.reference.setStored(projectItemId, {
          dealId: dealId || null, dealName, assetId: asset.id,
          fileName: asset.name || fileName, clientName: dealName
        }, req.session.email);

        audit.record({ event: replace ? 'reference.replaced' : 'reference.uploaded', ok: true,
                       dealId, user: req.session.email, roles: req.session.roles,
                       board: 'פרוייקטים', itemId: projectItemId,
                       columnId: synopsis.reference.PROJECT_FILE_COLUMN, after: fileName,
                       detail: { assetId: asset.id, bytes: req.body?.length || 0, replacingAssetId } });
        res.json({ saved, asset });
      } catch (e) {
        audit.record({ event: 'reference.upload.failed', ok: false, user: req.session.email,
                       roles: req.session.roles, reason: e.message });
        res.status(400).json({ error: e.message });
      }
    });

  // ---- 4b. why can I not see this? ------------------------------------
  // Deliberately NOT behind requireSynopsis: the person who needs this answer is
  // the one who does not have the capability. It reveals only the caller's own
  // roles and what they resolve to — nothing about the deals or anyone else.
  router.get('/api/synopsis/whoami', authenticate, (req, res) => {
    const roles = req.session.roles || [];
    const caps = Object.fromEntries(
      Object.entries(capabilitiesFor(roles)).map(([k, v]) => [k, [...v]]));
    const known = Object.keys(PERMISSIONS).filter(k => !k.startsWith('_'));
    const unknown = roles.filter(r => !known.includes(String(r).trim().toLowerCase()));
    const mayUse = can(roles, 'synopsis', 'use');

    let why = null;
    if (mayUse) why = 'יש לך גישה להפקת סינופסיס.';
    else if (!roles.length) why = 'למשתמש הזה אין תפקידים כלל.';
    else if (unknown.length) why =
      'התפקיד "' + unknown.join(', ') + '" לא מופיע ב־config/permissions.json, ולכן אין לו שום הרשאה — ' +
      'לא סינופסיס ולא כתיבה למנדיי. התפקידים המוכרים הם: ' + known.join(', ') + '.';
    else why = 'התפקידים ' + roles.join(', ') + ' קיימים, אבל אף אחד מהם לא כולל synopsis:use.';

    res.json({
      email: req.session.email, roles, capabilities: caps,
      mayUseSynopsis: mayUse,
      mayWriteMonday: can(roles, 'monday', 'write_own'),
      mayReadMonday: can(roles, 'monday', 'read_board'),
      unknownRoles: unknown, knownRoles: known, explanation: why
    });
  });

  // ---- 5. the log, for admin / tech -----------------------------------
  router.get('/api/synopsis/audit', authenticate, requireSynopsis, async (req, res) => {
    try {
      const isAdmin = (req.session.roles || []).some(r => ['admin', 'tech'].includes(String(r).toLowerCase()));
      if (!isAdmin) return res.status(403).json({ error: 'Admin or tech only.' });
      const q = req.query;
      const [{ rows, stored }, sum] = await Promise.all([
        audit.recent({ dealId: q.dealId || null, runId: q.runId || null, user: q.user || null,
                       event: q.event || null, outcome: q.outcome || null,
                       since: q.since || null, until: q.until || null, limit: q.limit }),
        audit.summary({ since: q.since || null, until: q.until || null })
      ]);
      res.json({ rows, stored, summary: sum });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
