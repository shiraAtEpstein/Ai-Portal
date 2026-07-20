'use strict';

/**
 * rules.js - The enforceable Epstein & Co. framework rules, as DATA.
 *
 * These are lifted verbatim in meaning from:
 *   - CLAUDE.md  §3 (house rules)
 *   - STYLE.md   §2 (language), §4.1-§4.3 (banned in output / AI tells),
 *                §4.2 (required in output), §5.2 (never guess facts)
 *
 * Edit THIS file to change what the guard enforces. The logic in
 * framework-guard.js reads these lists; it does not hard-code any phrase.
 * (Matches the architecture principle: "load rules, retrieve knowledge" -
 *  rules live in one editable place, not scattered through code.)
 */

// --- People at the firm (GLOSSARY.md "People at the firm") ------------------
// The two Yaakovs are a hard, named rule. Never collapse the spellings.
const STAFF = {
  boss:      { canonical: 'Yaacov Epstein',      spelling: 'ac', bareOk: true  },
  paralegal: { canonical: 'Yaakov Hershkovitz',  spelling: 'ak', bareOk: false },
  shira:     { canonical: 'Shira' },
  tzipora:   { canonical: 'Tzipora',  he: 'צפורה' },
};

// Every staff first-name spelling the guard recognises, for signature checks.
const STAFF_NAME_TOKENS = [
  'Yaacov', 'Yaakov', 'Epstein', 'Hershkovitz',
  'Shira', 'שירה',
  'Tzipora', 'Tzippora', 'צפורה', 'ציפורה',
  'יעקב', 'אפשטין',
];

// --- Em-dash: banned everywhere, no exceptions (STYLE §4.3) -----------------
// The long dash (U+2014) AND the en dash (U+2013). A hyphen (U+002D) is fine.
const DASH_CHARS = ['—', '–'];

// --- Decorative emojis banned in output (STYLE §4.3) ------------------------
// Functional marks are explicitly allowed: bullet, arrow, check.
const ALLOWED_MARKS = ['•', '→', '✓']; // • → ✓

// --- Banned phrases / AI tells (STYLE §4.1 and §4.3) ------------------------
// Matched case-insensitively as substrings. Applies to client-facing OUTPUT,
// not to internal chat (see channel handling in framework-guard.js).
const BANNED_PHRASES = [
  // §4.1 corporate jargon
  'synergy', 'leverage', 'ecosystem', 'holistic', 'paradigm', 'bandwidth',
  'at the end of the day', 'circle back', 'low-hanging fruit',
  // §4.1 clichéd openings
  'in today\'s fast-paced world', 'in our modern era', 'בעולם שלנו', 'כידוע',
  // §4.3 generic-helper closings
  'if you have any other questions', 'feel free to ask', 'i hope this helps',
  'let me know if you\'d like me to clarify', 'happy to dive deeper',
  'אם יש שאלות נוספות, אשמח לעזור',
  // §4.3 AI-template openings
  'here\'s a comprehensive overview', 'in this article, we\'ll explore',
  'navigating the complexities of', 'whether you\'re',
  // §4.3 AI-tell vocabulary
  'delve', 'tapestry', 'intricate', 'multifaceted', 'robust', 'seamless',
  'dive deep', 'unlock', 'elevate', 'empower',
  // §4.3 filler hedges
  'it\'s important to note that', 'it goes without saying that',
  'at its core', 'in essence',
];

// Generic closings that are only a tell when used as a sign-off (STYLE §4.1)
const BANNED_SIGNOFFS = [
  'thanks for reading', 'looking forward to hearing from you',
  'best wishes', 'תודה רבה',
];

// --- Numbers must be numerals in output (STYLE §4.2) - warning level --------
const SPELLED_NUMBERS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'שתי', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר', 'ששה', 'שישה',
];

// --- Severity model ---------------------------------------------------------
// critical / high  -> block (do not deliver; regenerate or placeholder)
// warning          -> annotate but may deliver
const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', WARNING: 'warning' };

// Which rule ids are blocking. Everything else is a warning.
const BLOCKING = new Set([
  'language-mismatch',    // STYLE §2  - example 3
  'signature-mismatch',   // house rule + profile - example 2
  'unverified-fact',      // STYLE §5.2 - example 1
  'two-yaakovs',          // house rule
  'em-dash',              // STYLE §4.3 (hard rule, no exceptions)
  'restricted-data-leak', // STYLE §5.3 (critic-flagged)
  'invented-fact',        // STYLE §5.2 (critic-flagged)
]);

module.exports = {
  STAFF,
  STAFF_NAME_TOKENS,
  DASH_CHARS,
  ALLOWED_MARKS,
  BANNED_PHRASES,
  BANNED_SIGNOFFS,
  SPELLED_NUMBERS,
  SEVERITY,
  BLOCKING,
};
