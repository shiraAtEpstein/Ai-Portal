// Harness for the 2026-10-05 Task Hub triage memory (task_hub_triage).
// Needs a throwaway Postgres in HARNESS_DATABASE_URL; stubs Claude, Gmail,
// monday and the WhatsApp db. Skips itself under `npm test` when the variable
// isn't set. Run: HARNESS_DATABASE_URL=postgres://... node test/task-hub-memory.harness.js
'use strict';
if (!process.env.HARNESS_DATABASE_URL) { console.log('# skipped: set HARNESS_DATABASE_URL to run'); return; }
const path = require('path');
const assert = require('assert');
const { Pool } = require('pg');
const ROOT = path.join(__dirname, '..');
const pool = new Pool({ connectionString: process.env.HARNESS_DATABASE_URL });
function stub(rel, exp) { const f = require.resolve(path.join(ROOT, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; }

const F = { calls: 0, mode: 'ok', reply: null, emails: [], wa: [], inbox: [] };
stub('db.js', { getPool: () => pool, listAllUsers: async () => [] });
stub('lib/claude.js', {
  isConfigured: () => true, resolveModel: (m) => m,
  askJSON: async ({ user }) => {
    F.calls++;
    if (F.mode === 'fail') return null;
    if (F.reply) return F.reply(user);
    return { title: 'T', summary: 's', estimated_minutes: 5, priority: 'normal' };
  },
});
stub('lib/gmail.js', {
  searchMail: async () => ({ connected: true, mailbox: 'me@firm.co.il', messages: F.emails }),
  headerHasAddress: (h, a) => String(h || '').indexOf(a) !== -1,
  getThreadActivity: async () => null,
});
stub('lib/monday.js', { isConfigured: () => false });
stub('whatsapp/ingest/db.js', {
  listUnansweredChats: async () => F.wa,
  listTaskInboxMessages: async () => F.inbox,
});
const hub = require(path.join(ROOT, 'lib/task-hub.js'));
const U = '11111111-1111-1111-1111-111111111111';
const tasks = async () => (await pool.query('SELECT * FROM unified_tasks ORDER BY id')).rows;
const run = async () => { F.calls = 0; return hub.refreshTasks(U); };

(async () => {
  require(path.join(ROOT, 'config/staff-directory.json')).staff.push({ email: 'me@firm.co.il', phone9: '500000000' });
  await pool.query(`DROP TABLE IF EXISTS unified_tasks, task_hub_triage, users, task_hub_skills, task_hub_skill_active, wa_skills, wa_skill_active, whatsapp_groups CASCADE`);
  await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, email text, status text)`);
  await pool.query(`INSERT INTO users VALUES ($1,'me@firm.co.il','active')`, [U]);
  await pool.query(`CREATE TABLE task_hub_skills (id serial PRIMARY KEY, key text, version int, body_md text, model text)`);
  await pool.query(`CREATE TABLE task_hub_skill_active (key text PRIMARY KEY, skill_id int)`);
  for (const k of ['email-triage', 'wa-triage', 'manual-task-extract']) {
    const r = await pool.query(`INSERT INTO task_hub_skills (key, version, body_md) VALUES ($1,1,'x') RETURNING id`, [k]);
    await pool.query(`INSERT INTO task_hub_skill_active VALUES ($1,$2)`, [k, r.rows[0].id]);
  }
  await pool.query(`CREATE TABLE wa_skills (id serial PRIMARY KEY, body_md text)`);
  await pool.query(`CREATE TABLE wa_skill_active (key text, skill_id int)`);
  await pool.query(`CREATE TABLE whatsapp_groups (provider_group_jid text, invite_link text, task_owner_email text, removed_at timestamptz)`);
  await pool.query(`INSERT INTO whatsapp_groups VALUES ('inbox@g.us', null, 'me@firm.co.il', null)`);
  const em = (id, subj) => ({ id, threadId: 't' + id, from: 'c@x.com', to: 'me@firm.co.il', subject: subj, snippet: '', date: new Date().toISOString() });

  // pre-existing task from before the memory -> recorded, no AI
  await hub.listTasks(U); // creates tables
  await pool.query(`INSERT INTO unified_tasks (user_id, source, source_ref, title) VALUES ($1,'email','old','old')`, [U]);
  F.emails = [em('old', 'old')];
  let r = await run(); assert.strictEqual(F.calls, 0); assert.strictEqual(r.stats.recorded_existing, 1);
  console.log('ok 1 existing tasks are recorded without calling the AI');

  F.emails.push(em('m1', 'Need KYC'));
  await run(); assert.strictEqual(F.calls, 1);
  await run(); assert.strictEqual(F.calls, 0);
  console.log('ok 2 a new email is asked about once, never again');

  F.emails.push(em('m2', 'Newsletter'));
  F.reply = (u) => (/Newsletter/.test(u) ? { skip: true } : { title: 'x' });
  await run(); assert.strictEqual(F.calls, 1);
  await run(); assert.strictEqual(F.calls, 0, 'not-a-task is remembered');
  F.reply = null;
  console.log('ok 3 "not a task" is remembered — the leak');

  F.emails.push(em('m3', 'Q'));
  F.mode = 'fail'; await run(); assert.strictEqual(F.calls, 1);
  await run(); assert.strictEqual(F.calls, 0, 'waits after a failure');
  await pool.query(`UPDATE task_hub_triage SET last_attempt_at = now() - interval '16 minutes' WHERE source_ref = 'm3'`);
  await run(); assert.strictEqual(F.calls, 1, 'retry after 15 min');
  await pool.query(`UPDATE task_hub_triage SET last_attempt_at = now() - interval '3 hours' WHERE source_ref = 'm3'`);
  await run(); assert.strictEqual(F.calls, 1, 'retry after 2 h');
  await pool.query(`UPDATE task_hub_triage SET last_attempt_at = now() - interval '3 days' WHERE source_ref = 'm3'`);
  await run(); assert.strictEqual(F.calls, 0, 'gives up after 3 tries');
  F.mode = 'ok';
  console.log('ok 4 a failed call retries at 15 min and 2 h, then stops');

  F.wa = [{ chat_jid: 'g1@g.us', responsibleEmail: 'me@firm.co.il', label: 'G', blockText: 'when?', isGroup: true }];
  await run(); assert.strictEqual(F.calls, 1);
  await run(); assert.strictEqual(F.calls, 0);
  F.wa[0].blockText = 'when?\nhello??';
  await run(); assert.strictEqual(F.calls, 1, 'new client message -> asked once more');
  assert.strictEqual((await tasks()).filter((t) => t.source === 'whatsapp').length, 1, 'updated, not duplicated');
  const wa = (await tasks()).find((t) => t.source === 'whatsapp');
  await pool.query(`UPDATE unified_tasks SET status='done' WHERE id=$1`, [wa.id]);
  await run(); assert.strictEqual(F.calls, 0);
  assert.strictEqual((await tasks()).find((t) => t.id === wa.id).status, 'done', 'a WA task closed by hand stays closed');
  F.wa[0].blockText += '\nanyone?';
  await run(); assert.strictEqual(F.calls, 1);
  assert.strictEqual((await tasks()).find((t) => t.id === wa.id).status, 'open', 'reopens when the client writes again');
  console.log('ok 5 WhatsApp: once per content; new message -> once more; closed by hand stays closed');

  F.inbox = [{ source_item_id: 'v1', text: 'call Cohen', eff_at: new Date().toISOString() }];
  await run(); assert.strictEqual(F.calls, 1);
  F.calls = 0; await hub.refreshManualTasks(U); assert.strictEqual(F.calls, 0, 'fast path shares the memory');
  F.inbox.push({ source_item_id: 'v0', text: 'older voice note, transcribed late', eff_at: new Date(Date.now() - 3600e3).toISOString() });
  F.calls = 0; await hub.refreshManualTasks(U); assert.strictEqual(F.calls, 1, 'late-transcribed voice note is not lost');
  console.log('ok 6 task-inbox: once per message, shared with the voice fast path, late voice notes not lost');

  const n = (await pool.query('SELECT count(*)::int n FROM task_hub_triage')).rows[0].n;
  console.log('\nALL PASSED — memory rows:', n);
  await pool.end();
})().catch(async (e) => { console.error('FAIL', e); await pool.end(); process.exit(1); });
