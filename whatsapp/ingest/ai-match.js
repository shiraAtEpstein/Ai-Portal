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
  if (!list.length) return null;                  // nothing to match against
  if (!claude.isConfigured() || !groupName) return null;

  // NOTE: we verify even a SINGLE candidate — the chat might be about an older
  // matter that isn't in the system at all, so a lone deal is not proof. The AI
  // must answer 0 (none) unless the chat is clearly about a listed deal.
  const options = list.map((d, i) => ({ n: i + 1, id: String(d.monday_item_id), name: d.name || '' }));
  const system =
    'You match a WhatsApp chat to the correct real-estate deal for a law firm. ' +
    'The chat name and the deal names may be in Hebrew or English, transliterated, ' +
    'abbreviated, nicknamed, or messy. The listed deals all belong to the SAME client, ' +
    'but the chat MIGHT be about a different / older matter that is NOT in the list. ' +
    'Choose a deal ONLY if the chat is clearly about it (matching surname AND ' +
    'property / neighbourhood / city). If you are not clearly confident, or the chat ' +
    'seems to be about a matter not listed, choose 0 (none). Never invent a deal. ' +
    'Reply with JSON only.';
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
