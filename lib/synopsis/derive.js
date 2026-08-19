'use strict';
// ============================================================
// lib/synopsis/derive.js — values the letter states that nobody should type.
//
// The attorney's fee, the broker's fee and the purchase tax are all a
// percentage of the purchase price. Typing them is how a stale figure from
// another deal survives: the Rosalimsky letter states purchase tax 200,545
// where 8% of 2,500,000 is 200,000. Computed, that error cannot happen.
//
// A value is only computed when the inputs are unambiguous. Where the tax
// profile is a bracket rather than a flat rate, nothing is computed and the
// field is asked for as before — a wrong number is worse than an absent one.
// ============================================================

const num = v => {
  const n = Number(String(v == null ? '' : v).replace(/[,\s₪]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** A flat percentage stated in the profile, e.g. "תושב חוץ - 8%" -> 8. */
function flatRate(profile) {
  const m = String(profile || '').match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

/**
 * @returns {object} key -> { value, formula, inputs } for everything computable
 */
function derive(map, values) {
  const out = {};
  const vat = typeof map.vat === 'number' ? map.vat : 0.18;
  const price = num(values.purchase_price);

  for (const [key, rule] of Object.entries(map.derive || {})) {
    if (price === null) continue;
    let pct = null;
    if (rule.pct) pct = num(values[rule.pct]);
    else if (rule.rateFrom) pct = flatRate(values[rule.rateFrom]);
    if (pct === null) continue;                       // not computable — keep asking

    const raw = price * (pct / 100) * (rule.vat ? 1 + vat : 1);
    out[key] = {
      value: String(Math.round(raw)),
      formula: rule.vat
        ? `${pct}% × ${price.toLocaleString('en-US')} × ${(1 + vat).toFixed(2)}`
        : `${pct}% × ${price.toLocaleString('en-US')}`,
      inputs: rule.pct ? [rule.pct, 'purchase_price'] : [rule.rateFrom, 'purchase_price']
    };
  }
  return out;
}

/** What the board holds vs what the arithmetic says. A mismatch is worth seeing. */
function compare(computed, values) {
  const rows = [];
  for (const [key, c] of Object.entries(computed)) {
    const onBoard = num(values[key]);
    rows.push({
      key, computed: Number(c.value), onBoard,
      formula: c.formula,
      agrees: onBoard === null ? null : Math.abs(onBoard - Number(c.value)) < 1
    });
  }
  return rows;
}

module.exports = { derive, compare, flatRate };
