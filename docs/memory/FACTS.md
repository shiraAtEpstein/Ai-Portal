# Layer 3b — Walled Matter Facts

Adds the second half of the architecture's memory model (spec §7): agents can
remember **client/matter facts** ("the what"), kept strictly separate from the
shared preferences ("the how") and walled so they can never leak.

## The two rules that make this safe

1. **Explicit-only.** A fact is stored **only** when a staff member explicitly
   asks ("remember for the Levi matter that the survey is delayed", "forget what
   I said about the Katz file"). The system never infers facts on its own.
2. **Strict per-agent wall + publishing block.** A fact is visible **only** to
   the exact agent it was stored with, for that user. The general router plus
   every externally-publishing (marketing) agent can **never** store or read any
   fact at all.

Together these mean a matter detail learned by, say, the Paralegal agent is
never reachable by a Marketing agent, another agent, or another user.

## How it works

- Facts live in a new `agent_facts` table (self-provisioning), keyed by
  `(user_id, agent_id, norm_key)`, **encrypted at rest** like everything else.
- On each turn the background extractor may return a fact **only** on an explicit
  remember/forget request; `observe()` stores it scoped to the current agent —
  and drops it entirely if that agent is fact-excluded.
- When you chat with a fact-eligible agent, its own facts load into the prompt
  under a header that marks them **confidential, internal, and possibly
  outdated** (verify against monday), with a reminder never to surface them
  externally.
- Facts **decay** after `MEMORY_FACT_DECAY_DAYS` (default **30** — shorter than
  preferences, because facts go stale fast) and are revocable with "forget that".

## Excluded agents (no facts, ever)

Default: `general, marketing_director, content_planner, mkt_copywriter,
copywriter`. Override with `MEMORY_FACT_EXCLUDE_AGENTS` (comma-separated agent
ids). The general router is excluded because it can pivot to a publishing skill.

## Config

| Var | Default | Meaning |
|-----|---------|---------|
| `MEMORY_FACT_DECAY_DAYS` | `30` | Days before an un-reaffirmed fact stops loading. |
| `MEMORY_FACT_MAX_ITEMS` | `30` | Max facts loaded into a prompt (per agent). |
| `MEMORY_FACT_EXCLUDE_AGENTS` | see above | Agents that may never store/read facts. |

## Verifying

The admin viewer (`GET /api/admin/memory?email=...`) now also returns a `facts`
array (all of a user's facts across agents, with `agentId`), so you can confirm
what's stored and which agent it's walled to.

## Not in this pass

Auto-learning of facts (kept explicit-only on purpose), and a cross-agent
"matter workspace" shared among internal legal agents (we chose strict per-agent).
