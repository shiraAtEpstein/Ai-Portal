// ============================================================
// test/business-hours.test.js — the firm's working clock.
//
// These are the cases that decide whether the change is right or wrong, and
// each one is a sentence Shira could say out loud:
//
//   "a message that arrives at 23:10 has waited twenty minutes by 08:20"
//   "Saturday costs nothing"
//   "a Friday-night message belongs to Sunday"
//
// Every date below is written in UTC and paired with the Israeli wall-clock
// time it corresponds to, because a test that silently assumed the runner's
// timezone would pass on a laptop and fail on Render.
//
// August 2026 is UTC+3 (IDT). 2026-08-20 is a Thursday, 08-21 a Friday,
// 08-22 a Saturday, 08-23 a Sunday.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const bh = require('../lib/business-hours');

// local wall-clock (IDT, UTC+3) -> the UTC instant, so each case reads as the
// time a person would actually have seen on their phone.
const idt = (s) => new Date(s + '+03:00');

test('policy loads: 08:00–22:00, Saturday off', () => {
  const c = bh.config();
  assert.strictEqual(c.startHour, 8);
  assert.strictEqual(c.endHour, 22);
  assert.deepStrictEqual(c.offDays, [6]);        // 6 = Saturday
  assert.strictEqual(c.workingDayHours, 14);
});

test('the night does not count: 23:10 -> 08:20 next morning is 20 minutes', () => {
  const s = bh.businessSecondsBetween(idt('2026-08-19T23:10:00'), idt('2026-08-20T08:20:00'));
  assert.strictEqual(s, 20 * 60);
});

test('a message answered inside the same working day is plain elapsed time', () => {
  const s = bh.businessSecondsBetween(idt('2026-08-20T10:00:00'), idt('2026-08-20T13:30:00'));
  assert.strictEqual(s, 3.5 * 3600);
});

test('a whole working day is 14 hours, not 24', () => {
  const h = bh.businessHoursBetween(idt('2026-08-20T00:00:00'), idt('2026-08-21T00:00:00'));
  assert.strictEqual(h, 14);
});

test('Saturday costs nothing at all', () => {
  const s = bh.businessSecondsBetween(idt('2026-08-22T00:00:00'), idt('2026-08-22T23:59:00'));
  assert.strictEqual(s, 0);
});

test('Friday evening to Sunday morning skips Saturday entirely', () => {
  // Fri 21:50 -> 22:00 = 10 min. Saturday = 0. Sun 08:00 -> 08:30 = 30 min.
  const s = bh.businessSecondsBetween(idt('2026-08-21T21:50:00'), idt('2026-08-23T08:30:00'));
  assert.strictEqual(s, 40 * 60);
});

test('a message sent before opening starts counting at 08:00, not on arrival', () => {
  const s = bh.businessSecondsBetween(idt('2026-08-20T05:30:00'), idt('2026-08-20T09:00:00'));
  assert.strictEqual(s, 3600);
});

test('an eleven-day-old message still accrues, it is just measured honestly', () => {
  // Thu 2026-08-13 09:00 -> Mon 2026-08-24 09:00. Eleven calendar days, two of
  // them Saturdays. Counted out: 13h on the first day (09:00→22:00), eight full
  // working days, and 1h on the last (08:00→09:00).
  const h = bh.businessHoursBetween(idt('2026-08-13T09:00:00'), idt('2026-08-24T09:00:00'));
  assert.strictEqual(h, 13 + 8 * 14 + 1);   // 126 working hours, not 264 wall-clock
});

test('inverted, equal and unparseable ranges are zero, never negative or NaN', () => {
  assert.strictEqual(bh.businessSecondsBetween(idt('2026-08-20T12:00:00'), idt('2026-08-20T10:00:00')), 0);
  assert.strictEqual(bh.businessSecondsBetween(idt('2026-08-20T12:00:00'), idt('2026-08-20T12:00:00')), 0);
  assert.strictEqual(bh.businessSecondsBetween(null, idt('2026-08-20T12:00:00')), 0);
  assert.strictEqual(bh.businessSecondsBetween('not a date', idt('2026-08-20T12:00:00')), 0);
});

test('DST is resolved through the timezone, not assumed as a fixed offset', () => {
  // Israel leaves summer time in late October. 08:00 local is therefore 05:00Z
  // before the change and 06:00Z after it. Adding a constant offset — the
  // obvious shortcut — would put every working day after October out by an
  // hour, in a direction nobody would notice until a median moved.
  const before = bh.instantAt('2026-10-23', 8);   // still IDT (UTC+3)
  const after  = bh.instantAt('2026-10-26', 8);   // now IST  (UTC+2)
  assert.strictEqual(new Date(before).toISOString(), '2026-10-23T05:00:00.000Z');
  assert.strictEqual(new Date(after).toISOString(),  '2026-10-26T06:00:00.000Z');

  // And the working day stays 14 hours on both sides, because the 02:00
  // transition falls outside 08:00–22:00. A span across it is counted per day,
  // so it is right even though the wall clock gained an hour in the middle.
  // Fri 09:00→22:00 = 13h · Sat = 0 · Sun = 14h · Mon 08:00→09:00 = 1h.
  const h = bh.businessHoursBetween(new Date('2026-10-23T06:00:00Z'), new Date('2026-10-26T07:00:00Z'));
  assert.strictEqual(h, 13 + 14 + 1);
});

// ------------------------------------------------------------ businessDateOf
// This is what keeps the per-day consistency strip honest: a day may only be
// marked "ended with something open" for messages that could actually have been
// answered that day.

test('a message inside working hours belongs to its own day', () => {
  assert.strictEqual(bh.businessDateOf(idt('2026-08-20T10:00:00')), '2026-08-20');
});

test('a message before opening still belongs to that day', () => {
  assert.strictEqual(bh.businessDateOf(idt('2026-08-20T06:00:00')), '2026-08-20');
});

test('a message after closing belongs to the NEXT day', () => {
  assert.strictEqual(bh.businessDateOf(idt('2026-08-20T23:10:00')), '2026-08-21');
});

test('a Friday-night message belongs to Sunday, because Saturday is closed', () => {
  assert.strictEqual(bh.businessDateOf(idt('2026-08-21T23:00:00')), '2026-08-23');
});

test('a Saturday message belongs to Sunday whatever the hour', () => {
  assert.strictEqual(bh.businessDateOf(idt('2026-08-22T11:00:00')), '2026-08-23');
});

// ------------------------------------------------------------- isWorkingNow
test('isWorkingNow follows the same policy as the measurement', () => {
  assert.strictEqual(bh.isWorkingNow(idt('2026-08-20T09:00:00')), true);
  assert.strictEqual(bh.isWorkingNow(idt('2026-08-20T23:00:00')), false);
  assert.strictEqual(bh.isWorkingNow(idt('2026-08-22T12:00:00')), false);  // Saturday
  assert.strictEqual(bh.isWorkingNow(idt('2026-08-20T22:00:00')), false);  // closing is exclusive
  assert.strictEqual(bh.isWorkingNow(idt('2026-08-20T08:00:00')), true);   // opening is inclusive
});
