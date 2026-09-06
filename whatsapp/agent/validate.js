// ============================================================
// whatsapp/agent/validate.js — the code-side guard. Runs on every draft AFTER
// the model, BEFORE the queue. Pure function, no I/O, fully unit-testable.
//
// A draft passes only if every check passes. Checks (Fact Specs v2 §3.4):
//   unverified_figure  every number/date/amount in the text exists in the slots
//                      or the answer entry; amounts in words ("three hundred
//                      thousand", "300 אלף") count as figures too
//   identifier_leak    9-digit runs, phone numbers, IBAN-like strings, emails not
//                      at the firm's domain — blocked even if a slot OR an Answer
//                      Bank entry had them. This is deliberate: the agent never
//                      sends bank details, IDs or phone numbers; a client who asks
//                      for the firm's account gets a person (see redteam.json)
//   undeclared_fact    a facts_used entry whose value is in neither slots nor entry
//   unknown_name       a proper name not present in slots / turns / staff / entry
//   language_mismatch  draft language != classifier language
//   too_long           > 120 words
//   empty              no text
//
//   validate({ text, factsUsed, slots, entry, lang, turns, staffNames, firmDomain })
//     -> { ok, reasons: [], details: {} }
// ============================================================

const FIRM_DOMAIN = 'epsteinlaw.co.il';

function flatten(v, out = []) {
  if (v == null) return out;
  if (Array.isArray(v)) { for (const x of v) flatten(x, out); return out; }
  if (typeof v === 'object') { for (const k of Object.keys(v)) if (k !== 'source' && k !== 'as_of') flatten(v[k], out); return out; }
  out.push(String(v));
  return out;
}

// Numbers as they might be written: 1,540,221 / 1540221 / 299,000 / 15.5 / 01.02.2026 / 2026-02-01
const NUM_RE = /\d[\d,.\/-]*\d|\d/g;
function normNum(s) { return String(s).replace(/[,\s]/g, '').replace(/\.0+$/, ''); }
function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').match(NUM_RE) || []) {
    const n = normNum(m);
    if (n.replace(/\D/g, '').length >= 2) out.add(n);
  }
  return out;
}
// dates written 01.02.2026, 1/2/2026, 2026-02-01 → all forms of the same digits.
// The bare year is allowed too, so a date spelled out ("1 בפברואר 2026",
// "February 1, 2026") passes; the day and month are < 3 digits and never strict.
function dateVariants(s) {
  const out = new Set([normNum(s)]);
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { out.add(`${iso[3]}.${iso[2]}.${iso[1]}`); out.add(`${Number(iso[3])}.${Number(iso[2])}.${iso[1]}`); out.add(`${iso[3]}/${iso[2]}/${iso[1]}`); out.add(`${Number(iso[2])}/${Number(iso[3])}/${iso[1]}`); out.add(iso[1] + '-' + iso[2] + '-' + iso[3]); out.add(iso[3] + '/' + iso[2]); out.add(iso[2] + '/' + iso[3]); out.add(iso[1]); }
  return [...out].map(normNum);
}

// Amounts written in words ("three hundred thousand", "כ-300 אלף", "half a million")
// carry no digits, so the number check cannot see them. A magnitude word in the
// draft that appears in neither the slots nor the entry is treated as an
// unverified figure.
const MAGNITUDE_RE = /\b(hundred|thousand|million|billion|grand)s?\b|(?:^|[^א-ת])(מאה|מאות|אלף|אלפים|מיליון|מיליונים|מיליארד)(?![א-ת])/gi;
function magnitudeWords(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(MAGNITUDE_RE)) out.add((m[1] || m[2]).toLowerCase());
  return out;
}

function allowedNumbers(slots, entry) {
  const allowed = new Set();
  const vals = flatten(slots).concat(entry ? [entry.answer_md, ...(entry.question_forms || [])] : []);
  for (const v of vals) {
    for (const m of String(v).match(NUM_RE) || []) for (const d of dateVariants(m)) allowed.add(d);
    for (const d of dateVariants(v)) allowed.add(d);
  }
  return allowed;
}

