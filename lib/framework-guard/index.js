'use strict';

/**
 * framework-guard.js
 * ------------------
 * A real, deterministic-first output gate for the LAWLY / Epstein & Co. portal.
 *
 * WHY THIS EXISTS
 * ---------------
 * A language model has no separate "check step" that runs automatically before
 * it speaks - so a promise from the model to "always verify" is not enforceable.
 * This module is the enforcement the model cannot give itself: it runs on the
 * SERVER, between "model produced output" and "output reaches the user / an
 * action is taken". If the output violates the framework, it never leaves.
 *
 * TWO TIERS
 * ---------
 *   Tier 1 (deterministic): fast, certain, free. Catches the mechanical rules -
 *     language mismatch, wrong signer name, em-dash, banned tells, currency,
 *     and any date/amount that is not present in the allowed source material.
 *   Tier 2 (critic): a pluggable second model call for the fuzzy rules -
 *     "reads AI-generated", an invented fact that is phrased to look real,
 *     restricted-data leaks. You supply the model call; the guard supplies the
 *     prompt and validates the JSON it returns.
 *
 * USAGE (minimal) - from routes/chat.js this is require('../lib/framework-guard')
 * ---------------
 *   const { validateOutput } = require('../lib/framework-guard');
 *   const report = await validateOutput(draftText, {
 *     channel: 'email',                 // 'email' | 'whatsapp' | 'chat' | 'doc'
 *     expectedLanguage: 'en',           // 'he' | 'en' | 'match'
 *     operatorLanguage: 'en',           // language the operator wrote in
 *     profile: { name: 'Shira' },       // the signed-in user (USER_FRAMEWORK)
 *     source: mondayFactsText,          // the ONLY facts the draft may assert
 *   });
 *   if (!report.pass) {  ... block, show report.violations, regenerate ...  }
 *
 * Every violation is { rule, severity, message, evidence, fix }.
 */

const R = require('./rules');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const HEBREW_RE = /[֐-׿]/;
const HEBREW_G  = /[֐-׿]/g;
const LATIN_G   = /[A-Za-z]/g;

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

/** Dominant script of a piece of text: 'he', 'en', or 'none'. */
function detectLanguage(text) {
  const he = countMatches(text, HEBREW_G);
  const en = countMatches(text, LATIN_G);
  if (he === 0 && en === 0) return 'none';
  return he >= en ? 'he' : 'en';
}

/** Normalise for fact-membership: collapse whitespace, strip thousands seps. */
function normFact(s) {
  return String(s)
    .replace(/[,٬  ]/g, '') // commas / thin / nbsp / arabic sep
    .replace(/\s+/g, '')
    .toLowerCase();
}

function v(rule, message, evidence, fix) {
  const severity = R.BLOCKING.has(rule) ? severityFor(rule) : R.SEVERITY.WARNING;
  return { rule, severity, message, evidence, fix };
}

function severityFor(rule) {
  // em-dash, unverified/invented facts, restricted leaks, wrong name, wrong
  // language and the two-Yaakovs are all treated as CRITICAL - each was a real
  // outbound-quality failure. Everything else that blocks is HIGH.
  const critical = new Set([
    'language-mismatch', 'signature-mismatch', 'unverified-fact',
    'two-yaakovs', 'em-dash', 'restricted-data-leak', 'invented-fact',
  ]);
  return critical.has(rule) ? R.SEVERITY.CRITICAL : R.SEVERITY.HIGH;
}

// A span already wrapped as [VERIFY: ...] is the CORRECT behaviour, not a miss.
function stripVerifyPlaceholders(text) {
  return text.replace(/\[VERIFY:[^\]]*\]/gi, ' ');
}

// ---------------------------------------------------------------------------
// TIER 1 - deterministic checks. Each returns an array of violations.
// ---------------------------------------------------------------------------

/** STYLE §2 - conversation/output must be in the required language. */
function checkLanguage(text, ctx) {
  const out = [];
  let expected = ctx.expectedLanguage || 'match';
  if (expected === 'match') expected = ctx.operatorLanguage || null;
  if (!expected) return out; // nothing to enforce against

  const actual = detectLanguage(text);
  if (actual === 'none') return out;
  if (actual !== expected) {
    out.push(v(
      'language-mismatch',
      `Output is in "${actual}" but the required language is "${expected}".`,
      `detected ${actual}`,
      `Regenerate the whole response in "${expected}". ` +
      (ctx.expectedLanguage === 'match'
        ? 'Rule: match the language the operator wrote in (STYLE §2).'
        : 'Rule: the profile pins the reply language (USER_FRAMEWORK override).')
    ));
  }
  return out;
}

/**
 * House rule + profile: an email draft is signed by the signed-in user, not by
 * a name scraped from the conversation. Catches the "Tzipora / צפורה" failure.
 */
