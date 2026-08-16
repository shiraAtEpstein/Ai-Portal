// ============================================================
// diag-classify.js — force a FRESH classification of one chat, bypassing the
// cache, and print the exact block the AI receives. Read-only.
//   node diag-classify.js bloom
// If the block lines are prefixed with "Name: " the sender-labelling is live.
// The verdict is what the CURRENTLY DEPLOYED prompt decides right now.
// ============================================================
const { evaluateNeedsReply } = require('./lib/needs-reply');
const ingestDb = require('./whatsapp/ingest/db');
const { loadDirectory } = require('./lib/routing');

const arg = (process.argv[2] || 'bloom').toLowerCase();

(async () => {
  const dir = loadDirectory();
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
  const chats = await ingestDb.listUnansweredChats({ hours: 0, staffPhones });
  const c = chats.find((x) => String(x.label || '').toLowerCase().includes(arg));
  if (!c) { console.log('no UNANSWERED chat matched "' + arg + '" (maybe it already cleared)'); process.exit(0); }

  console.log('=== ' + c.label + ' ===');
  console.log('\n--- block the AI receives (are lines "Name: ..."? then labelling is LIVE) ---\n');
  console.log(c.blockText || '(empty)');
  console.log('\n--- fresh classification, ignoring the cache ---');
  const v = await evaluateNeedsReply([{ key: c.chat_jid, text: c.blockText, lastMsgAgeMinutes: null }]);
  console.log('verdict:', v.get(c.chat_jid) || '(unclassified — AI outage?)');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
