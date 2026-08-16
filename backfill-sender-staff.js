// ============================================================
// backfill-sender-staff.js — one-time. Fills processing_jobs.sender_staff_phone9
// for existing messages by matching the sender to a staffer by phone OR by the
// display name in the payload (recovers staff who appear as an @lid). Safe to
// re-run (only touches rows still NULL). Run:  node backfill-sender-staff.js
// ============================================================
const pool = require('./db').getPool();
const dir = require('./config/staff-directory.json');
const enc = require('./lib/crypto');
const { matchStaffByName } = require('./lib/responsible');
const { normalizePhone } = require('./whatsapp/ingest/phone');

const staff = dir.staff || [];

(async () => {
  const r = await pool.query(
    `SELECT id, sender_phone, payload_encrypted
     FROM processing_jobs
     WHERE source = 'whatsapp' AND sender_staff_phone9 IS NULL`
  );
  console.log('rows to check:', r.rows.length);

  let updated = 0, byPhone = 0, byName = 0;
  for (const row of r.rows) {
    let hit = null, how = '';
    // 1) by phone
    if (row.sender_phone) {
      const s = staff.find((x) => normalizePhone(x.phone9) === normalizePhone(row.sender_phone));
      if (s) { hit = s.phone9; how = 'phone'; }
    }
    // 2) by display name
    if (!hit) {
      try {
        const m = JSON.parse(enc.decrypt(row.payload_encrypted || ''));
        const pn = m && (m.pushName || m.verifiedBizName);
        if (pn) { const s = matchStaffByName(pn, dir); if (s) { hit = s.phone9; how = 'name'; } }
      } catch (_) {}
    }
    if (hit) {
      await pool.query('UPDATE processing_jobs SET sender_staff_phone9 = $2 WHERE id = $1', [row.id, hit]);
      updated++; if (how === 'phone') byPhone++; else byName++;
    }
  }

  console.log(`done — set sender_staff_phone9 on ${updated} rows (by phone: ${byPhone}, by name: ${byName})`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
