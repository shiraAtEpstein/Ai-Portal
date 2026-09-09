// ============================================================
// lib/message-classifier.js — fill the per-message triage category
// (client_category) for client WhatsApp messages, so the dashboard's
// response-time metrics can count ONLY 🔴 'required' messages.
//
// Runs as a lazy backlog drain: each pass grabs a batch of still-unclassified
// client messages, decrypts them, asks the 3-way classifier (lib/needs-reply),
// and stores the category. Messages the AI can't classify right now (outage)
// are simply left NULL and picked up on the next pass — never guessed.
//
//   classifyPending({ limit }) -> { scanned, classified, pending }
// ============================================================
const ingestDb = require('../whatsapp/ingest/db');
const enc = require('./crypto');
const { textPreview } = require('../whatsapp/ingest/phone');
const { loadDirectory } = require('./routing');
const { evaluateNeedsReply } = require('./needs-reply');

async function classifyPending({ limit = 50 } = {}) {
  const dir = loadDirectory();
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
  const rows = await ingestDb.listUnclassifiedInbound({ limit, staffPhones });
  if (!rows.length) return { scanned: 0, classified: 0, pending: 0 };

  // Decrypt each message's text (never logged). Unreadable -> empty text, which
  // the classifier will treat as ambiguous and (usually) leave to the AI.
  const items = rows.map((row) => {
    let text = '';
    try {
      const json = enc.decrypt(row.payload_encrypted || '');
      const msg = json ? JSON.parse(json) : null;
      text = textPreview(msg && msg.message) || '';
    } catch (_) { text = ''; }
    return { key: row.id, text };
  });

  const verdicts = await evaluateNeedsReply(items);
  let classified = 0;
  for (const it of items) {
    const cat = verdicts.get(it.key);
    if (!cat) continue;
    // needs-reply's deterministic layer can also return 'voice' (a standalone
    // voice note, tagged before the AI ever sees it) -- that's meaningful for
    // the live board (it shows "needs a listen" instead of asking the AI to
    // judge silence), but processing_jobs.client_category only ever persists
    // 'required' / 'none' / 'potential': setMessageCategory() silently no-ops
    // on anything else. That used to mean a voice note got counted as
    // "classified" below without ever actually being written -- so the SAME
    // oldest unclassified rows (voice notes) kept getting re-selected and
    // re-"succeeding" on every single pass forever, since listUnclassifiedInbound
    // always grabs the oldest NULLs first. With a real backlog of voice notes
    // sitting at the front, that jammed the whole queue and starved every newer
    // text message behind them (found 9 Sept: a chat's last two weeks of client
    // messages were still NULL because of this). A voice note can't be judged
    // from text alone, so it goes to 'potential' -- reviewed by a person, not
    // silently dropped -- and, critically, an actual value that gets persisted.
    const toStore = cat === 'voice' ? 'potential' : cat;
    await ingestDb.setMessageCategory(it.key, toStore);
    classified++;
  }
  const pending = items.length - classified;
  console.log(`[classifier] pass: scanned ${items.length}, classified ${classified}, left pending ${pending}`);
  return { scanned: items.length, classified, pending };
}

module.exports = { classifyPending };
