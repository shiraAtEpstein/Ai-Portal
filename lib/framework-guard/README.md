# lib/framework-guard

A deterministic-first output gate for the portal. It is the enforcement step a
language model cannot give itself: the model has no separate check that runs
automatically before it speaks, so a promise to "always verify the signature /
the date / the language" is not enforceable. This module runs that check in
code, on the server.

## What it catches (the three reported failures)

| Failure | Rule | Check |
| --- | --- | --- |
| Guessed a signing date that was nowhere in the file | STYLE §5.2 | `unverified-fact` - every date/amount in the output must appear in `source` (the monday/tool data), or be wrapped `[VERIFY: ...]` |
| Signed an email "Tzipora / צפורה" (a name from the chat) instead of the signed-in user | House rule + profile | `signature-mismatch` - the signer must equal `profile.name` |
| Replied in Hebrew when the operator wrote English | STYLE §2 | `language-mismatch` - output language must match the required language |

It also catches em-dashes (banned everywhere), the two-Yaakovs collapse, banned
AI tells, decorative emojis, and unprompted USD.

## Two tiers

- **Tier 1 - deterministic.** Fast, certain, free. No model call. This is what
  the shadow hook below uses.
- **Tier 2 - critic.** An optional second model call for the fuzzy rules
  ("reads AI-generated", an invented fact phrased to look real). Pass a
  `critic` function to enable it; the portal can reuse its existing Anthropic
  client. Off by default.

## Files

- `index.js` - the checks and the public API (`validateOutput`, `generateWithGuard`).
- `rules.js` - every enforced rule as editable data. Change what is enforced here.
- `test.js` - runnable proof: `node lib/framework-guard/test.js` -> 14/14.

## API

```js
const { validateOutput } = require('../lib/framework-guard');

const report = await validateOutput(text, {
  channel: 'chat',            // 'email' | 'whatsapp' | 'chat' | 'doc'
  expectedLanguage: 'match',  // 'he' | 'en' | 'match'
  operatorLanguage: 'en',     // used when expectedLanguage === 'match'
  profile: { name: 'Shira' }, // the signed-in user
  source: lastToolText,       // the ONLY facts the output may assert
});
// report = { pass, blocked, violations, blocking, tier1, tier2 }
// each violation: { rule, severity, message, evidence, fix }
```

`critical` and `high` block delivery; `warning` does not.

## How this PR wires in: shadow mode, behind a flag, default OFF

Portal chat responses are **streamed** token by token, so a check that runs
after the full answer cannot un-send tokens. This PR therefore adds the module
plus a **shadow** hook: when `FRAMEWORK_GUARD` is set (`log`), the finished
answer is validated and any violation is **logged**, never blocked. Default off,
wrapped in try/catch, so it cannot change or break an existing chat.

Add the require near the top of `routes/chat.js`:

```js
const frameworkGuard = require('../lib/framework-guard');
```

Then, in the `/api/chat` handler, right after `runStreamingChat` returns and
before `sse(res, 'done', ...)`:

```js
// Framework guard (shadow): validate the finished answer against the firm
// rules and LOG violations. Off unless FRAMEWORK_GUARD is set. Never blocks
// or alters the reply, so it cannot break an existing chat.
let guard = null;
if (process.env.FRAMEWORK_GUARD && process.env.FRAMEWORK_GUARD !== 'off') {
  try {
    guard = await frameworkGuard.validateOutput(answer, {
      channel: 'chat',
      expectedLanguage: 'match',
      operatorLanguage: frameworkGuard.detectLanguage(message),
      profile: { name: req.session.name },
      source: buildCtx.lastToolText || '',
    });
    if (!guard.pass) {
      console.warn('[GUARD] ' + name + ' -> ' + agentId + ' | ' +
        guard.blocking.map(function (b) { return b.rule; }).join(', ') + '\n' +
        frameworkGuard.formatReport(guard));
    }
  } catch (e) { console.error('[GUARD] check failed:', e.message); }
}
```

Turn it on in Render with `FRAMEWORK_GUARD=log`, watch the logs for a few days,
then decide on enforcement.

## Catching the wrong-signer failure on drafts

The "Tzipora" signature failure happens inside an email **draft**, not the
streamed chat text. Drafts go through the `gmail_draft` tool, whose body is not
streamed, so it is the natural place to enforce (not just log). Suggested shadow
check inside that tool's `run`, before `gmail.createDraft`:

```js
if (process.env.FRAMEWORK_GUARD && process.env.FRAMEWORK_GUARD !== 'off') {
  try {
    const rep = await frameworkGuard.validateOutput(String(args.body || ''), {
      channel: 'email', profile: { name: session.name },
    });
    if (!rep.pass) console.warn('[GUARD] gmail_draft | ' +
      rep.blocking.map(function (b) { return b.rule; }).join(', '));
  } catch (e) { console.error('[GUARD] draft check failed:', e.message); }
}
```

In a later PR this same check becomes enforcing: return the violations to the
model to redraft, or hold the draft, instead of only logging.

## The enforcement loop (for the non-streamed path, later)

`generateWithGuard(generate, ctx, { maxAttempts })` regenerates until the output
passes, feeding the violations back each time, and returns `pass: false` if it
never does so the caller can hold it for review. Use it wherever the portal can
buffer instead of stream (drafts, background daily briefs).

## Honest limits

- `unverified-fact` needs `source`; without it that check is skipped (it will
  not guess for you). In chat, `source` is `buildCtx.lastToolText` - the last
  monday/gmail/dropbox data the turn fetched.
- Tier 2 quality is the critic model's quality. Keep it at temperature 0.
- This gate enforces the mechanical, checkable rules. It does not judge legal
  substance, and it does not replace confirm-before-send (STYLE §5.1).
