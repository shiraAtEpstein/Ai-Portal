# Synopsis generator — screens 1–3

Deal picker → everything monday knows → fill what's empty → written back to the board that owns it.

**No model is called anywhere in this feature yet.** Screens 1–3 are entirely deterministic.

## Files

| Path | What it is |
|---|---|
| `config/synopsis-columns.json` | **The artifact that matters.** 68 fields: which board owns each, the column it is READ from on the deal, the column a write must TARGET on the owning board, type, required, writable. Column ids read from the live boards 18/08/2026. |
| `lib/synopsis/read.js` | Every monday read, through `monday.readQuery()` (mutations blocked there). Scoped to the mapped column ids only. |
| `lib/synopsis/missing-fields.js` | Which fields the board has no value for. Computed every run. |
| `lib/synopsis/write-gate.js` | The only write. The only GraphQL mutation in the feature. |
| `routes/synopsis.js` | Three routes, `authenticate` + `can()` on each. |
| `public/synopsis.html` | The screen. Hebrew, RTL, one file, cookie session like `settings.html`. |
| `test/synopsis.test.js` | 12 tests, `npm test`. Logic only — never touches monday. |
| `tools/check-synopsis-columns.js` | Verifies the map against the live boards. |

## Routes

```
GET  /api/synopsis/deals?q=          monday:read_board
POST /api/synopsis/facts  {dealId}   monday:read_board
POST /api/synopsis/fill   {dealId, values}   monday:write_own
```

Stateless on purpose: `/fill` re-reads the deal instead of trusting a cached run, so it is correct
across restarts and multiple Render instances, and the `before` value in each audit line is what
monday actually held a moment earlier.

## The write gate

Eight checks, in order; any failure rejects, logs and reports:

1. schema
2. **action whitelist** — `update_column` only. `create`, `delete`, `archive`, `move` are not in the set.
3. the field is on `config/synopsis-columns.json`
4. the field is writable and has a mapped target column
5. `can(session.roles, 'monday', 'write_own')` — the portal's own capability layer, not a second role table
6. routed to the board that **owns** the field. Writing to a mirror does nothing, so it is never attempted.
7. value validated against the **owning** column's type
8. written, **attributed to the signed-in person**, before/after logged as `[synopsis] {...}`

## Checking

```bash
npm test                                              # the rules. No token, no network.
MONDAY_API_TOKEN=... node tools/check-synopsis-columns.js   # do the columns still exist?
```

`npm test` cannot tell you whether `numeric_mkqfhayz` is still a real column — it never talks to
monday. The checker does, and reports `MISSING` / `TYPE` / `NO-READ` / `LABEL`, exiting non-zero on
the first two.

To work against a real deal without touching it: `LAWLY_READ_ONLY=1` — every write is validated,
logged and reported, none is sent.

## Before this is trusted on a live matter

1. **Review `config/synopsis-columns.json`.** `required` is a judgement from reading two English
   synopses; nobody at the firm has confirmed it. A wrong column id here becomes a wrong letter.
2. Settle the open questions listed in that file's `openQuestions` array — notably
   `סך המס` (200,000) vs `סך המס ל12א או תושבות` (2,606), which are two brackets and not alternatives.
3. Eight fields have no mirror on the deal board yet (`שפת התקשרות`, `חברה מוכרת אנגלית`, `עיר באנגלית`,
   `סטטוס הבניה`, `רחוב`, the three project-synopsis fields). Their write target is mapped; they cannot
   be READ from the deal until a mirror is added.
4. Columns that exist nowhere yet: `דמי רצינות`, `פנטהאוז`, `איחוד דירות`.
5. `dealBoards` currently lists only the contractor board (1603266152). Add יד 2 (1772652154) when it is needed.

## Note for later phases

`config/monday-boards.json` maps WORKFLOW columns (status, paralegal, milestone dates) for the daily
and alert agents. This map covers DEAL CONTENT for the letter. They overlap on exactly two columns —
`date81__1` and `date58__1`. Kept separate deliberately: different consumers, different lifecycles.
