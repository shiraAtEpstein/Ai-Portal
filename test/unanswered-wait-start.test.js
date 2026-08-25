// ============================================================
// test/unanswered-wait-start.test.js — where a wait is allowed to start.
//
// THE BUG THIS PINS DOWN (Shira, 2026-08-24). A conversation the firm answered
// at 09:00 on the 12th showed on the board as "waiting 12 days". Her own SQL
// found why: at 12:01 that day a client put a 👍 on the answer, and a reaction
// is ingested exactly like a message. It opened an "unanswered block" that
// nobody could ever close, because there is no way to reply to a thumbs-up.
// Everything after it inherited the same twelve-day clock.
//
// Two independent guards now stop that, and this file checks both:
//   1. the wait starts at the oldest message that PLAUSIBLY WANTS AN ANSWER —
//      client_category 'none' (a 👍, a "תודה", a plain FYI) cannot start one;
//   2. reactions and protocol rows are dropped from the block entirely, so they
//      do not inflate the message count either.
//
// Both fail OPEN: a message not yet classified (NULL) still starts a wait, and
// a row whose kind is unknown still counts. Never hide a client's question.
//
// Needs a throwaway Postgres. Set TEST_DATABASE_URL to run it; without one it
// skips, so the suite stays green on a machine with no database.
//   TEST_DATABASE_URL=postgresql://user@127.0.0.1:5433/postgres node --test
// ============================================================
const test = require('node:test');
const assert = require('node:assert');

const URL_ = process.env.TEST_DATABASE_URL;
const STAFF = ['546422750', '559713617'];

// The exact shape of Shira's chat, in the order her SQL returned it.
const ROWS = [
  ['a', 'in', '559713617', '559713617', '2026-08-12 05:59:17+00', null, null],
  ['b', 'in', '559713617', '559713617', '2026-08-12 05:59:20+00', null, null],
  ['c', 'in', '546422750', '546422750', '2026-08-12 06:00:00+00', null, null],   // the firm's answer
  ['d', 'in', '718757311', null, '2026-08-12 09:01:35+00', 'none', 'reactionMessage'], // the 👍
  ['e', 'in', '718757311', null, '2026-08-12 09:01:46+00', 'none', null],
  ['f', 'in', '718757311', null, '2026-08-24 09:58:24+00', 'none', 'reactionMessage'],
  ['g', 'in', '718757311', null, '2026-08-24 09:58:26+00', 'none', 'reactionMessage'],
  ['h', 'in', '347446770', null, '2026-08-24 09:58:37+00', 'required', null],     // the real question
];

async function seed(pool, rows) {
  await pool.query(`DROP TABLE IF EXISTS processing_jobs, whatsapp_groups, unanswered_dismissals,
                    wa_contacts, chat_responsible_override CASCADE`);
  await pool.query(`CREATE TABLE wa_contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    phone_normalized TEXT, display_name TEXT, monday_client_name TEXT)`);
  await pool.query(`CREATE TABLE whatsapp_groups (provider_group_jid TEXT PRIMARY KEY, name TEXT,
                    removed_at TIMESTAMPTZ, responsible_email TEXT, responsible_name TEXT, participant_phones TEXT[])`);
  await pool.query(`CREATE TABLE unanswered_dismissals (chat_jid TEXT PRIMARY KEY, dismissed_at TIMESTAMPTZ,
                    reason TEXT, dismissed_by TEXT)`);
  await pool.query(`CREATE TABLE chat_responsible_override (chat_jid TEXT PRIMARY KEY, email TEXT, name TEXT)`);
  await pool.query(`CREATE TABLE processing_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source TEXT,
                    source_item_id TEXT UNIQUE, chat_jid TEXT, is_group BOOL, direction TEXT, sender_phone TEXT,
                    sender_staff_phone9 TEXT, contact_id UUID, deal_id UUID, payload_encrypted TEXT,
                    status TEXT DEFAULT 'pending', attempts INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(),
                    processed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
                    client_category TEXT, msg_kind TEXT)`);
  await pool.query(`INSERT INTO whatsapp_groups VALUES ('jid-w','Weinstein',NULL,NULL,NULL,'{}')`);
  for (const [id, dir, phone, staff9, at, cat, kind] of rows) {
    await pool.query(
      `INSERT INTO processing_jobs (source, source_item_id, chat_jid, is_group, direction, sender_phone,
        sender_staff_phone9, sent_at, payload_encrypted, client_category, msg_kind)
       VALUES ('whatsapp',$1,'jid-w',true,$2,$3,$4,$5,'{}',$6,$7)`,
      [id, dir, phone, staff9, at, cat, kind]
    );
  }
}

test('the wait starts at the message that wants an answer, not at a 👍', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    await seed(pool, ROWS);
    const [chat] = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.ok(chat, 'the chat should still be on the board — a real question is waiting');

    // The whole point: 24/08 12:58 Israel (the 'required' message), NOT 12/08.
    assert.strictEqual(new Date(chat.firstUnansweredAt).toISOString(), '2026-08-24T09:58:37.000Z');
    // The oldest row is still reported, for diagnostics only.
    assert.strictEqual(new Date(chat.oldestInBlockAt).toISOString(), '2026-08-12T09:01:46.000Z');
    // Three reactions dropped: only the closer and the real question remain.
    assert.strictEqual(chat.unansweredCount, 2);
  } finally {
    await pool.end().catch(() => {});
  }
});

