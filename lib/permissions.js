// ============================================================
// lib/permissions.js — capability permissions, decoupled from agents.
//
// A user's ROLE decides what they can do (read the monday board, write their
// own deals, build files, etc). Agents/skills no longer gate tools at all —
// they only carry knowledge. This is the layer chat.js asks: "may this role
// do X?" before wiring a tool or (later) committing a write.
//
// Operations per connection:
//   monday:   read_own | read_board | write_own | write_any
//   gmail:    read | draft            (draft = compose only; never send)
//   dropbox:  read | write
//   calendar: read | write
//   files:    build
//   synopsis: use               (open the synopsis generator at all)
// ============================================================
const PERMS_RAW = require('../config/permissions.json');

// Roles are stored capitalized for some users ("Admin", "Tech") and lowercase for
// others, so every lookup here is case-insensitive. requireAdmin in lib/sessions.js
// already compares case-insensitively; this did not, which silently gave an admin
// zero capabilities.
const PERMS = {};
for (const [role, caps] of Object.entries(PERMS_RAW)) {
  if (role.startsWith('_') || typeof caps !== 'object') continue;
  PERMS[String(role).toLowerCase()] = caps;
}
const CONNECTIONS = ['monday', 'gmail', 'dropbox', 'calendar', 'files', 'synopsis'];

// Union of every operation the given roles are granted, per connection.
function capabilitiesFor(roles) {
  const caps = {};
  for (const c of CONNECTIONS) caps[c] = new Set();
  for (const role of (roles || [])) {
    const rc = PERMS[String(role).trim().toLowerCase()];
    if (!rc || typeof rc !== 'object') continue;
    for (const c of CONNECTIONS) for (const op of (rc[c] || [])) caps[c].add(op);
  }
  return caps;
}

// True if any of the user's roles grants `operation` on `connection`.
function can(roles, connection, operation) {
  const caps = capabilitiesFor(roles);
  return !!(caps[connection] && caps[connection].has(operation));
}

module.exports = { capabilitiesFor, can, CONNECTIONS };
