// ============================================================
// test/email-cc-filter.test.js — lib/gmail.js's headerHasAddress().
//
// getThreadActivity() itself needs a live Gmail connection (OAuth token +
// network), so it's not unit-testable here — this covers the one fully
// deterministic piece added 2026-09-16 for the "I'm CC'd, not addressed,
// and the thread already moved on — don't surface it" task-hub filter:
// telling whether an address is really in a To/Cc header, across the
// header formats Gmail actually sends ("Name <addr>", bare "addr", and a
// comma-separated list of either).
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { headerHasAddress } = require('../lib/gmail');

test('headerHasAddress finds a "Name <addr>" match, case-insensitively', () => {
  assert.strictEqual(headerHasAddress('Shira Cohen <Shira@EpsteinLaw.co.il>', 'shira@epsteinlaw.co.il'), true);
});

test('headerHasAddress finds a bare address with no display name', () => {
  assert.strictEqual(headerHasAddress('shira@epsteinlaw.co.il', 'shira@epsteinlaw.co.il'), true);
});

test('headerHasAddress checks every entry in a comma-separated list', () => {
  const header = 'Yaacov Epstein <yaacov@epsteinlaw.co.il>, Shira Cohen <shira@epsteinlaw.co.il>, Talya <talya@epsteinlaw.co.il>';
  assert.strictEqual(headerHasAddress(header, 'shira@epsteinlaw.co.il'), true);
  assert.strictEqual(headerHasAddress(header, 'notinvited@epsteinlaw.co.il'), false);
});

test('headerHasAddress does not false-positive on a substring/near match', () => {
  assert.strictEqual(headerHasAddress('shira.k@epsteinlaw.co.il', 'shira@epsteinlaw.co.il'), false);
});

test('headerHasAddress is false (not throwing) on empty/missing input', () => {
  assert.strictEqual(headerHasAddress('', 'shira@epsteinlaw.co.il'), false);
  assert.strictEqual(headerHasAddress(null, 'shira@epsteinlaw.co.il'), false);
  assert.strictEqual(headerHasAddress('shira@epsteinlaw.co.il', ''), false);
});
