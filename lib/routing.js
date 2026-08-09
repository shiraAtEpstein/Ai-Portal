// ============================================================
// lib/routing.js — pure routing logic (no DB, no I/O, no side effects).
//
// All firm chats live on the single LAWLY WhatsApp line, so the "responsible
// person" for a chat is identified by GROUP MEMBERSHIP: Yaakov Epstein (the
// partner, flagged inAllGroups) and the LAWLY line itself are in every group,
// so the responsible staff member is the ADDITIONAL staff participant.
//
// routeGroupToStaff() intersects a group's participant phones with the staff
// directory, drops the LAWLY line and any inAllGroups member (Yaakov Epstein),
// and returns whoever is left. If nothing is left (only Lawly + Yaakov, a chat
// whose participants are all @lid/unresolved, or a 1:1 DM with no group row) it
// falls back to the admin default owner (Shira) — it NEVER returns empty, so no
// unanswered chat is ever silently dropped.
// ============================================================

// Load the directory once. Kept here (not passed in) so callers can just call
// loadDirectory() — but routeGroupToStaff() also accepts an explicit directory
// for unit tests.
const path = require('path');
const fs = require('fs');

let _cached = null;
function loadDirectory() {
  if (_cached) return _cached;
  const p = path.join(__dirname, '..', 'config', 'staff-directory.json');
  _cached = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _cached;
}

// Normalize any phone-ish input to the last 9 digits (Israeli local form),
// matching whatsapp/ingest/phone.js normalizePhone(). Duplicated here (one tiny
// function) so lib/routing.js stays dependency-free and unit-testable.
function toPhone9(input) {
  let digits = String(input == null ? '' : input).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');
  if (digits.length >= 9) return digits.slice(-9);
  return digits;
}

// participantPhones: array of phone strings (any format — normalized here).
// directory: optional { defaultOwnerEmail, staff:[{name,phone9,email,inAllGroups}] };
//            defaults to config/staff-directory.json.
// Returns { responsible: [{name,email}], isDefault: boolean }.
function routeGroupToStaff(participantPhones, directory) {
  const dir = directory || loadDirectory();
  const staff = Array.isArray(dir.staff) ? dir.staff : [];
  const defaultOwner = defaultOwnerOf(dir);

  const present = new Set(
    (Array.isArray(participantPhones) ? participantPhones : [])
      .map(toPhone9)
      .filter(Boolean)
  );

  const responsible = [];
  const seen = new Set();
  for (const s of staff) {
    if (s.inAllGroups) continue;                 // Yaakov Epstein — in every group, never the router target
    if (!present.has(toPhone9(s.phone9))) continue;
    if (seen.has(s.email)) continue;
    seen.add(s.email);
    responsible.push({ name: s.name, email: s.email });
  }

  if (responsible.length === 0) {
    return { responsible: [defaultOwner], isDefault: true };
  }
  return { responsible, isDefault: false };
}

// The admin who receives anything unroutable. Prefer the explicit
// defaultOwnerEmail; fall back to the staff entry that matches it (for a name),
// else a bare Shira entry.
function defaultOwnerOf(directory) {
  const dir = directory || loadDirectory();
  const email = dir.defaultOwnerEmail || 'shira@epsteinlaw.co.il';
  const match = (dir.staff || []).find((s) => s.email === email);
  return { name: match ? match.name : 'Shira Lipner', email };
}

module.exports = { routeGroupToStaff, defaultOwnerOf, loadDirectory, toPhone9 };