function checkSignature(text, ctx) {
  const out = [];
  if (!ctx.profile || !ctx.profile.name) return out;
  if (ctx.channel && !['email', 'whatsapp', 'doc'].includes(ctx.channel)) return out;

  const sender = ctx.profile.name;                    // e.g. "Shira"
  const senderTokens = [sender, ctx.profile.he].filter(Boolean).map(s => s.toLowerCase());

  // Find a sign-off, then read the name on the following non-empty line(s).
  const SIGNOFFS = [
    'בברכה', 'בכבוד רב', 'בברכה,', 'תודה', 'Best regards', 'Best', 'Regards',
    'Sincerely', 'Kind regards', 'Warm regards', 'Thanks',
  ];
  const lines = text.split(/\r?\n/).map(l => l.trim());
  let signatureName = null;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase().replace(/[,]/g, '');
    if (SIGNOFFS.some(s => low === s.toLowerCase() || low.startsWith(s.toLowerCase()))) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]) { signatureName = lines[j]; break; }
      }
      break;
    }
  }

  const checkName = (name, where) => {
    if (!name) return;
    const low = name.toLowerCase();
    if (senderTokens.some(t => low.includes(t))) return; // correct signer present
    // Is it a *different* known staff name? -> definitely wrong signer.
    const otherStaff = R.STAFF_NAME_TOKENS
      .filter(tok => !senderTokens.includes(tok.toLowerCase()))
      .find(tok => name.includes(tok));
    if (otherStaff) {
      out.push(v(
        'signature-mismatch',
        `Draft is signed "${name}" (${where}) but the signed-in user is "${sender}".`,
        name,
        `Replace the signer with "${sender}". Never take the sender name from ` +
        `the conversation; take it from the profile.`
      ));
    } else if (where === 'signature block') {
      // An unknown name sitting in the signature slot is still suspicious.
      out.push(v(
        'signature-mismatch',
        `Signature name "${name}" does not match the signed-in user "${sender}".`,
        name,
        `Confirm the signer. If this is the sender, it must read "${sender}".`
      ));
    }
  };

  checkName(signatureName, 'signature block');
  return out;
}

/** House rule: never collapse the two Yaakovs. */
function checkTwoYaakovs(text) {
  const out = [];
  // "Yaakov" (paralegal spelling, 'ak') must always carry the surname.
  const bareYaakov = /\bYaakov\b(?!\s+Hershkovitz)/g;
  if (bareYaakov.test(text)) {
    out.push(v(
      'two-yaakovs',
      'The spelling "Yaakov" (the paralegal) appears without the surname ' +
      '"Hershkovitz". The bare name is ambiguous with the boss, Yaacov Epstein.',
      'Yaakov (no surname)',
      'Write "Yaakov Hershkovitz" in full, or use "Yaacov" (ac) if the boss is meant.'
    ));
  }
  return out;
}

/** STYLE §4.3 - em-dash and en dash banned everywhere, no exceptions. */
function checkEmDash(text) {
  const out = [];
  for (const d of R.DASH_CHARS) {
    if (text.includes(d)) {
      out.push(v(
        'em-dash',
        `Banned dash character "${d}" found. Em/en dashes are forbidden ` +
        'everywhere (STYLE §4.3), including chat.',
        d,
        'Replace with a hyphen "-", a comma, or split into two sentences.'
      ));
    }
  }
  return out;
}

/** STYLE §4.1 / §4.3 - banned jargon, AI tells, generic closings, emojis. */
function checkBannedPhrases(text, ctx) {
  const out = [];
  // These bans apply to client-facing OUTPUT, not to internal chat.
  if (ctx.channel === 'chat') return out;

  const low = text.toLowerCase();
  for (const phrase of R.BANNED_PHRASES) {
    if (low.includes(phrase)) {
      out.push(v(
        'banned-phrase',
        `Banned phrase / AI tell: "${phrase}" (STYLE §4.1/§4.3).`,
        phrase,
        'Remove it or rewrite the sentence the way a lawyer at the firm would.'
      ));
    }
  }
  for (const so of R.BANNED_SIGNOFFS) {
    if (low.includes(so)) {
      out.push(v(
        'banned-signoff',
        `Generic closing "${so}" - a closing must say something concrete (STYLE §4.1).`,
        so,
        'Replace with a real next step or a concrete sign-off, or drop it.'
      ));
    }
  }
  // Decorative emojis (allow functional • → ✓).
  const emojiRe = /[←-⇿⌀-➿⬀-⯿\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}️]/gu;
  const emojis = (text.match(emojiRe) || []).filter(ch => !R.ALLOWED_MARKS.includes(ch));
  if (emojis.length) {
    out.push(v(
      'decorative-emoji',
      `Decorative emoji in output: ${[...new Set(emojis)].join(' ')} (STYLE §4.3).`,
      [...new Set(emojis)].join(' '),
      'Remove decorative emojis. Only functional • → ✓ are allowed.'
    ));
  }
  return out;
}

