# Layer 4 — Session Context

The live conversation is the top layer: it overrides the layers below **in the
moment** and never persists to long-term memory without the user's say-so.

Most of this was already true and needs no code:

- **In-conversation instructions win.** Every loaded block (preferences, matter
  notes) carries a header stating that a direct instruction in the current
  conversation overrides it. The conversation history is also in the prompt, so
  a "just for this chat, answer in English" is honoured for that chat only.
- **Nothing persists silently.** Preferences are staged then promoted (they need
  recurrence or an explicit "remember"); matter facts are explicit-only. So the
  session never writes trusted memory on its own.

## What this layer adds: "don't remember this chat"

A real opt-out. If a user says something like *"don't remember this chat"*,
*"off the record"*, *"private chat"*, *"אל תזכור את השיחה הזאת"*, the whole
conversation is **muted**: the background learning pass (`observe`) never runs
for it again — no preferences staged, no facts stored. Loading still works, so
firm rules, the user's profile, and existing memory continue to apply; only
*writing* is suppressed.

### How it works

- A tiny self-provisioning `muted_conversations` table records the muted chat.
- `routes/chat.js` detects the phrase (English or Hebrew) on any turn, mutes the
  conversation, and thereafter **skips `observe`** whenever the conversation is
  muted. The assistant briefly confirms when the user just asked.
- Fail-safe: if the mute check errors, it returns "not muted" — a DB blip never
  silently drops learning the user didn't opt out of.

### Notes / limits

- Muting applies from the moment it's asked; earlier turns of the same
  conversation that were already learned aren't retroactively unlearned (the user
  can delete those from the **Your memory** screen).
- A future UI toggle can call the same mechanism instead of the typed phrase.
