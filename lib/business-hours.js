// ============================================================
// lib/business-hours.js — the firm's working clock.
//
// Decided with Shira, 2026-08-24. Every wait in this system is now measured in
// WORKING time, not wall-clock time: 08:00–22:00 local, and Saturday does not
// count at all. A client who writes at 23:10 and gets an answer at 08:20 waited
// twenty minutes, not nine hours — and the board, the daily email and every
// number on the response dashboard now say so.
//
// Shira's scope decision: this applies to EVERYTHING, the metrics included.
// The consequence, stated plainly because it will be noticed: medians drop and
// the "% answered within an hour" figures rise, so numbers produced after this
// change are NOT comparable with reports printed before it.
//
//   businessSecondsBetween(from, to) -> working seconds between two instants
//   businessHoursBetween(from, to)   -> the same, in hours, one decimal
//   businessDateOf(instant)          -> the local date on which this instant
//                                       first accrues working time
//   config()                         -> the loaded policy (for UI footnotes)
//
// ── WHY THE ARITHMETIC IS HERE AND NOT IN SQL ──────────────────────────────
// The old code subtracted two timestamps inside Postgres. A working-hours
// subtraction in SQL means either a stored procedure or a generate_series per
// row, and either way the rule would then live in two places (the board query
// and the metrics query) and drift. So the queries now return raw timestamps
// and every wait in the codebase is computed by this one function — which is
// also the only version that can be unit-tested without a database.
//
// ── DST ────────────────────────────────────────────────────────────────────
// Israel moves its clock twice a year. Each working day's 08:00 and 22:00 are
// resolved through Intl in the firm's timezone rather than by adding fixed
// offsets, so the day the clock changes is 13 or 15 hours long — correctly —
// instead of silently gaining or losing an hour.
//
// ── LIMITS ─────────────────────────────────────────────────────────────────
// startHour must be earlier than endHour: an overnight shift (22:00→06:00) is
// not supported and would silently measure zero. Holidays are NOT handled —
// only the weekly off-days. If the firm wants חגים excluded, that needs a date
// list, and it should be added here rather than anywhere else.
// ============================================================
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  timezone: 'Asia/Jerusalem',
  startHour: 8,
  endHour: 22,
  offDays: [6],          // 0=Sunday … 6=Saturday
  workingDayHours: 14,
  label: '8:00–22:00, ללא שבת',
};

// Loaded once. A malformed or missing file must never take the board down, so a
// bad config falls back to the defaults above and says so in the log — the
// alternative (throwing at require time) would take the whole server with it.
let _cfg = null;
function config() {
  if (_cfg) return _cfg;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'business-hours.json'), 'utf8'));
  } catch (e) {
    console.warn('[business-hours] config/business-hours.json unreadable, using defaults:', e.message);
  }
  const int = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
  const cfg = {
    timezone: process.env.FIRM_TZ || raw.timezone || DEFAULTS.timezone,
    startHour: int(raw.startHour, DEFAULTS.startHour),
    endHour: int(raw.endHour, DEFAULTS.endHour),
    offDays: Array.isArray(raw.offDays) ? raw.offDays.map((d) => int(d, -1)).filter((d) => d >= 0 && d <= 6) : DEFAULTS.offDays.slice(),
    workingDayHours: int(raw.workingDayHours, DEFAULTS.workingDayHours),
    label: raw.label || DEFAULTS.label,
  };
  if (!(cfg.startHour >= 0 && cfg.endHour <= 24 && cfg.startHour < cfg.endHour)) {
    console.warn('[business-hours] invalid start/end hour, using defaults');
    cfg.startHour = DEFAULTS.startHour;
    cfg.endHour = DEFAULTS.endHour;
  }
  // A week with every day off makes every wait exactly zero and every date roll
  // forward forever — silently, and it would read as "the firm is instant".
  if (cfg.offDays.length >= 7) {
    console.warn('[business-hours] every day marked off — ignoring, using defaults');
    cfg.offDays = DEFAULTS.offDays.slice();
  }
  if (!(cfg.workingDayHours > 0)) cfg.workingDayHours = cfg.endHour - cfg.startHour;
  // An unusable timezone must fail at boot, not on the first board request:
  // Intl throws inside the formatter, which would 500 every page that shows a
  // wait. Probe it here and fall back instead.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date());
  } catch (e) {
    console.warn('[business-hours] unknown timezone "' + cfg.timezone + '", falling back to ' + DEFAULTS.timezone);
    cfg.timezone = DEFAULTS.timezone;
  }
  _cfg = cfg;
  return _cfg;
}
// Tests only: drop the cache so a different policy can be loaded.
function _reset() { _cfg = null; _fmt = null; _instants.clear(); }

// ---------------------------------------------------------------- local time
let _fmt = null;
function fmt() {
  if (!_fmt) {
    _fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: config().timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
  }
  return _fmt;
}

