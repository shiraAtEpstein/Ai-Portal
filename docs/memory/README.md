# Agent Memory (Layer 3)

**Layer 3** of the portal framework stack: the assistant *learns and remembers*
how each person likes to work, so it improves over time instead of starting cold
every conversation.

This first pass is **preferences only** and follows the architecture's core
discipline: **stage, then promote** — nothing learned automatically is trusted
until it recurs or the user confirms.

## What it stores — and what it never stores

- **Stores (the "how"):** durable working/style preferences — tone, language,
  formatting, length, structure, salutations, reasoning style.
  *e.g. "Reply concisely", "Sign off in Hebrew", "Put deadlines at the top".*
- **Never stores (the "what"):** client names, matter/deal facts, numbers,
  amounts, dates, addresses, tasks. The extractor is instructed to refuse them,
  and a second `looksLikeClientFact` guard drops them even if the extractor
  slips. So this pass has **no confidentiality wall to get wrong** — there are no
  client facts in memory to leak.

## The staging pipeline (architecture §6)

1. **Observe.** After each exchange, a cheap background pass proposes 0–3
   candidate preferences from what the *user* said. This never blocks the reply.
2. **Stage.** Each candidate is stored with an evidence count. Staged candidates
   do **not** affect answers yet.
3. **Promote.** A candidate becomes *trusted* memory only after it recurs
   `MEMORY_PROMOTE_AFTER` times (default **3**) — or the user says "remember
   that…", which promotes it once, immediately.
4. **Decay.** Trusted memories carry a `last_reaffirmed` date and quietly stop
   loading once older than `MEMORY_DECAY_DAYS` (default **180**). Seeing the same
   preference again reaffirms it.
5. **Revoke.** "Forget that…" revokes a memory. Everything is reversible.

Trusted memories load into the prompt **below** the Firm Core and the personal
profile, with a header stating that both — and any direct instruction in the
current conversation — always win over them.

## Where it lives

PostgreSQL (the portal's Dropbox is read-only; memory must be written). Two
tables, created automatically on first use (`CREATE TABLE IF NOT EXISTS`):

- `memory_candidates` — staged items with `seen_count` and `status`.
- `user_memory` — trusted items with `last_reaffirmed` and `revoked_at`.

Preference text is **encrypted at rest** with the same AES-256-GCM helper used
for chat messages (`lib/crypto`, key in `CHAT_ENC_KEY`). The dedup key is an
opaque SHA-256 of the normalized text, so no readable preference is stored in the
clear. Memory is **per user** and shared across that user's agents (it's only
style preferences).

### Manual SQL (optional)

Tables self-provision, but if you'd rather create them ahead of time:

```sql
CREATE TABLE IF NOT EXISTS memory_candidates (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  norm_key text NOT NULL,
  content_enc text NOT NULL,
  seen_count int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'staged',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, norm_key)
);
CREATE TABLE IF NOT EXISTS user_memory (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  norm_key text NOT NULL,
  content_enc text NOT NULL,
  source text NOT NULL DEFAULT 'promoted',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_reaffirmed timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, norm_key)
);
```

## Configuration (all optional, sensible defaults)

| Var | Default | Meaning |
|-----|---------|---------|
| `MEMORY_ENABLED` | `1` | Master switch. Set `0` to disable loading and learning entirely. |
| `MEMORY_OBSERVE` | `1` | Set `0` to keep loading existing memory but stop learning new. |
| `MEMORY_PROMOTE_AFTER` | `3` | Sightings before a candidate is promoted. |
| `MEMORY_DECAY_DAYS` | `180` | Days before an un-reaffirmed memory stops loading. |
| `MEMORY_MAX_ITEMS` | `20` | Max memories loaded into a prompt. |
| `MEMORY_MODEL` | `claude-haiku-4-5-20251001` | Cheap model for the extraction pass. |

## Safety properties

- **Fail-safe:** loading and the background learning pass are each wrapped so any
  error is swallowed — memory can never break a chat. A user with no memory gets
  nothing added.
- **Never auto-writes trusted memory:** automation only stages; promotion needs
  recurrence or explicit confirmation.
- **Preferences never override the Firm Core**, the personal profile, or a direct
  instruction in the live conversation.
- **Cost/latency:** the extraction pass is one small Haiku call per turn, run in
  the background after the reply is sent. Turn it off with `MEMORY_OBSERVE=0`.

## What's next (not in this pass)

- Client/matter-fact memory **walled per agent** (the confidentiality boundary in
  §7), unreachable by any externally-publishing agent (Marketing).
- A "your memories" screen so users can see and delete what's remembered.
