/**
 * Raw message store — the source of truth.
 * -------------------------------------------------------------
 * Layer 1 of the three-layer design:
 *   1. RAW (this file)      — keep everything, forever, append-only. Cheap.
 *   2. SUMMARY (downstream) — batched enrichment reads raw, extracts key points.
 *   3. LEARNED (downstream) — human-confirmed patterns.
 *
 * We NEVER store only the summary. A summary is lossy and can be wrong; the raw
 * lets us re-run enrichment when prompts improve, and is the audit trail if a
 * dispute ever turns on exactly what a client wrote.
 *
 * This starter writes newline-delimited JSON to disk so you can run it today.
 * In production, swap the body of saveRaw() for your real store (Postgres,
 * Dropbox — matching the email pipeline). Encrypt at rest with firm-held keys.
 * Idempotency: dedupe on message id so a replayed webhook can't double-insert.
 */

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.WHATSAPP_DATA_DIR || path.join(__dirname, 'data');
const RAW_FILE = path.join(DATA_DIR, 'raw-messages.ndjson');

// In-memory dedupe cache. In production back this with the DB's unique index
// on message id — the cache is just a fast first check.
const seenIds = new Set();

async function saveRaw(message) {
  if (!message || !message.id) return;

  if (seenIds.has(message.id)) return; // already stored, skip (idempotent)
  seenIds.add(message.id);

  await fs.mkdir(DATA_DIR, { recursive: true });

  const record = {
    storedAt: Date.now(),
    ...message,
  };

  // Append-only. One JSON object per line.
  await fs.appendFile(RAW_FILE, JSON.stringify(record) + '\n', 'utf8');

  // TODO (production): also enqueue message.id for the enrichment worker,
  // which batches by conversation and produces the summary layer.
  console.log(
    `stored ${message.source} msg ${message.id} ` +
      `(${message.direction}) in convo ${message.conversationId}`
  );
}

module.exports = { saveRaw };
