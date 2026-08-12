// ============================================================
// lib/responsible.js — the single RESPONSIBLE staff member for a WhatsApp
// group's case, taken from the linked monday deal's "person in charge"
// (paralegal / deal_owner) column.
//
// Responsibility is set once per case and does not change, so we resolve it the
// FIRST time a group is needed and cache it on the group row (responsible_email).
// No periodic sync. A group with no linked deal / no name match resolves to ''
// (empty) — meaning "route to the default owner" — and is not re-queried.
// ============================================================
const monday = require('./monday');
const groupsDb = require('../whatsapp/groups/db');
const ingestDb = require('../whatsapp/ingest/db');

// Match a monday "person" text (may hold one or more names) to a staff member.
// Careful with the TWO YAAKOVS (Yaakov Epstein the partner vs Yaakov Hershkovitz):
// a bare first name "Yaakov" must NOT default to whoever is first in the list.
//   1) full-name containment (all name tokens) — reliable, includes the partner
//   2) surname (last token) containment — surnames are unique
//   3) first-name only — ambiguous: match only among NON-inAllGroups staff (so a
//      lone "Yaakov" means Hershkovitz, not the partner Epstein), and only when
//      it's unique there. Otherwise no match -> caller falls back.
function matchStaffByName(personText, dir) {
  const staff = (dir && dir.staff) || [];
  const t = String(personText || '').toLowerCase().trim();
  if (!t) return null;
  const norm = (s) => String(s || '').toLowerCase().trim();

  // 1) full name
  for (const s of staff) {
    const n = norm(s.name);
    if (n && t.indexOf(n) !== -1) return s;
  }
  // 2) surname (last token, unique)
  for (const s of staff) {
    const toks = norm(s.name).split(/\s+/).filter(Boolean);
    const last = toks[toks.length - 1];
    if (last && last.length >= 3 && t.indexOf(last) !== -1) return s;
  }
  // 3) first name only — disambiguate the two Yaakovs by excluding the partner
  const firstMatches = staff.filter((s) => {
    if (s.inAllGroups) return false;
    const first = norm(s.name).split(/\s+/)[0];
    return first && first.length >= 2 && t.indexOf(first) !== -1;
  });
  if (firstMatches.length === 1) return firstMatches[0];
  return null;
}

// Resolve a group's responsible from monday and CACHE it on the group row.
// Returns { email, name, rawMondayName }. email='' means "no match -> default".
async function resolveAndStore(jid, dir) {
  let rawMondayName = null;
  let match = null;
  try {
    // Preferred: use the deal the ingestion ALREADY linked to this group (via
    // group-id column OR group-name match), so we cover far more groups than
    // the group-id column alone.
    const g = await groupsDb.getGroupByJid(jid);
    if (g && g.deal_id) {
      const deal = await ingestDb.getDeal(g.deal_id);
      if (deal) rawMondayName = await monday.responsibleNameForDeal(deal.monday_board_id, deal.monday_item_id);
    }
    // Fallback: resolve straight from the group-id column if no cached deal.
    if (!rawMondayName) rawMondayName = await monday.responsibleNameForGroup(jid);
    match = rawMondayName ? matchStaffByName(rawMondayName, dir) : null;
  } catch (e) {
    console.error('[responsible] resolve failed for', jid, e.message);
  }
  const email = match ? match.email : '';
  try {
    await groupsDb.setGroupResponsibleByJid(jid, email, match ? match.name : (rawMondayName || null));
  } catch (e) {
    console.error('[responsible] store failed for', jid, e.message);
  }
  console.log(`[responsible] "${jid}" -> monday="${rawMondayName || '(none)'}" -> ${match ? match.email : '(default owner)'}`);
  return { email, name: match ? match.name : null, rawMondayName };
}

// Does this message text explicitly ADDRESS a staff member (e.g. "היי יעקב",
// "Hi Shayna")? Returns that staff member, or null. Matches whole words against
// each staffer's surname, their first name (partner excluded, to avoid the
// two-Yaakovs trap), and any `aliases` listed on them in the directory — which
// is where Hebrew names go (e.g. "aliases": ["יעקב","הרשקוביץ"]). Ambiguous
// mentions return null (no guess). This is a PER-MESSAGE signal — it does NOT
// change the chat's stored responsible.
function addresseeFromText(text, dir) {
  const staff = (dir && dir.staff) || [];
  const t = ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
  if (t.trim().length < 2) return null;
  const norm = (s) => String(s || '').toLowerCase().trim();
  const mentions = (term) => { const w = norm(term); return w.length >= 2 && t.indexOf(' ' + w + ' ') !== -1; };

  const hits = [];
  for (const s of staff) {
    const toks = norm(s.name).split(/\s+/).filter(Boolean);
    const surname = toks[toks.length - 1];
    const first = toks[0];
    const terms = [];
    if (surname && surname.length >= 3) terms.push(surname);
    for (const a of (s.aliases || [])) terms.push(a);
    if (!s.inAllGroups && first && first.length >= 2) terms.push(first);
    if (terms.some(mentions)) hits.push(s);
  }
  if (hits.length === 1) return hits[0];
  const nonPartner = hits.filter((s) => !s.inAllGroups);
  if (nonPartner.length === 1) return nonPartner[0]; // disambiguate the two Yaakovs
  return null;
}

module.exports = { matchStaffByName, resolveAndStore, addresseeFromText };
