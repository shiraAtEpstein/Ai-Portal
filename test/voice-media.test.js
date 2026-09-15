// ============================================================
// test/voice-media.test.js — whatsapp/ingest/media.js's pure helpers.
//
// downloadAudioBuffer() itself needs a live WhatsApp media URL (Baileys
// mediaKey decryption against mmg.whatsapp.net), so it's not unit-testable
// here — this covers the one thing that's easy to get subtly wrong and
// entirely deterministic: recovering a real Buffer from the
// JSON.stringify -> JSON.parse round trip every stored message went
// through (see media.js's own comment on why this is necessary).
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { rehydrateMediaKey, unwrapMessage } = require('../whatsapp/ingest/media');

test('rehydrateMediaKey turns a JSON-round-tripped Buffer back into a real Buffer', () => {
  const original = Buffer.from([1, 2, 3, 4, 5]);
  const roundTripped = JSON.parse(JSON.stringify({ mediaKey: original, directPath: '/x', url: 'https://mmg.whatsapp.net/x' }));
  assert.strictEqual(Buffer.isBuffer(roundTripped.mediaKey), false); // sanity: really did lose Buffer-ness

  const fixed = rehydrateMediaKey(roundTripped);
  assert.strictEqual(Buffer.isBuffer(fixed.mediaKey), true);
  assert.deepStrictEqual(fixed.mediaKey, original);
  assert.strictEqual(fixed.directPath, '/x'); // untouched fields pass through
});

test('rehydrateMediaKey is a no-op when there is no mediaKey to fix', () => {
  const node = { directPath: '/x' };
  assert.strictEqual(rehydrateMediaKey(node), node);
  assert.strictEqual(rehydrateMediaKey(null), null);
});

test('unwrapMessage peels an ephemeral envelope to the real audioMessage', () => {
  const inner = { audioMessage: { ptt: true, mimetype: 'audio/ogg' } };
  const wrapped = { ephemeralMessage: { message: inner } };
  assert.deepStrictEqual(unwrapMessage(wrapped), inner);
});

test('unwrapMessage leaves an already-unwrapped message alone', () => {
  const inner = { audioMessage: { ptt: true } };
  assert.deepStrictEqual(unwrapMessage(inner), inner);
});
