// ============================================================
// diag-attribution.js — how well can we attribute messages to each staffer?
// Shows, per staff member, how many messages match by PHONE vs by NAME
// (the pushName WhatsApp attaches even when the sender is an @lid). Read-only.
// Run:  node diag-attribution.js       (delete after use)
// ============================================================
const pool = require('./db').getPool();
const dir = require('./config/staff-directory.json');
const enc = require('./lib/crypto');
const { matchStaffByName } = require('./lib/responsible');
const { normalizePhone } = require('./whatsapp/ingest/phone');

function ph9(s) { const d = String(s == null ? '' : s).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : d; }
const staffByPhone = new Map((dir.staff || []).map((s) => [normalizePhone(s.phone9), s]));

(async () => {
  const r = await pool.query(
    `SELECT sender_phone, payload_encrypted
     FROM processing_jobs
     WHERE source = 'whatsapp' AND sent_at > now() - interval '30 days'`
  );

  const tally = {};                 // staff name -> { phone, name }
  const bump = (who, how) => { tally[who] = tally[who] || { phone: 0, name: 0 }; tally[who][how]++; };
  let total = 0, withPush = 0, unmatched = 0, lidNoName = 0;

  for (const row of r.rows) {
    total++;
    // 1) match by phone number
    const byPhone = row.sender_phone ? staffByPhone.get(normalizePhone(row.sender_phone)) : null;
    if (byPhone) { bump(byPhone.name, 'phone'); continue; }

    // 2) match by the display name in the payload (recovers @lid senders)
    let pushName = null;
    try {
      const m = JSON.parse(enc.decrypt(row.payload_encrypted || ''));
      pushName = m && (m.pushName || m.verifiedBizName || (m.key && m.key.pushName));
    } catch (_) {}
    if (pushName) withPush++;
    const byName = pushName ? matchStaffByName(pushName, dir) : null;
    if (byName) { bump(byName.name, 'name'); continue; }

    if (!pushName) lidNoName++;
    unmatched++;
  }

  console.log(`\nMessages last 30 days: ${total}`);
  console.log(`  carried a display name (pushName): ${withPush}`);
  console.log(`  matched to NO staff (clients + unnamed): ${unmatched}  (of those, ${lidNoName} had no name at all)\n`);
  console.log('Per staff — how many of their messages we can attribute:');
  console.log('  (phone = matched by number, name = recovered by display name)\n');
  const rows = Object.entries(tally).sort((a, b) => (b[1].phone + b[1].name) - (a[1].phone + a[1].name));
  for (const [name, c] of rows) {
    console.log('  ' + name.padEnd(24) + ' phone=' + String(c.phone).padStart(4) + '   name=' + String(c.name).padStart(4) + '   total=' + (c.phone + c.name));
  }
  if (!rows.length) console.log('  (no staff messages attributed at all)');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
