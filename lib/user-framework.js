// ============================================================
// lib/user-framework.js — Layer 2 of the portal framework stack.
//
// The "User Framework": small, per-user DELTAS layered on top of the read-only
// Firm Core (the house rules loaded in routes/chat.js firmPreamble). It holds
// only how THIS person prefers to work — never a copy of firm policy. The Firm
// Core always wins; this text is applied only where it does not conflict.
//
// Storage: hand-authored Markdown files in the SAME Dropbox App folder the firm
// rules and agent files already load from. One folder per user, keyed by the
// signed-in email, holding the four "always loaded" files from section 5.1 of
// the architecture:
//
//   <USERS_ROOT>/<email-lowercased>/profile.md
//   <USERS_ROOT>/<email-lowercased>/preferences.md
//   <USERS_ROOT>/<email-lowercased>/dos-and-donts.md
//   <USERS_ROOT>/<email-lowercased>/overrides.md
//
// Only those four files are read here, and the combined text is capped so it can
// never crowd out the firm rules in the prompt. A user with NO folder gets
// nothing added — pure Firm Core (the empty-state default the design requires).
//
// Reads are cached; a user can also EDIT their own four files from the portal
// (readDoc / listDocs / writeDoc), which is why lib/dropbox now has a guarded
// writeFile. Writing only ever touches the signed-in user's own folder and only
// the four whitelisted files — the path is built from a sanitized email slug and
// a fixed file name, so nothing user-supplied reaches the Dropbox path.
//
// Design notes that match the rest of the codebase:
//   * Dropbox is the single source of truth (like firm rules/agents);
//   * a short per-user in-memory cache, like lib/dropbox.js caches its token;
//   * the Dropbox reader/writer are injectable so this unit-tests without a network.
// ============================================================
const dropbox = require('./dropbox');

// Where per-user folders live inside the Dropbox App folder. Absolute app-folder
// path, same convention as FIRM_RULES_PATH in routes/chat.js.
const USERS_ROOT = (process.env.USER_FRAMEWORK_ROOT || '/shared-claude/users').replace(/\/+$/, '');

// The four always-loaded files, in priority order (architecture section 5.1).
const FILES = [
  { key: 'profile',       file: 'profile.md',       label: 'Profile' },
  { key: 'preferences',   file: 'preferences.md',   label: 'Communication & working preferences' },
  { key: 'dos_and_donts', file: 'dos-and-donts.md', label: "Personal dos and don'ts" },
  { key: 'overrides',     file: 'overrides.md',     label: 'Explicit overrides of firm defaults (each with a reason)' },
];

// Keep the whole block to about one page so the firm rules stay dominant.
const MAX_TOTAL_CHARS = parseInt(process.env.USER_FRAMEWORK_MAX_CHARS || '4000', 10);
// Per-file cap on edits saved from the portal, so one section can never grow
// large enough to dominate the assembled block above.
const MAX_DOC_CHARS = parseInt(process.env.USER_FRAMEWORK_MAX_DOC_CHARS || '4000', 10);
const CACHE_TTL_MS = parseInt(process.env.USER_FRAMEWORK_TTL_MS || '300000', 10); // 5 min

// slug -> { at, value }  where value is { text, files, error }
const _cache = new Map();

// A read error is only "normal" when the file simply isn't there. Anything else
// — Dropbox disconnected, bad token, network — must NOT be reported as an empty
// profile, or a user with a real CORE would be told they have none.
// lib/dropbox.js flags notFound; the message check also covers injected/fake
// readers in tests and any older error shape.
function isMissing(err) {
  if (err && err.notFound === true) return true;
  if (err && err.status === 404) return true;
  return /not_found/i.test(String((err && err.message) || ''));
}

function slugForEmail(email) {
  // Lowercase + strip anything that is not a valid email character. Emails come
  // from trusted Google auth (they cannot contain '/'), but sanitizing here makes
  // Dropbox path traversal impossible by construction — '/', '..', spaces, etc.
  // can never reach the folder path built from this slug.
  return String(email || '').trim().toLowerCase().replace(/[^a-z0-9._%+@-]/g, '');
}

function docForKey(key) {
  return FILES.find((f) => f.key === key) || null;
}

// Read one user's always-loaded files from Dropbox. `reader` is injectable so
// this can be unit-tested without a live Dropbox (defaults to lib/dropbox).
async function fetchFramework(email, reader) {
  const readFile = (reader && reader.readFile) || dropbox.readFile;
  const slug = slugForEmail(email);
  if (!slug) return { sections: [], files: [] };
  const base = USERS_ROOT + '/' + slug;
  const sections = [];
  const files = [];
  for (const f of FILES) {
    let raw = '';
    try {
      raw = String((await readFile(base + '/' + f.file)) || '').trim();
    } catch (e) {
      if (!isMissing(e)) throw e; // a real failure — let the caller report it
      raw = ''; // a missing file is normal — just skip it silently
    }
    if (raw) { sections.push({ label: f.label, body: raw }); files.push(f.file); }
  }
  return { sections, files };
}