// The wall-clock parts of an instant in the firm's timezone.
function partsOf(ms) {
  const out = {};
  for (const p of fmt().formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

// How far ahead of UTC the firm's clock is at this instant, in ms.
function offsetAt(ms) {
  const p = partsOf(ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - ms;
}

// 'YYYY-MM-DD' — the LOCAL date an instant falls on. ISO dates compare
// correctly as plain strings, which is why every date below stays a string.
function dateKeyOf(ms) {
  const p = partsOf(ms);
  return p.year + '-' + p.month + '-' + p.day;
}

// The instant at which a given local wall-clock hour occurs on a given local
// date. Resolved through the real offset, then corrected once: on a DST
// boundary the first guess can land on the wrong side of the change.
//
// MEMOISED, because this is the hot path. Every wait walks day by day and asks
// for the same two hours of the same days over and over — a month of open
// conversations is thousands of repeats of a few dozen distinct answers, and
// each miss costs two Intl formats. The cache is bounded and simply cleared
// when full: the keys that matter are a handful of recent days, so a cold start
// after a flush costs a few hundred microseconds, not a leak.
const _instants = new Map();
const INSTANT_CACHE_MAX = 20000;
function instantAt(dayKey, hour) {
  const key = dayKey + '|' + hour;
  const hit = _instants.get(key);
  if (hit !== undefined) return hit;
  const wall = Date.parse(dayKey + 'T00:00:00Z') + hour * 3600000;
  const first = offsetAt(wall);
  let t = wall - first;
  const second = offsetAt(t);
  if (second !== first) t = wall - second;
  if (_instants.size >= INSTANT_CACHE_MAX) _instants.clear();
  _instants.set(key, t);
  return t;
}

// Day of week for a plain 'YYYY-MM-DD'. Parsed as UTC on purpose: the string is
// already a local date, so no further conversion may be applied to it.
function dowOf(dayKey) {
  return new Date(dayKey + 'T00:00:00Z').getUTCDay();
}
function isOffDay(dayKey) {
  return config().offDays.indexOf(dowOf(dayKey)) !== -1;
}
function nextDay(dayKey) {
  const d = new Date(dayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toMs(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

// A conversation left open for years must not spin here. 1500 iterations is
// roughly four years of days — far past anything real, and cheap.
const MAX_DAYS = 1500;

// ------------------------------------------------------------------ the API

// Working seconds between two instants. Zero when the range is empty, inverted,
// or unparseable — never negative, never NaN, because every caller feeds this
// straight into a median.
function businessSecondsBetween(from, to) {
  const a = toMs(from);
  const b = toMs(to == null ? Date.now() : to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;

  const { startHour, endHour } = config();
  let total = 0;
  let dayKey = dateKeyOf(a);
  const lastKey = dateKeyOf(b);
  let guard = 0;

  while (dayKey <= lastKey && guard++ < MAX_DAYS) {
    if (!isOffDay(dayKey)) {
      const open = instantAt(dayKey, startHour);
      const close = instantAt(dayKey, endHour);
      const lo = a > open ? a : open;
      const hi = b < close ? b : close;
      if (hi > lo) total += hi - lo;
    }
    dayKey = nextDay(dayKey);
  }
  // The guard is a runaway backstop, not a policy. If it ever trips, the number
  // returned is an UNDERSTATEMENT of a very old wait — exactly the direction
  // that hides a problem — so it must be loud rather than quiet.
  if (guard >= MAX_DAYS) {
    console.warn('[business-hours] range longer than ' + MAX_DAYS + ' days truncated (' + dateKeyOf(a) + ' → ' + lastKey + '); the wait reported is a lower bound');
  }
  return Math.round(total / 1000);
}

function businessHoursBetween(from, to) {
  return Math.round((businessSecondsBetween(from, to) / 3600) * 10) / 10;
}

// The local date on which an instant STARTS accruing working time. A message
// that arrives at 23:10 on Thursday belongs to Sunday if Friday is an off-day —
// it is not "waiting" overnight, so it must not darken Thursday either.
//
// This is what keeps the per-day consistency strip honest under the new clock:
// without it, a 21:55 message would mark that day as "ended with something
// open" even though the firm's day was over five minutes later.
function businessDateOf(instant) {
  const t = toMs(instant);
  if (!Number.isFinite(t)) return null;
  const { endHour } = config();
  let dayKey = dateKeyOf(t);
  for (let i = 0; i < 40; i++) {
    if (!isOffDay(dayKey) && t < instantAt(dayKey, endHour)) return dayKey;
    dayKey = nextDay(dayKey);
  }
  return dayKey;
}

// Is the firm's clock running right now? Used only for wording ("מחוץ לשעות
// העבודה — הזמן אינו נספר כרגע"), never for a measurement.
function isWorkingNow(at) {
  const t = toMs(at == null ? Date.now() : at);
  if (!Number.isFinite(t)) return false;
  const dayKey = dateKeyOf(t);
  if (isOffDay(dayKey)) return false;
  const { startHour, endHour } = config();
  return t >= instantAt(dayKey, startHour) && t < instantAt(dayKey, endHour);
}

module.exports = {
  businessSecondsBetween,
  businessHoursBetween,
  businessDateOf,
  isWorkingNow,
  config,
  // exported for tests
  _reset, dateKeyOf, instantAt, isOffDay, nextDay,
};
