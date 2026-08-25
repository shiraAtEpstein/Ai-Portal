// ============================================================
// test/wait-label.test.js — the wording of a wait.
//
// Shira's rule, 2026-08-24: next to every message, say how long ago it was
// sent — TODAY in hours, any earlier day in days — while the response-SPEED
// figures stay on the working clock. These tests pin the half that people read.
//
// Every instant is written with an explicit +03:00 (Israel summer time) so the
// test means the same thing on a laptop and on Render.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { elapsedLabel, elapsedHours, workLabel, localDate } = require('../lib/wait-label');

const at = (s) => new Date(s + '+03:00');
const NOW = at('2026-08-24T12:00:00');   // Monday noon

test('sent today -> hours', () => {
  assert.strictEqual(elapsedLabel(at('2026-08-24T11:40:00'), NOW), 'לפני פחות משעה');
  assert.strictEqual(elapsedLabel(at('2026-08-24T11:00:00'), NOW), 'לפני שעה');
  assert.strictEqual(elapsedLabel(at('2026-08-24T10:00:00'), NOW), 'לפני שעתיים');
  assert.strictEqual(elapsedLabel(at('2026-08-24T07:00:00'), NOW), 'לפני 5 שעות');
});

test('sent today before dawn is still today, and still counted in hours', () => {
  // 00:10 the same morning: eleven hours, and the label must not jump to days
  // just because it happened in the middle of the night.
  assert.strictEqual(elapsedLabel(at('2026-08-24T00:10:00'), NOW), 'לפני 11 שעות');
});

test('sent on an earlier day -> days, by the CALENDAR, not by 24-hour blocks', () => {
  // 23:00 last night is thirteen hours ago. Calling it "לפני 13 שעות" reads as
  // though it arrived while people were at their desks. It did not.
  assert.strictEqual(elapsedLabel(at('2026-08-23T23:00:00'), NOW), 'אתמול');
  assert.strictEqual(elapsedLabel(at('2026-08-23T08:00:00'), NOW), 'אתמול');
  assert.strictEqual(elapsedLabel(at('2026-08-22T12:00:00'), NOW), 'שלשום');
  assert.strictEqual(elapsedLabel(at('2026-08-20T12:00:00'), NOW), 'לפני 4 ימים');
  assert.strictEqual(elapsedLabel(at('2026-08-13T09:00:00'), NOW), 'לפני 11 ימים');
});

test('the day boundary is the FIRM\'s midnight, not the viewer\'s', () => {
  // 00:30 Israel time on the 24th is 21:30 UTC on the 23rd. A page doing its
  // own arithmetic in UTC would call this "אתמול"; it is today.
  assert.strictEqual(localDate(at('2026-08-24T00:30:00')), '2026-08-24');
  assert.strictEqual(elapsedLabel(at('2026-08-24T00:30:00'), NOW), 'לפני 11 שעות');
});

test('elapsedHours is real elapsed time, and never negative', () => {
  assert.strictEqual(elapsedHours(at('2026-08-24T09:00:00'), NOW), 3);
  assert.strictEqual(elapsedHours(at('2026-08-22T12:00:00'), NOW), 48);
  assert.strictEqual(elapsedHours(at('2026-08-24T13:00:00'), NOW), 0);  // clock skew
  assert.strictEqual(elapsedHours('not a date', NOW), null);
});

test('bad input yields an empty label rather than a broken row', () => {
  assert.strictEqual(elapsedLabel(null, NOW), '');
  assert.strictEqual(elapsedLabel('not a date', NOW), '');
});

// --------------------------------------------------------------- workLabel
// The other clock. This one measures the firm, not the message.

test('workLabel speaks in WORKING hours and working days', () => {
  assert.strictEqual(workLabel(0), 'פחות משעה');     // arrived out of hours
  assert.strictEqual(workLabel(0.4), 'פחות משעה');
  assert.strictEqual(workLabel(1), 'שעה');
  assert.strictEqual(workLabel(2), 'שעתיים');
  assert.strictEqual(workLabel(20), '20 שעות');
  // 42 working hours = three working days. Divided by 24 it would print
  // "2 ימים" for something that has really been open the better part of a week.
  assert.strictEqual(workLabel(42), '3 ימי עבודה');
  assert.strictEqual(workLabel(28), 'יומיים');
  assert.strictEqual(workLabel(null), '—');
});

// ---------------------------------------------------------------- messageKind
// A group message carries the key-exchange record beside its content. Reading
// the first key labelled ordinary group traffic — the firm's own replies
// included — as a system record, and the unanswered detector drops those. Every
// group chat then read as unanswered from the beginning of time.
const { messageKind } = require('../whatsapp/ingest/phone');

test('messageKind names the CONTENT of a group message, not the key exchange', () => {
  assert.strictEqual(messageKind({ message: { senderKeyDistributionMessage: {}, conversation: 'hi' } }), 'conversation');
  assert.strictEqual(messageKind({ message: { senderKeyDistributionMessage: {}, audioMessage: { ptt: true } } }), 'audioMessage');
  assert.strictEqual(messageKind({ message: { messageContextInfo: {}, senderKeyDistributionMessage: {}, imageMessage: {} } }), 'imageMessage');
  // A reaction inside a group must still read as a reaction.
  assert.strictEqual(messageKind({ message: { senderKeyDistributionMessage: {}, reactionMessage: { text: '👍' } } }), 'reactionMessage');
});

test('messageKind still names a row that really is nothing but key exchange', () => {
  assert.strictEqual(messageKind({ message: { senderKeyDistributionMessage: {} } }), 'system');
  assert.strictEqual(messageKind({ message: { protocolMessage: { type: 0 } } }), 'protocolMessage');
  assert.strictEqual(messageKind({ message: {} }), 'unknown');
});
