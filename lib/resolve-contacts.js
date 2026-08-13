// ============================================================
// lib/resolve-contacts.js — one-time / on-demand backfill that resolves
// WhatsApp contacts to their monday CLIENT row by phone. This is the SAME
// match the ingest path does (monday.findClientByPhone against the לקוחות
// board index); it was simply never run over the backlog of contacts that
// were captured before matching existed, so they sit resolution_status =
// 'unresolved' with monday_item_id NULL even though the client IS in monday.
//
// Client-first by design: resolving the contact is what lets relink then find
// the deal the normal way. Contacts whose phone genuinely doesn't match any
// monday client (foreign numbers, spouse's phone, no phone in monday) stay
// unresolved — those are the only ones that later fall back to deal-by-name.
//
// Batched + read-mostly: the clients index is cached (30 min) so one call can
// resolve hundreds of contacts with a single monday board scan.
// ============================================================
const { getPool } = require('../db');
const monday = require('./monday');

// Resolve a batch of still-unresolved contacts. Returns { processed, resolved,
// remaining } so the caller can run it again until `remaining` stops dropping.
async function resolveUnresolvedContacts({ limit = 500 } = {}) {
  const p = getPool();
  if (!p) return { processed: 0, resolved: 0, remaining: 0 };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);

  // Unmatched contacts that actually have a usable phone to match on. A
  // phone shorter than 9 digits (or missing) can't key the clients index,
  // so skip it here rather than burn a lookup that can't succeed.
  const r = await p.query(
    `SELECT id, phone_normalized, display_name
       FROM wa_contacts
      WHERE monday_item_id IS NULL
        AND phone_normalized IS NOT NULL
        AND length(phone_normalized) >= 9
      ORDER BY updated_at DESC
      LIMIT $1`,
    [lim]
  );

  let resolved = 0;
  for (const c of r.rows) {
    try {
      // Plural match: returns every client row sharing this phone. One row is
      // the normal case; more than one is a couple / co-buyers on one number.
      // Either way we store the FIRST as the contact's client — for finding the
      // deal it doesn't matter which co-buyer we point at, and relink unions
      // both spouses' deal links so a one-sided link still resolves.
      const hits = await monday.findClientsByPhone(c.phone_normalized);
      if (!hits.length || !hits[0].monday_item_id) continue; // genuine no-match
      await p.query(
        `UPDATE wa_contacts
            SET monday_item_id     = $2,
                monday_client_name = COALESCE($3, monday_client_name),
                resolution_status  = 'resolved',
                updated_at         = now()
          WHERE id = $1`,
        [c.id, String(hits[0].monday_item_id), hits[0].name || null]
      );
      resolved++;
    } catch (e) {
      console.error('[resolve-contacts] failed for', c.phone_normalized, e.message);
    }
  }

  const rem = await p.query(
    `SELECT count(*)::int AS n FROM wa_contacts
      WHERE monday_item_id IS NULL
        AND phone_normalized IS NOT NULL
        AND length(phone_normalized) >= 9`
  );
  const remaining = (rem.rows[0] && rem.rows[0].n) || 0;
  console.log(`[resolve-contacts] processed ${r.rows.length}, newly resolved ${resolved}, still unresolved ${remaining}`);
  return { processed: r.rows.length, resolved, remaining };
}

module.exports = { resolveUnresolvedContacts };