// Join the present sections into one block, capped at MAX_TOTAL_CHARS so a
// runaway file can never dominate the prompt.
function assemble(sections) {
  let out = '';
  for (const s of sections) {
    const block = '## ' + s.label + '\n' + s.body + '\n\n';
    if (out.length + block.length > MAX_TOTAL_CHARS) {
      const room = MAX_TOTAL_CHARS - out.length;
      if (room > 200) out += block.slice(0, room) + '\n…(trimmed to fit)\n';
      break;
    }
    out += block;
  }
  return out.trim();
}

// Public: load a user's framework, cached. Returns { text, files, error } where
// text is '' when the user has no framework (empty-state -> pure Firm Core), and
// error is 'unavailable' when Dropbox itself could not be read (as opposed to the
// user simply having no files). Passing opts.reader (tests) bypasses the cache.
async function loadForEmail(email, opts = {}) {
  const slug = slugForEmail(email);
  if (!slug) return { text: '', files: [], error: null };
  const now = Date.now();
  if (!opts.reader) {
    const hit = _cache.get(slug);
    if (hit && (now - hit.at) < CACHE_TTL_MS) return hit.value;
  }

  let value = { text: '', files: [], error: null };
  try {
    const { sections, files } = await fetchFramework(email, opts.reader);
    value = { text: assemble(sections), files, error: null };
  } catch (e) {
    console.error('[USER-FW] load failed for ' + slug + ':', e.message);
    // text stays '' so chat still degrades to pure Firm Core, but `error` lets a
    // UI say "temporarily unavailable" instead of "you have no profile".
    value = { text: '', files: [], error: 'unavailable' };
  }
  // Never cache a failure: a 5-minute cached outage would outlive the outage.
  if (!opts.reader && !value.error) _cache.set(slug, { at: now, value });
  return value;
}

// ── Per-file editing (portal AI Profile page) ──

// Read one section's RAW text (uncapped, untrimmed) for the edit box. A missing
// file returns '' (that section just hasn't been written yet). A real Dropbox
// failure throws, so the caller can say "temporarily unavailable".
async function readDoc(email, key, opts = {}) {
  const readFile = (opts.reader && opts.reader.readFile) || dropbox.readFile;
  const slug = slugForEmail(email);
  const f = docForKey(key);
  if (!slug || !f) return '';
  try {
    return String((await readFile(USERS_ROOT + '/' + slug + '/' + f.file)) || '');
  } catch (e) {
    if (isMissing(e)) return '';
    throw e;
  }
}

// Read all four sections' raw text for the AI Profile page. Returns an array of
// { key, label, file, text } in priority order. A real Dropbox failure throws.
async function listDocs(email, opts = {}) {
  const readFile = (opts.reader && opts.reader.readFile) || dropbox.readFile;
  const slug = slugForEmail(email);
  const out = [];
  for (const f of FILES) {
    let text = '';
    if (slug) {
      try {
        text = String((await readFile(USERS_ROOT + '/' + slug + '/' + f.file)) || '');
      } catch (e) {
        if (!isMissing(e)) throw e;
        text = '';
      }
    }
    out.push({ key: f.key, label: f.label, file: f.file, text });
  }
  return out;
}

// Save one section's text back to Dropbox (overwrite). Only the four whitelisted
// keys are writable, and the path is built from a sanitized slug + fixed file
// name, so nothing user-supplied reaches the Dropbox path. Length is capped, and
// the per-user cache is busted so the next load (and next chat) reflect the edit.
async function writeDoc(email, key, content, opts = {}) {
  const writeFile = (opts.writer && opts.writer.writeFile) || dropbox.writeFile;
  const slug = slugForEmail(email);
  const f = docForKey(key);
  if (!slug) { const e = new Error('could not identify user'); e.code = 'NO_USER'; throw e; }
  if (!f) { const e = new Error('unknown profile section'); e.code = 'BAD_KEY'; throw e; }
  let text = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS);
  await writeFile(USERS_ROOT + '/' + slug + '/' + f.file, text);
  _cache.delete(slug); // next load reflects the edit immediately
  return text;
}

// Render the framework as a system-prompt block with an explicit precedence
// header, so the model always subordinates it to the Firm Core above it.
function render(framework, name) {
  if (!framework || !framework.text) return '';
  const who = name ? (' for ' + name) : '';
  return [
    '===== PERSONAL PROFILE & PREFERENCES' + who + ' =====',
    'The following describes how THIS user prefers to work. Apply it whenever it',
    'does not conflict with the FIRM RULES above. If any of it conflicts with a',
    'firm, security, compliance, or legal rule, the FIRM RULE ALWAYS WINS and you',
    'follow the firm rule. These are personal preferences and deltas only — they',
    'never override firm policy, and they are not client or matter facts.',
    '',
    framework.text,
  ].join('\n');
}

function clearCache() { _cache.clear(); }

module.exports = {
  loadForEmail, render, fetchFramework, assemble, slugForEmail, clearCache,
  readDoc, listDocs, writeDoc,
  USERS_ROOT, FILES, MAX_DOC_CHARS,
};