test('an unclassified message still starts a wait — the fail-safe flags, never hides', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    // Same chat, but the 12/08 message was never classified. It must count:
    // "not looked at yet" is not the same as "needs no answer".
    const rows = ROWS.map((r) => (r[0] === 'e' ? ['e', 'in', '718757311', null, '2026-08-12 09:01:46+00', null, null] : r));
    await seed(pool, rows);
    const [chat] = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.strictEqual(new Date(chat.firstUnansweredAt).toISOString(), '2026-08-12T09:01:46.000Z');
  } finally {
    await pool.end().catch(() => {});
  }
});

test('a STAFF thumbs-up counts as an answer and closes the wait', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    // Shira's rule, and the right one: when the partner puts a 👍 on a client's
    // document that IS him saying "seen, fine". Dropping it would leave the
    // client's message looking unanswered when it plainly was not.
    await seed(pool, [
      ['x', 'in', '718757311', null, '2026-08-24 06:00:00+00', 'required', null],           // client asks
      ['y', 'in', '546422750', '546422750', '2026-08-24 06:05:00+00', null, 'reactionMessage'], // staff 👍
    ]);
    const chats = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.strictEqual(chats.length, 0, "a staffer's 👍 is an answer — the chat must clear");
  } finally {
    await pool.end().catch(() => {});
  }
});

test('a CLIENT thumbs-up on the same question does NOT answer it', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    // The mirror image, and the reason the filter is by SENDER and not by kind.
    await seed(pool, [
      ['x', 'in', '718757311', null, '2026-08-24 06:00:00+00', 'required', null],
      ['y', 'in', '718757311', null, '2026-08-24 06:05:00+00', 'none', 'reactionMessage'],
    ]);
    const [chat] = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.ok(chat, 'the question is still unanswered');
    assert.strictEqual(new Date(chat.firstUnansweredAt).toISOString(), '2026-08-24T06:00:00.000Z');
    assert.strictEqual(chat.unansweredCount, 1, "the client's own 👍 must not pad the count");
  } finally {
    await pool.end().catch(() => {});
  }
});

test('the firm answered and the client only said thanks — off the board', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    // The exchange is FINISHED. The firm answered, and everything since is a
    // closer — here a "תודה" that is not a reaction, so msg_kind cannot help
    // and only client_category can. The board used to keep it, marked 🔴,
    // telling somebody to answer a thank-you. lib/staff-metrics has always
    // dropped it; the two must agree.
    await seed(pool, [
      ['x', 'in', '718757311', null, '2026-08-22 06:00:00+00', 'required', null],
      ['y', 'in', '546422750', '546422750', '2026-08-22 07:00:00+00', null, null],   // the firm answers
      ['z', 'in', '718757311', null, '2026-08-22 07:05:00+00', 'none', null],        // "תודה!"
      ['w', 'in', '718757311', null, '2026-08-22 07:06:00+00', 'none', 'reactionMessage'],
    ]);
    const chats = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.strictEqual(chats.length, 0, 'nobody is waiting for an answer to "תודה"');
  } finally {
    await pool.end().catch(() => {});
  }
});

test('but one unclassified message among the closers keeps it on the board', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    // The fail-safe. "Not looked at yet" is not "needs no answer", so a single
    // NULL among the closers is enough to keep the chat visible.
    await seed(pool, [
      ['x', 'in', '718757311', null, '2026-08-22 06:00:00+00', 'required', null],
      ['y', 'in', '546422750', '546422750', '2026-08-22 07:00:00+00', null, null],
      ['z', 'in', '718757311', null, '2026-08-22 07:05:00+00', 'none', null],
      ['w', 'in', '718757311', null, '2026-08-22 07:06:00+00', null, null],   // not classified yet
    ]);
    const [chat] = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.ok(chat, 'an unclassified message must still be flagged');
    assert.strictEqual(new Date(chat.firstUnansweredAt).toISOString(), '2026-08-22T07:06:00.000Z');
  } finally {
    await pool.end().catch(() => {});
  }
});

test('a chat whose only new arrivals are reactions leaves the board', { skip: !URL_ }, async () => {
  process.env.DATABASE_URL = URL_;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  const ingest = require('../whatsapp/ingest/db');
  try {
    // The firm answered, and since then only a 👍. Nothing is waiting on anyone.
    await seed(pool, ROWS.filter((r) => ['a', 'b', 'c', 'd', 'f', 'g'].includes(r[0])));
    const chats = await ingest.listUnansweredChats({ hours: 0, staffPhones: STAFF });
    assert.strictEqual(chats.length, 0, 'a thumbs-up is not an unanswered message');
  } finally {
    await pool.end().catch(() => {});
  }
});