const ID_RE = /(?<!\d)\d{9}(?!\d)/;                                   // Israeli ID / passport-like
const PHONE_CAND_RE = /[+\d][\d\s().-]{7,}\d/g;                         // phone-ish candidates (054-123-4567, 054.123.4567, (02) 123 4567); amounts (commas) never match
function looksLikePhone(s) {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;         // a dotted date (01.02.2026) has 8 digits and never gets here
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return false;          // ISO date
  return true;
}
// IBAN with or without the usual 4-char grouping (IL62 0108 0000 0009 9999 999)
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,4})?\b/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function identifierLeaks(text, firmDomain) {
  const reasons = [];
  const t = String(text || '');
  // 9-digit runs are checked with spaces, dashes and dots removed between digit groups
  // ("012-345-678", "012 345 678", "012.345.678") so grouping cannot hide an ID.
  if (ID_RE.test(t.replace(/(?<=\d)[\s.-]+(?=\d)/g, ''))) reasons.push('nine_digit_run');
  if ((t.match(PHONE_CAND_RE) || []).some(looksLikePhone)) reasons.push('phone_pattern');
  if (IBAN_RE.test(t)) reasons.push('iban_pattern');
  for (const e of t.match(EMAIL_RE) || []) if (!e.toLowerCase().endsWith('@' + firmDomain)) reasons.push('external_email');
  return reasons;
}

// Proper names: capitalised words (EN) not at sentence start and not common words; Hebrew names are
// hard to detect lexically, so for Hebrew we only check Latin-script names.
const COMMON = new Set(['Hi', 'Hello', 'Good', 'Thanks', 'Thank', 'Please', 'The', 'We', 'You', 'Your', 'Our', 'It', 'This', 'That', 'If', 'When', 'Once', 'Also', 'In', 'For', 'As', 'On', 'At', 'To', 'Of', 'And', 'But', 'Or', 'So', 'Yes', 'No', 'Unfortunately', 'Let', 'Can', 'Could', 'Would', 'Will', 'Zoom', 'WhatsApp', 'Israel', 'Israeli', 'Jerusalem', 'Tabu', 'Land', 'Registry', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Shabbat', 'Shabbos', 'BH', 'IYH', 'Mazal', 'Tov', 'Shavua', 'Chag', 'Sameach', 'Purim', 'Pesach', 'Sukkot', 'Sukkos', 'Rosh', 'Hashana', 'Yom', 'Kippur', 'NIS', 'USD', 'VAT', 'POA', 'KYC', 'CBS', 'Drive', 'Dropbox', 'Google', 'Maps', 'Givat', 'Shaul', 'Epstein', 'Co', 'Adv', 'Mr', 'Mrs', 'Ms', 'Dr', 'Rabbi', 'Tax', 'Authority', 'Municipality', 'Ok', 'Okay', 'Great', 'Perfect', 'Received', 'Best', 'Regards', 'Sure', 'Not', 'Just', 'Any', 'All', 'Both', 'Each', 'Either', 'Have', 'Has', 'Had', 'Do', 'Does', 'Did', 'Is', 'Are', 'Was', 'Were', 'Be', 'Been', 'Regarding', 'Re', 'Update', 'Updated', 'Checking', 'Sent', 'Send', 'Signing', 'Contract', 'Company', 'Seller', 'Buyer', 'Bank', 'Notary', 'Apostille', 'Arnona', 'Kablan', 'Shovar', 'Shovarim', 'Madad', 'Nesach', 'Ishur', 'Bituach', 'Leumi', 'Misrad', 'Hapnim', 'Mamad', 'Tofes', 'English', 'Hebrew', 'I', 'A', 'An', 'My', 'Me', 'He', 'She', 'They', 'Them', 'Their', 'There', 'Here', 'Then', 'Now', 'Today', 'Tomorrow', 'Yesterday', 'Morning', 'Afternoon', 'Evening', 'Week', 'Next', 'Last', 'First', 'Second', 'Final']);
function latinNames(text) {
  const out = new Set();
  const sentences = String(text || '').split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/);
    words.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
      if (!clean || clean.length < 3) return;
      if (i === 0) return;                             // sentence start
      if (!/^[A-Z][a-z]+$/.test(clean)) return;
      if (COMMON.has(clean)) return;
      out.add(clean);
    });
  }
  return out;
}

