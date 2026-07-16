/**
 * Lawly — WhatsApp Coexistence webhook, as a mountable router.
 * -------------------------------------------------------------
 * This version plugs into the EXISTING portal server (server.js) instead of
 * running its own. The portal already listens on a port and stays awake 24/7,
 * which is exactly what a webhook needs (no free-tier cold-start problem).
 *
 * In server.js, mount it like this — IMPORTANT: mount it BEFORE any global
 * express.json(), because we need the raw request bytes to verify Meta's
 * signature, and a global JSON parser would consume them first:
 *
 *     const whatsappWebhook = require('./whatsapp/webhook');
 *     app.use('/whatsapp', whatsappWebhook);   // <-- before app.use(express.json())
 *     // ... your existing app.use(express.json()) and other routes ...
 *
 * The webhook URL you give Meta then becomes:  https://<portal>/whatsapp/webhook
 *
 * Read-only: never sends, replies to, or modifies anything.
 */

const express = require('express');
const crypto = require('crypto');
const { saveRaw } = require('./store');
const { normalize } = require('./schema');

const router = express.Router();

// Capture the RAW body for THIS router only, so signature verification works
// even if the rest of the portal uses its own body parser elsewhere.
router.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// --- 1. Verification handshake (GET /whatsapp/webhook) ---------------------
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[whatsapp] webhook verified by Meta.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- 2. Signature check — the security lock -------------------------------
function verifySignature(req) {
  if (!APP_SECRET) return false;
  const header = req.get('x-hub-signature-256') || '';
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- 3. Incoming deliveries (POST /whatsapp/webhook) -----------------------
router.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[whatsapp] rejected a webhook with a bad signature.');
    return res.sendStatus(401);
  }

  // Ack FIRST (Meta requires <5s), process after.
  res.sendStatus(200);

  try {
    await handleEvent(req.body);
  } catch (err) {
    console.error('[whatsapp] error handling event:', err);
  }
});

async function handleEvent(body) {
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const field = change.field;
      const value = change.value || {};

      switch (field) {
        case 'messages':
          for (const msg of value.messages || []) {
            await saveRaw(normalize(msg, value, { source: 'inbound' }));
          }
          break;

        case 'history':
          for (const thread of value.history || []) {
            for (const msg of thread.messages || []) {
              await saveRaw(normalize(msg, value, { source: 'history' }));
            }
          }
          break;

        case 'smb_message_echoes':
          for (const msg of value.message_echoes || []) {
            await saveRaw(normalize(msg, value, { source: 'echo' }));
          }
          break;

        default:
          break; // statuses etc. — ignore for read-only context building
      }
    }
  }
}

module.exports = router;
module.exports.verifySignature = verifySignature; // for tests
module.exports.handleEvent = handleEvent;
