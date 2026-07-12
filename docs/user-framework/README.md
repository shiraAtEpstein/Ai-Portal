# User Framework (Layer 2)

This is **Layer 2** of the portal's framework stack, from the architecture spec
*AI Portal: Multi-Layer Framework & Memory Architecture*.

- **Layer 1 — Firm Core** (already live): the firm house rules, loaded on every
  answer from Dropbox `/shared-claude/framework/CLAUDE.md` (with DB/file
  fallbacks) plus the critical facts pinned in `routes/chat.js`.
- **Layer 2 — User Framework** (this): small, per-user **deltas** describing how
  *one person* prefers to work. Loaded right after the Firm Core on every chat.
- Layers 3–4 (agent memory, session context) are **not** part of this pass.

## The rule that makes this safe

> Firm Core always wins. The User Framework is **deltas only** — it never
> restates or overrides a firm, security, compliance, or legal rule.

The loader injects the user's framework *below* the firm rules and prefixes it
with a header that tells the model exactly that. A user with **no** framework
gets nothing added — pure Firm Core (the empty-state default).

## Where the files live (Dropbox)

Same Dropbox App folder the firm rules and agents already load from, one folder
per user, keyed by the **sign-in email, lowercased**:

```
/shared-claude/users/<email-lowercased>/profile.md
/shared-claude/users/<email-lowercased>/preferences.md
/shared-claude/users/<email-lowercased>/dos-and-donts.md
/shared-claude/users/<email-lowercased>/overrides.md
```

Example for shira@epsteinlaw.co.il:

```
/shared-claude/users/shira@epsteinlaw.co.il/profile.md
/shared-claude/users/shira@epsteinlaw.co.il/preferences.md
/shared-claude/users/shira@epsteinlaw.co.il/dos-and-donts.md
/shared-claude/users/shira@epsteinlaw.co.il/overrides.md
```

All four files are **optional**. Missing files are skipped silently. Create only
the ones you need; start with `preferences.md`.

## The four always-loaded files (spec §5.1)

| File | What goes in it |
|------|-----------------|
| `profile.md` | Who the person is: role, languages, a few key facts. |
| `preferences.md` | Communication, formatting, and reasoning style. |
| `dos-and-donts.md` | Hard personal rules ("always…", "never…"). |
| `overrides.md` | Explicit deviations from a firm default, **each with a reason**. |

Keep it short — the whole thing is capped at ~4,000 characters (about one page)
so it can never crowd out the firm rules. Do **not** paste firm policy in here;
if a line just repeats a firm rule, delete it.

## How it loads (`lib/user-framework.js`)

1. On each `/api/chat` request the portal reads the signed-in user's four files
   from Dropbox (read-only), newest read cached per-user for 5 minutes.
2. Present files are concatenated in priority order and capped.
3. The block is rendered with a "Firm Core always wins" header and appended to
   the system prompt right after `firmPreamble()`.
4. No files → nothing added.

## Configuration (optional env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `USER_FRAMEWORK_ROOT` | `/shared-claude/users` | Base Dropbox folder for user folders. |
| `USER_FRAMEWORK_MAX_CHARS` | `4000` | Hard cap on the combined block. |
| `USER_FRAMEWORK_TTL_MS` | `300000` | Per-user cache lifetime (5 min). |

None are required; the defaults work out of the box.

## Editing

Because Dropbox is the single source of truth and the portal's Dropbox access is
read-only, users (or an admin) edit these files **directly in Dropbox**. Changes
take effect within the cache window (≤5 min). An in-portal editor is a possible
future step, not part of this pass.
