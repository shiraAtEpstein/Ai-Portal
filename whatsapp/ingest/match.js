// ============================================================
// whatsapp/ingest/match.js — pure name-matching for chat → deal resolution.
// No DB, no side effects. Given a WhatsApp group name and the candidate deals a
// client is linked to, pick the deal whose name the group name matches best.
// ============================================================

// Filler words that appear in chat names / deal names but don't identify the
// matter. The signal is the surname + property/place, so we drop the noise.
const STOP = new Set([
  // English
  'the', 'to', 'in', 'of', 'a', 'an', 'and', 'for', 'with', 'on', 'at', 'by',
  'purchase', 'purchasing', 'sale', 'selling', 'buy', 'buying', 'deal', 'journey',
  'amazing', 'group', 'apartment', 'apt', 'property', 'home', 'house', 'new',
  // Hebrew
  'של', 'עם', 'עסקה', 'דירה', 'נכס', 'רכישת', 'רכישה', 'מכירת', 'מכירה',
  'קבוצת', 'ווטסאפ', 'וואטסאפ', 'קבוצה', 'לקוח', 'לקוחות',
]);

function tokenize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && t.length >= 2 && !STOP.has(t));
}

// Count of distinct significant tokens shared between two names.
function sharedTokenCount(a, b) {
  const A = new Set(tokenize(a));
  if (!A.size) return 0;
  let n = 0;
  for (const t of new Set(tokenize(b))) if (A.has(t)) n++;
  return n;
}

// From the client's candidate deals, choose the one the group name matches.
//   0 candidates -> null
//   1 candidate  -> that one (no ambiguity to resolve)
//   >1           -> the single best name match; null if there's a tie or no
//                   overlap (ambiguous -> leave for review, never guess).
function pickDealByGroupName(groupName, candidates) {
  const list = (candidates || []).filter(Boolean);
  if (list.length <= 1) return list[0] || null;
  const scored = list
    .map((d) => ({ d, score: sharedTokenCount(groupName, d.name) }))
    .sort((x, y) => y.score - x.score);
  const top = scored[0];
  const second = scored[1];
  if (top.score >= 1 && top.score > second.score) return top.d;
  return null;
}

module.exports = { tokenize, sharedTokenCount, pickDealByGroupName };
