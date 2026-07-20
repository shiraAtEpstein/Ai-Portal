// lib/now.js — the portal's clock for the model.
//
// WHY THIS EXISTS: the Claude API has no clock of its own. Nothing in the
// system prompt told the model what "now" is, so it fell back to its training
// cutoff — producing last-year calendar/email results, a guessed ("average")
// date at the top of the daily brief, and a morning/afternoon/evening greeting
// that was never tied to a real time. nowPreamble() pins the real current
// date, time and part-of-day (firm time zone) at the very top of every system
// prompt so every agent anchors "today", "this week", deadlines, date-range
// searches, and any greeting to the actual present moment.
//
// Firm time zone is Asia/Jerusalem; override with the FIRM_TZ env var if ever
// needed. No dependencies — uses the built-in Intl formatter.

const FIRM_TZ = process.env.FIRM_TZ || 'Asia/Jerusalem';

function partOfDay(hour) {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

// Returns a short, authoritative "this is now" block ending in a blank line,
// safe to prepend to the system prompt. `at` lets tests pass a fixed Date;
// production calls it with no argument (real clock).
function nowPreamble(at) {
  const now = at instanceof Date && !isNaN(at) ? at : new Date();

  // Human-readable date + time in the firm time zone (24h clock).
  const parts = {};
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: FIRM_TZ,
    hourCycle: 'h23',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const p of dtf.formatToParts(now)) parts[p.type] = p.value;

  const human =
    parts.weekday + ', ' + parts.day + ' ' + parts.month + ' ' + parts.year +
    ', ' + parts.hour + ':' + parts.minute;

  // ISO calendar date (YYYY-MM-DD) in the firm time zone — en-CA yields it.
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: FIRM_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const pod = partOfDay(Number(parts.hour));

  return [
    'CURRENT DATE & TIME (authoritative — treat this as "now"):',
    '- ' + human + ' (' + FIRM_TZ + ').',
    '- ISO date: ' + iso + '. Time of day: ' + pod + '.',
    'Use THIS as the present moment for everything: resolve "today", "tomorrow", "yesterday", "this week", "next week", and any deadline relative to this date only.',
    'When you search email, calendar, or monday for recent or upcoming items, anchor every date range to this date — never to a prior year. If you open with a greeting, match the time of day above (morning / afternoon / evening).',
    '',
    '',
  ].join('\n');
}

module.exports = { nowPreamble, partOfDay, FIRM_TZ };
