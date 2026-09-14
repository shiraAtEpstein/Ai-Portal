// ============================================================
// lib/responsible.js — the single RESPONSIBLE staff member for a WhatsApp
// group's case, taken from the linked monday deal's "person in charge"
// (paralegal / deal_owner) column.
//
// Responsibility is set once per case and does not change, so we resolve it the
// FIRST time a group is needed and cache it on the group row (responsible_email).
// No periodic sync. A group with no linked deal / no name match resolves to ''
// (empty) — meaning "route to the default owner" — and is not re-queried.
//
// --- 2026-09-14 — monday's person isn't always actually IN the chat -------
// Two things found while chasing why staff were getting Task Hub items for
// WhatsApp groups they don't even belong to: monday can name someone as
// "responsible" for a deal who was never added to the actual WhatsApp group
// (a reassignment on monday that never got mirrored into WhatsApp), and a
// name match with no participant check has no way to catch that. Per Shira:
// group MEMBERSHIP is the ground truth for whose responsibility a
// conversation is, not whatever monday says — if the resolved person isn't
// in the group, it just isn't their responsibility.
//
// So resolveAndStore() now does two more things after the existing monday
// name-match:
//   1. Verifies the matched staffer's phone is actually in the group's
//      participant_phones. If not, the match is discarded (treated as if
//      monday had given no match at all).
//   2. When there is still no usable match, falls back to whoever has
//      ACTUALLY been corresponding in this specific chat — the most
//      recently active staff member per processing_jobs.sender_staff_phone9
//      — skipping the partner (Yaakov Epstein, the inAllGroups staffer) so a
//      lone reaction or drive-by reply from him doesn't override someone who
//      is really running the conversation. He is only used if he is the
//      ONLY staff member who has ever sent a message in that chat.
//
// NOT changed here, flagged for a separate decision: this function still
// only ever resolves once and caches even a failed/empty result forever
// (see the comment above) — so a group that resolved to '' before this fix
// existed will NOT get re-run through the new logic on its own. That needs
// its own pass (or a "re-resolve if still empty" rule) once Shira decides
// how she wants stuck groups re-attempted.
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

// Is this staff member actually IN the group? Ground truth for responsibility
// per Shira — a monday name-match that isn't a participant doesn't count.
// participant_phones holds phone9-format numbers, same as staff.phone9.
function staffIsParticipant(staff, group) {
  if (!staff || !staff.phone9) return false;
  const phones = (group && Array.isArray(group.participant_phones)) ? group.participant_phones : [];
  return phones.indexOf(String(staff.phone9)) !== -1;
}

// Fallback when monday gives no usable match: the most recently active
// staff member in THIS chat (config/staff-directory.json is the source for
// which phone9 is which staffer). Skips the partner (inAllGroups) unless he
// is the only staffer who has ever messaged here. Returns a staff record or
// null (nobody on staff has ever sent a message in this chat).
async function lastActiveStaffFallback(jid, dir) {
  const staff = (dir && dir.staff) || [];
  let actives;
  try {
    actives = await ingestDb.lastActiveStaffPhone9s(jid);
  } catch (e) {
    console.error('[responsible] last-active lookup failed for', jid, e.message);
    return null;
  }
  const byPhone = new Map();
  for (const s of staff) { if (s && s.phone9) byPhone.set(String(s.phone9), s); }

  let partnerFallback = null;
  for (const a of actives) {
    const s = byPhone.get(String(a.phone9));
    if (!s) continue;
    if (!s.inAllGroups) return s;         // most recent non-partner staffer wins
    if (!partnerFallback) partnerFallback = s; // remember him in case he's all there is
  }
  return partnerFallback; // null if nobody recognized ever messaged here
}

// Resolve a group's responsible from monday and CACHE it on the group row.
// Returns { email, name, rawMondayName }. email='' means "no match -> default".
async function resolveAndStore(jid, dir) {
  let rawMondayName = null;
  let mondayMatch = null;
  let match = null;
  let source = 'monday';
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
    mondayMatch = rawMondayName ? matchStaffByName(rawMondayName, dir) : null;

    // monday said someone, but that someone isn't actually in the group —
    // not their responsibility, whatever the deal record says.
    if (mondayMatch && !staffIsParticipant(mondayMatch, g)) {
      console.log(`[responsible] "${jid}" monday match "${mondayMatch.email}" is not a participant in the group — discarding`);
      mondayMatch = null;
    }

    // 2026-09-14 (Shira): who monday says is in charge of the DEAL isn't
    // always who's actually handling THIS chat right now — someone can be
    // covering, or the case can shift hands mid-conversation. So the most
    // recently active staff member in the chat (lastActiveStaffFallback —
    // same partner-exclusion rule as the no-monday-link case below) is
    // checked even when monday gave a perfectly valid, in-group match, and
    // wins if it names someone DIFFERENT — that person gets it "for now".
    // If nobody recognized has corresponded, or the most recent correspondent
    // IS monday's person, monday's assignment stands.
    const active = await lastActiveStaffFallback(jid, dir);
    if (active && (!mondayMatch || active.email !== mondayMatch.email)) {
      match = active;
      source = mondayMatch ? 'last-active-staff (overrides monday)' : 'last-active-staff';
    } else if (mondayMatch) {
      match = mondayMatch;
      source = 'monday';
    } else {
      match = null;
      source = 'default';
    }
  } catch (e) {
    console.error('[responsible] resolve failed for', jid, e.message);
  }
  const email = match ? match.email : '';
  try {
    await groupsDb.setGroupResponsibleByJid(jid, email, match ? match.name : (rawMondayName || null));
  } catch (e) {
    console.error('[responsible] store failed for', jid, e.message);
  }
  console.log(`[responsible] "${jid}" -> monday="${rawMondayName || '(none)'}" -> ${match ? match.email + ' (' + source + ')' : '(default owner)'}`);
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

module.exports = {
  matchStaffByName,
  resolveAndStore,
  addresseeFromText,
  staffIsParticipant,
  lastActiveStaffFallback,
};