/** House rule: currency is NIS unless asked; don't convert to USD unprompted. */
function checkCurrency(text, ctx) {
  const out = [];
  if (ctx.channel === 'chat') return out;
  if (ctx.allowUSD) return out;
  if (/\$\s?\d|\bUSD\b/.test(text)) {
    out.push(v(
      'currency-usd',
      'A USD amount appears but the default currency is NIS and USD was not requested.',
      (text.match(/\$\s?[\d,]+|\bUSD\b/) || [''])[0],
      'Keep amounts in ש"ח / NIS unless the operator asked for USD.'
    ));
  }
  return out;
}

/** STYLE §4.2 - numbers should be numerals (warning). */
function checkNumerals(text, ctx) {
  const out = [];
  if (ctx.channel === 'chat') return out;
  const low = ' ' + text.toLowerCase() + ' ';
  for (const w of R.SPELLED_NUMBERS) {
    const re = new RegExp(`[^\\p{L}]${w}[^\\p{L}]`, 'u');
    if (re.test(low)) {
      out.push(v(
        'spelled-number',
        `Number written as a word ("${w}"); output should use numerals (STYLE §4.2).`,
        w,
        `Use the numeral instead of "${w}".`
      ));
      break; // one warning is enough
    }
  }
  return out;
}

/**
 * STYLE §5.2 - never guess dates, amounts, IDs. THE keystone check.
 * Every concrete date and money amount in the output must appear in the
 * provided `source` (monday data + the document the operator gave). Anything
 * else must be wrapped as [VERIFY: ...]. A bare, unsourced date is the exact
 * "just guessed a date" failure.
 */