function langOf(text) {
  const h = (String(text || '').match(/[֐-׿]/g) || []).length;
  const e = (String(text || '').match(/[A-Za-z]/g) || []).length;
  if (!h && !e) return 'none';
  if (h && e && Math.min(h, e) / Math.max(h, e) > 0.3) return 'mixed';
  return h >= e ? 'he' : 'en';
}

function validate({ text, factsUsed = [], slots = {}, entry = null, lang, turns = [], staffNames = [], firmDomain = FIRM_DOMAIN, maxWords = 120 } = {}) {
  const reasons = [];
  const details = {};
  const t = String(text || '').trim();
  if (!t) return { ok: false, reasons: ['empty'], details };

  // 1. numbers / dates / amounts
  const allowed = allowedNumbers(slots, entry);
  const bad = [...numbersIn(t)].filter((n) => !allowed.has(n) && !dateVariants(n).some((d) => allowed.has(d)));
  // allow bare small counts that the voice uses ("1) 2) 3)", "two of you") — only ≥ 3 digits or dates are checked strictly
  const badStrict = bad.filter((n) => n.replace(/\D/g, '').length >= 3 || /[./-]/.test(n));
  // amounts in words: a magnitude word the sources never use is an invented figure
  const sourceText = flatten(slots).concat(entry ? [entry.answer_md] : []).join('\n');
  const sourceMag = magnitudeWords(sourceText);
  const spelled = [...magnitudeWords(t)].filter((w) => !sourceMag.has(w));
  if (spelled.length) { badStrict.push(...spelled); details.spelled = spelled; }
  if (badStrict.length) { reasons.push('unverified_figure'); details.unverified = badStrict; }

  // 2. identifiers
  const leaks = identifierLeaks(t, firmDomain);
  if (leaks.length) { reasons.push('identifier_leak'); details.leaks = leaks; }

  // 3. declared facts must exist
  const known = flatten(slots).concat(entry ? [entry.answer_md] : []).map((s) => s.toLowerCase());
  const undeclared = factsUsed.filter((f) => !known.some((k) => k.includes(String(f.value).toLowerCase()) || String(f.value).toLowerCase().includes(k)));
  if (undeclared.length) { reasons.push('undeclared_fact'); details.undeclared = undeclared.map((f) => f.value); }

  // 4. names
  const knownNames = new Set();
  for (const v of flatten(slots)) for (const w of v.split(/\s+/)) knownNames.add(w.replace(/[^A-Za-z]/g, ''));
  for (const tr of turns) for (const w of String(tr.text || '').split(/\s+/)) knownNames.add(w.replace(/[^A-Za-z]/g, ''));
  for (const n of staffNames) for (const w of String(n).split(/\s+/)) knownNames.add(w.replace(/[^A-Za-z]/g, ''));
  if (entry) for (const w of String(entry.answer_md).split(/\s+/)) knownNames.add(w.replace(/[^A-Za-z]/g, ''));
  const unknown = [...latinNames(t)].filter((n) => !knownNames.has(n));
  if (unknown.length) { reasons.push('unknown_name'); details.unknown_names = unknown; }

  // 5. language
  const dl = langOf(t);
  if (lang && dl !== 'none' && lang !== 'mixed' && dl !== lang) { reasons.push('language_mismatch'); details.draft_lang = dl; }

  // 6. length
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > maxWords) { reasons.push('too_long'); details.words = words; }

  return { ok: reasons.length === 0, reasons, details };
}

module.exports = { validate, numbersIn, identifierLeaks, latinNames, langOf, magnitudeWords };
