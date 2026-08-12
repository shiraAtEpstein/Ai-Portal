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

// Match a monday "person" text (may hold one or more names) to a staff member.
// Try full-name containment first, then first-name. Returns the staff object or null.
function matchStaffByName(personText, dir) {
  const staff = (dir && dir.staff) || [];
  const t = String(personText || '').toLowerCase().trim();
  if (!t) return null;
  for (const s of staff) {
    const n = String(s.name || '').toLowerCase().trim();
    if (n && t.indexOf(n) !== -1) return s;
  }
  for (const s of staff) {
    const first = String(s.name || '').toLowerCase().trim().split(/\s+/)[0];
    if (first && first.length >= 2 && t.indexOf(first) !== -1) return s;
  }
  return null;
}

// Resolve a group's responsible from monday and CACHE it on the group row.
// Returns { email, name, rawMondayName }. email='' means "no match -> default".
async function resolveAndStore(jid, dir) {
  let rawMondayName = null;
  let match = null;
  try {
    rawMondayName = await monday.responsibleNameForGroup(jid);
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

module.exports = { matchStaffByName, resolveAndStore };
