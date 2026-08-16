// ============================================================
// diag-chat.js — dump one chat exactly as the triage sees it. Read-only.
//   node diag-chat.js bloom          (matches the group name, case-insensitive)
// Shows each recent message: side (STAFF / client-or-other / FIRM-out), sender
// display name, and text — plus the cached AI verdict and WHEN it was computed.
// ============================================================
const pool = require('./db').getPool();
const enc = require('./lib/crypto');
const { textPreview } = require('./whatsapp/ingest/phone');

const arg = process.argv[2] || 'bloom';

(async () => {
  const g = await pool.query(
    `SELECT provider_group_jid, name, responsible_name
     FROM whatsapp_groups
     WHERE name ILIKE '%'||$1||'%' AND removed_at IS NULL
     LIMIT 4`,
    [arg]
  );
  if (!g.rows.length) { console.log('no group matched "' + arg + '"'); process.exit(0); }

  for (const grp of g.rows) {
    console.log('\n=== ' + grp.name + ' ===');
    console.log('    jid=' + grp.provider_group_jid + '  responsible=' + (grp.responsible_name || '(none)'));

    const r = await pool.query(
      `SELECT direction, sender_phone, sender_staff_phone9, deleted_at, payload_encrypted,
              COALESCE(sent_at, created_at) AS eff
       FROM processing_jobs
       WHERE source='whatsapp' AND chat_jid=$1
       ORDER BY eff DESC LIMIT 15`,
      [grp.provider_group_jid]
    );
    console.log('    last ' + r.rows.length + ' messages (oldest first):');
    for (const row of r.rows.reverse()) {
      let m = null; try { m = JSON.parse(enc.decrypt(row.payload_encrypted || '')); } catch (_) {}
      const who = (m && (m.pushName || m.verifiedBizName)) ? String(m.pushName || m.verifiedBizName).trim() : '(no name)';
      const t = (textPreview(m && (m.message || m)) || '').slice(0, 120);
      const side = row.sender_staff_phone9 ? 'STAFF' : (row.direction === 'out' ? 'FIRM-out' : 'client/other');
      console.log('      [' + side + (row.deleted_at ? ' DELETED' : '') + '] ' + who + ': ' + t);
    }

    const tr = await pool.query('SELECT verdict, updated_at FROM chat_triage WHERE chat_jid=$1', [grp.provider_group_jid]);
    if (tr.rows[0]) console.log('    -> cached verdict: ' + tr.rows[0].verdict + '  (computed ' + tr.rows[0].updated_at + ')');
    else console.log('    -> cached verdict: (none yet)');
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
