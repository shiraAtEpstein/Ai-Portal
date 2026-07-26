// ============================================================
// whatsapp/ingest/ai-match.js — AI fallback for chat -> deal matching.
// Used only when the deterministic passes can't decide (e.g. the group name is
// in English and the deal name in Hebrew). Constrained SELECTION, not a guess:
// Claude is handed a fixed list of the client's deals and must pick one of them
// or answer "none". The backend then verifies the pick is a real candidate.
// ============================================================
const claude = require('../../lib/claude');

// Returns the chosen candidate object, or null if unsure / not configured.
async function pickDealByGroupNameAI(groupName, candidates) {
  const list = (candidates || []).filter(Boolean);
  if (list.length <= 1) return list[0] || null;   // nothing to disambiguate
  if (!claude.isConfigured() || !groupName) return null;

  const options = list.map((d, i) => ({ n: i + 1, id: String(d.monday_item_id), name: d.name || '' }));
  const system =
    'You match a WhatsApp chat to the correct real-estate deal for a law firm. ' +
    'The chat name and the deal names may be in Hebrew or English, transliterated, ' +
    'abbreviated, nicknamed, or messy. All candidate deals belong to the SAME client, ' +
    'so the distinguishing signal is usually the property, neighbourhood, or city. ' +
    'Choose the ONE deal the chat is about. If you are not clearly confident, choose 0 (none). ' +
    'Never invent a deal. Reply with JSON only.';
  const user =
    `WhatsApp chat name:\n"${groupName}"\n\n` +
    `Candidate deals:\n` +
    options.map((o) => `${o.n}. ${o.name}`).join('\n') +
    `\n\nReply exactly as JSON: {"choice": <the number of the matching deal, or 0 if unsure>}`;

  const out = await claude.askJSON({ system, user, model: 'haiku', maxTokens: 200 });
  if (!out) return null;
  const choice = Number(out.choice);
  if (!Number.isInteger(choice) || choice < 1 || choice > options.length) return null;

  // Validate: the pick must be one of the candidates we offered (backend owns identity).
  const pickedId = options[choice - 1].id;
  return list.find((d) => String(d.monday_item_id) === pickedId) || null;
}

module.exports = { pickDealByGroupNameAI };