function checkUnverifiedFacts(text, ctx) {
  const out = [];
  if (!ctx.source) return out; // can't verify without the allowed facts
  const haystack = normFact(ctx.source);
  const scan = stripVerifyPlaceholders(text); // ignore correctly-marked spans

  const patterns = [
    // Jan 5, 2026 / January 5 2026
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/g,
    // 5 January 2026
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/g,
    // 5/1/2026, 05.01.26, 5-1-2026
    /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g,
    // 2026-01-05
    /\b\d{4}-\d{2}-\d{2}\b/g,
    // Hebrew: 5 בינואר 2026
    /\b\d{1,2}\s+ב(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s+\d{4}\b/g,
    // money: ₪1,200,000 / 1,200,000 ש"ח / 1200000 NIS / $500
    /(?:₪|\$)\s?[\d,]{3,}/g,
    /\b[\d,]{4,}\s?(?:ש"ח|שח|ש״ח|NIS|ILS|USD|\$|₪)\b/g,
  ];

  const seen = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(scan)) !== null) {
      const token = m[0].trim();
      if (seen.has(token)) continue;
      seen.add(token);
      if (!haystack.includes(normFact(token))) {
        const kind = /[₪$]|ש"ח|שח|NIS|ILS|USD/.test(token) ? 'amount' : 'date';
        out.push(v(
          'unverified-fact',
          `The ${kind} "${token}" is not present in the provided source ` +
          `(monday / the document). Under STYLE §5.2 it must not be asserted.`,
          token,
          `Pull the ${kind} from monday or the source doc, or replace it with ` +
          `a marked placeholder: [VERIFY: ${kind}].`
        ));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TIER 1 runner
// ---------------------------------------------------------------------------

function runDeterministic(text, ctx) {
  return [
    ...checkLanguage(text, ctx),
    ...checkSignature(text, ctx),
    ...checkTwoYaakovs(text),
    ...checkEmDash(text),
    ...checkBannedPhrases(text, ctx),
    ...checkCurrency(text, ctx),
    ...checkNumerals(text, ctx),
    ...checkUnverifiedFacts(text, ctx),
  ];
}

// ---------------------------------------------------------------------------
// TIER 2 - the LLM critic. Pluggable: you pass ctx.critic = async (messages) => text
// ---------------------------------------------------------------------------

/** Build the messages for the critic model. Returns [{role, content}]. */
function buildCriticMessages(text, ctx) {
  const system =
    'You are a strict compliance reviewer for the Epstein & Co. law firm. ' +
    'You are given a candidate OUTPUT and the SOURCE facts it is allowed to ' +
    'rely on. Find violations of these rules ONLY:\n' +
    '1. invented-fact: any client name, ID, address, date, percentage, or ' +
    'amount stated as fact that is NOT supported by SOURCE and is not wrapped ' +
    'as [VERIFY: ...].\n' +
    '2. sounds-ai: the text reads like it was written by a chatbot, not a ' +
    'lawyer at the firm (template openings, filler hedges, bold-led bullet ' +
    'stuffing, rhetorical-question stacks).\n' +
    '3. restricted-data-leak: the output exposes banking, accounting, payment, ' +
    'or firm-memory data to a non-Yaacov user.\n' +
    '4. tone: grovelling, over-apologising, or "Sure! Happy to help!" padding.\n\n' +
    'Return ONLY a JSON object: {"violations":[{"rule":"invented-fact",' +
    '"message":"...","evidence":"...","fix":"..."}]}. Empty array if clean. ' +
    'Do NOT use em-dashes in your own message text.';
  const user =
    `USER ROLE: ${(ctx.profile && ctx.profile.role) || 'staff'}\n` +
    `CHANNEL: ${ctx.channel || 'unknown'}\n\n` +
    `SOURCE (the only facts OUTPUT may assert):\n${ctx.source || '(none provided)'}\n\n` +
    `OUTPUT to review:\n${text}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function runCritic(text, ctx) {
  if (typeof ctx.critic !== 'function') return { ran: false, violations: [] };
  const messages = buildCriticMessages(text, ctx);
  let raw;
  try {
    raw = await ctx.critic(messages);
  } catch (err) {
    return { ran: false, violations: [], error: String(err && err.message || err) };
  }
  let parsed;
  try {
    // tolerate a model that wraps JSON in prose / fences
    const jsonStr = (raw.match(/\{[\s\S]*\}/) || [raw])[0];
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { ran: false, violations: [], error: 'critic returned non-JSON' };
  }
  const violations = (parsed.violations || []).map(it => {
    const rule = it.rule || 'critic-flag';
    const severity = R.BLOCKING.has(rule) ? severityFor(rule) : R.SEVERITY.HIGH;
    return {
      rule,
      severity,
      message: it.message || '(no message)',
      evidence: it.evidence || '',
      fix: it.fix || '',
      source: 'critic',
    };
  });
  return { ran: true, violations };
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * validateOutput(text, ctx) -> { pass, blocked, violations, tier1, tier2 }
 *
 * ctx fields:
 *   channel           'email' | 'whatsapp' | 'chat' | 'doc'   (default: 'doc')
 *   expectedLanguage  'he' | 'en' | 'match'
 *   operatorLanguage  'he' | 'en'         (used when expectedLanguage='match')
 *   profile           { name, he?, role? } - the signed-in user (USER_FRAMEWORK)
 *   source            string - the ONLY facts the output may assert
 *   allowUSD          boolean
 *   critic            async (messages) => string   (enables Tier 2)
 *   runCritic         boolean (default: true when critic is a function)
 */
async function validateOutput(text, ctx = {}) {
  const tier1 = runDeterministic(text || '', ctx);

  let tier2 = { ran: false, violations: [] };
  const wantCritic = ctx.runCritic !== false && typeof ctx.critic === 'function';
  if (wantCritic) tier2 = await runCritic(text || '', ctx);

  const violations = [...tier1, ...tier2.violations];
  const blocked = violations.filter(x =>
    x.severity === R.SEVERITY.CRITICAL || x.severity === R.SEVERITY.HIGH);

  return {
    pass: blocked.length === 0,
    blocked: blocked.length > 0,
    violations,             // everything, warnings included
    blocking: blocked,      // only the ones that stop delivery
    tier1,
    tier2,
  };
}

/**
 * generateWithGuard - the real "check before returning" loop.
 * Regenerates up to maxAttempts, feeding the violations back to the generator
 * so the model fixes them, and only returns output that passes. If it never
 * passes, returns the last attempt with pass=false so the SERVER can decide to
 * hold it for human review rather than send a bad draft.
 *
 *   generate: async (feedback|null) => string   (your model call)
 */
async function generateWithGuard(generate, ctx = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  let feedback = null;
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await generate(feedback);
    const report = await validateOutput(text, ctx);
    last = { text, report, attempt };
    if (report.pass) return last;
    feedback = formatFeedback(report.blocking);
  }
  return last; // pass === false; caller holds for review
}

/** Turn violations into a correction instruction for the next generation. */
function formatFeedback(violations) {
  const lines = violations.map((x, i) =>
    `${i + 1}. [${x.rule}] ${x.message} Fix: ${x.fix}`);
  return 'Your previous draft violated firm rules. Fix ALL of these and ' +
    'regenerate the full output:\n' + lines.join('\n');
}

/** Human-readable one-line-per-violation summary (for logs / chat). */
function formatReport(report) {
  if (report.pass) return 'PASS - no blocking violations.';
  return report.blocking.map(x =>
    `${x.severity.toUpperCase()} [${x.rule}] ${x.message}`).join('\n');
}

module.exports = {
  validateOutput,
  generateWithGuard,
  buildCriticMessages,
  formatReport,
  formatFeedback,
  detectLanguage,   // exported for testing
  _internal: { runDeterministic, runCritic },
};
