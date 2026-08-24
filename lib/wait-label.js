// ============================================================
// lib/wait-label.js — how a wait is WORDED, everywhere.
//
// Decided with Shira, 2026-08-24. There are two different questions and they
// must never be answered with the same number:
//
//   "how long has THIS message been sitting there?"
//        -> REAL elapsed time. A client who wrote on Thursday has been waiting
//           since Thursday, whatever the office hours were in between, and a
//           person looking at the list needs to feel that.
//        -> elapsedLabel(): today in hours, any earlier day in days.
//
//   "how fast do we answer?"
//        -> WORKING time (08:00-22:00, no Saturday — lib/business-hours.js).
//           Nobody is slow for not replying at 03:00, so the medians, the
//           percentages and the trend all run on the working clock.
//        -> workLabel(), and lib/staff-response.js fmtDur() for h:mm.
//
// Every label the firm reads comes from this file so the two clocks can never
// be swapped by accident in one place and not another. The strings are built
// SERVER-SIDE and sent to the pages ready to print: the alternative is each
// page doing its own date arithmetic in the viewer's timezone, and then the
// board says "אתמול" to somebody in London and "היום" to somebody in Tel Aviv
// about the same message.
// ============================================================
const businessHours = require('./business-hours');

// The firm's local calendar date for an instant, 'YYYY-MM-DD'. Reuses the
// working clock's timezone so "today" means the same thing in both files.
function localDate(instant) {
  const t = instant instanceof Date ? instant.getTime()
    : (typeof instant === 'number' ? instant : Date.parse(String(instant)));
  if (!Number.isFinite(t)) return null;
  return businessHours.dateKeyOf(t);
}

function daysBetweenDates(fromKey, toKey) {
  const a = Date.parse(fromKey + 'T00:00:00Z');
  const b = Date.parse(toKey + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// "How long ago was this sent" — Shira's wording, exactly:
//   sent today            -> hours   ("לפני 3 שעות")
//   sent on an older day  -> days    ("אתמול", "לפני 4 ימים")
//
// Days are counted in CALENDAR DAYS, not in 24-hour blocks. A message sent at
// 23:00 last night is nine hours old but it is not from today, and calling it
// "לפני 9 שעות" the next morning reads as though it arrived while people were
// at their desks. "אתמול" is the true and more useful sentence.
function elapsedLabel(sentAt, now) {
  const dayOf = localDate(sentAt);
  if (!dayOf) return '';
  const today = localDate(now == null ? Date.now() : now);
  const days = daysBetweenDates(dayOf, today);

  if (days <= 0) {
    // Raw hours, NOT elapsedHours() — that rounds to one decimal, so 58 minutes
    // became 1.0 and then floored to a flat "לפני שעה".
    const t = sentAt instanceof Date ? sentAt.getTime() : Date.parse(String(sentAt));
    const end = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
    const hours = (end - t) / 3600000;
    if (!Number.isFinite(hours) || hours < 1) return 'לפני פחות משעה';
    const hr = Math.floor(hours);
    if (hr === 1) return 'לפני שעה';
    if (hr === 2) return 'לפני שעתיים';
    return 'לפני ' + hr + ' שעות';
  }
  if (days === 1) return 'אתמול';
  if (days === 2) return 'שלשום';
  return 'לפני ' + days + ' ימים';
}

// Real elapsed hours. Used for sorting and for the aggregate "oldest waiting"
// figures — NOT for the row colour, which follows elapsedTone() below so that
// the colour and the words above it can never disagree.
function elapsedHours(sentAt, now) {
  const t = sentAt instanceof Date ? sentAt.getTime() : Date.parse(String(sentAt));
  if (!Number.isFinite(t)) return null;
  const end = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
  return Math.max(0, Math.round(((end - t) / 3600000) * 10) / 10);
}

// The row's colour, decided by the SAME calendar-day count the label is built
// from. Colouring by an hours threshold instead looked equivalent and was not:
// a message sent at 23:50 and read at 00:10 says "אתמול" and is 0.3 hours old,
// so an hours-based rule painted it calm-green under a word that says it has
// been sitting since yesterday.
//
//   today            -> ok    (teal)
//   yesterday / שלשום -> warn  (amber)
//   three days or more -> bad  (red)
function elapsedTone(sentAt, now) {
  const dayOf = localDate(sentAt);
  if (!dayOf) return 'ok';
  const days = daysBetweenDates(dayOf, localDate(now == null ? Date.now() : now));
  if (days <= 0) return 'ok';
  if (days <= 2) return 'warn';
  return 'bad';
}

// The MEASUREMENT wording: a number of WORKING hours, in working days once it
// passes two of them. Used for speed figures, never for "how long has this been
// sitting there". A working day is 14 hours, so dividing by 24 here would print
// "3 ימים" for a wait that is really five calendar days long.
function workLabel(workingHours) {
  // Number(null) is 0, not NaN — so a missing value would otherwise print
  // "פחות משעה", which claims a measurement that was never taken.
  if (workingHours == null || workingHours === '') return '—';
  const n = Number(workingHours);
  if (!Number.isFinite(n)) return '—';
  if (n < 1) return 'פחות משעה';
  const dayH = businessHours.config().workingDayHours || 14;
  if (n >= dayH * 2) {
    const d = Math.round(n / dayH);
    if (d <= 1) return 'יום עבודה';
    if (d === 2) return 'יומיים';
    return d + ' ימי עבודה';
  }
  const hr = Math.max(1, Math.round(n));
  if (hr === 1) return 'שעה';
  if (hr === 2) return 'שעתיים';
  return hr + ' שעות';
}

module.exports = { elapsedLabel, elapsedHours, elapsedTone, workLabel, localDate };
