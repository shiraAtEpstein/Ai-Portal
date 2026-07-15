// ============================================================
// test/user-framework.test.js — Layer 2 user framework loader.
// Runs with `node --test`. No network: a fake Dropbox reader is injected.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const uf = require('../lib/user-framework');

// Build a fake reader over a { path: contents } map. Unknown paths "404".
function fakeReader(map) {
  return {
    readFile: async (p) => {
      if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
      throw new Error('not_found: ' + p);
    },
  };
}
const pathFor = (email, file) => uf.USERS_ROOT + '/' + email.toLowerCase() + '/' + file;

test('empty-state: no files -> empty text, and render() adds nothing', async () => {
  const r = await uf.loadForEmail('nobody@epsteinlaw.co.il', { reader: fakeReader({}) });
  assert.strictEqual(r.text, '');
  assert.deepStrictEqual(r.files, []);
  assert.strictEqual(uf.render(r, 'Nobody'), '');
});

test('loads present files in priority order and lists them', async () => {
  const e = 'shira@epsteinlaw.co.il';
  const r = await uf.loadForEmail('Shira@EpsteinLaw.co.il', {
    reader: fakeReader({
      [pathFor(e, 'preferences.md')]: 'Prefer formal Hebrew.',
      [pathFor(e, 'profile.md')]: 'Role: office manager.',
    }),
  });
  assert.match(r.text, /Profile/);
  assert.match(r.text, /Communication & working preferences/);
  // profile.md must come before preferences.md regardless of read order
  assert.ok(r.text.indexOf('office manager') < r.text.indexOf('formal Hebrew'));
  assert.deepStrictEqual(r.files, ['profile.md', 'preferences.md']);
});

test('render() names the user and states Firm Core wins', async () => {
  const e = 'shira@epsteinlaw.co.il';
  const r = await uf.loadForEmail(e, {
    reader: fakeReader({ [pathFor(e, 'preferences.md')]: 'Short subject lines.' }),
  });
  const block = uf.render(r, 'Shira');
  assert.match(block, /FIRM RULE ALWAYS WINS/);
  assert.match(block, /for Shira/);
  assert.match(block, /Short subject lines/);
});

test('combined text is capped so it cannot dominate the prompt', async () => {
  const e = 'big@epsteinlaw.co.il';
  const r = await uf.loadForEmail(e, {
    reader: fakeReader({ [pathFor(e, 'profile.md')]: 'x'.repeat(10000) }),
  });
  assert.ok(r.text.length <= 4200, 'capped near MAX_TOTAL_CHARS, got ' + r.text.length);
});

test('slugForEmail lowercases and trims', () => {
  assert.strictEqual(uf.slugForEmail('  Shira@Epstein.CO.il '), 'shira@epstein.co.il');
  assert.strictEqual(uf.slugForEmail(null), '');
});

test('a single broken/missing file does not break the others', async () => {
  const e = 'partial@epsteinlaw.co.il';
  const r = await uf.loadForEmail(e, {
    reader: fakeReader({ [pathFor(e, 'dos-and-donts.md')]: 'Never CC clients without asking.' }),
  });
  assert.match(r.text, /Personal dos and don'ts/);
  assert.deepStrictEqual(r.files, ['dos-and-donts.md']);
});

test('slugForEmail strips path-traversal characters', () => {
  assert.strictEqual(uf.slugForEmail('../../etc/passwd@x'), '....etcpasswd@x');
  assert.ok(!uf.slugForEmail('a/../../b@x.com').includes('/'));
});

// ── failure vs. empty-state (a real Dropbox outage must not look like "no profile") ──
function throwingReader(err) {
  return { readFile: async () => { throw err; } };
}

test('a Dropbox outage is reported, not disguised as an empty profile', async () => {
  const r = await uf.loadForEmail('shira@epsteinlaw.co.il', {
    reader: throwingReader(new Error('Dropbox is not connected.')),
  });
  assert.strictEqual(r.error, 'unavailable');
  assert.strictEqual(r.text, '');
});

test('a genuinely missing file stays a normal empty-state, with no error', async () => {
  const r = await uf.loadForEmail('nobody@epsteinlaw.co.il', { reader: fakeReader({}) });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.text, '');
});

test('an error flagged notFound is treated as a missing file', async () => {
  const e = Object.assign(new Error('dropbox download error'), { notFound: true });
  const r = await uf.loadForEmail('x@epsteinlaw.co.il', { reader: throwingReader(e) });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.text, '');
});

test('a partial auth failure is not passed off as a partial profile', async () => {
  const r = await uf.loadForEmail('mix@epsteinlaw.co.il', {
    reader: { readFile: async (p) => {
      if (p.endsWith('profile.md')) return 'Role: partner.';
      throw new Error('invalid_access_token');
    } },
  });
  assert.strictEqual(r.error, 'unavailable');
  assert.strictEqual(r.text, '');
});

test('render() adds nothing when the framework is unavailable', async () => {
  const r = await uf.loadForEmail('x@epsteinlaw.co.il', {
    reader: throwingReader(new Error('dropbox token error: 401')),
  });
  assert.strictEqual(uf.render(r, 'X'), '');
});
