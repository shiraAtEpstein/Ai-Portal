# CLAUDE.md - Epstein & Co. Plugin Monorepo
# הנחיות לקלוד - מונורפו פלאגינים, אפשטיין ושות'

> The auto-loaded brain. Read this first; every other doc in the framework
> hangs off here. If you only have time for one file, read this one and
> follow its pointers as the work demands.
>
> Owner: Shira & Tzipora · Status: v0.1 draft · Last updated: 24 May 2026

---

## 1. What we do

Epstein & Co. is an Israeli real-estate law firm. We represent buyers and sellers, mostly clients from abroad, across four service lines:

- **רכישה מקבלן** (purchase from contractor): creates an עסקת קבלן.
- **רכישה ביד שתיים** (second-hand purchase): client is the buyer.
- **מכירה ביד שתיים** (second-hand sale): client is the seller.
- **כתיבת צוואה** (will writing).

The firm runs day-to-day work through monday.com, with most automations built in make.com. Each deal has its own monday item holding client info, apartment details, fees, and payment milestones.

---

## 2. How we work

Source of truth is monday.com. Two main deal boards exist (contractor and second-hand). If a deal name might exist on both, always ask which board to search.

Client deliverables (expense Excels, registration follow-ups, letters) and all legal forms are generated from monday data, never hand-typed.

Working languages: deal documents and monday content are mostly in Hebrew, but we serve both Hebrew-speaking and English-speaking clients. Match the client's language in any client-facing output. Preserve Hebrew text exactly as written: no transliteration, no "cleanup" of names or addresses.

---

## 3. House rules for Claude

The full operator-voice and output rules live in `STYLE.md`. The non-negotiables, repeated here for convenience:

- Never invent a monday.com board, group, or column name. If unsure which board a deal lives on, ask.
- Never invent client names, ID numbers, apartment addresses, or payment amounts. Pull them from monday or from the source document the user provided.
- Hebrew names and addresses must be reproduced exactly: no transliteration, no "cleanup".
- **The two Yaakovs**: the boss is **Yaacov Epstein** (spelled `ac`). The paralegal is **Yaakov Hershkovitz** (spelled `ak`, always with surname). Default referent of bare "Yaacov" is the boss. Never collapse the two spellings; never rewrite "Yaakov Hershkovitz" to "Yaacov" or vice versa. See GLOSSARY.md "People at the firm".
- Currency: amounts are in ש"ח / NIS unless explicitly stated otherwise. Don't convert to USD without being asked.
- Dates in client-facing files: `MMM DD, YYYY` (e.g., May 13, 2026). Internal docs use written-out form (e.g., 13 May 2026). Both are unambiguous for American and Israeli readers.
- When a deal name appears in both the contractor board and the second-hand board, stop and ask which one before doing anything else.
- Never send email, post updates, or change monday item values without explicit confirmation in chat. See STYLE.md §5.1 for what "explicit" means.

---

## 4. Which skill, which file

For producing files, prefer the firm's own skills over the generic ones:

- Real-estate registration forms (טופס הרשמה / הסכם הרשמה) go to the `real-estate-transaction-coordinator` skill, not the generic `pdf` skill.
- Client expense Excels (דוח הוצאות / אקסל הוצאות) go to the `client-expense-excel` skill. Never reconstruct the template manually.
- Word documents, PDFs, spreadsheets, presentations with no firm-specific skill go to the matching generic `docx`, `pdf`, `xlsx`, `pptx` skill.

---

## 5. The framework

Five files. Read the matching one before producing the matching output.

| File | Owns |
|------|------|
| `CLAUDE.md` *(this file)* | The auto-loaded brain. House rules, what the firm does, pointers to everything else. |
| `STYLE.md` | Operator voice, language rules, shared output anchors, interaction behavior, SKILL.md description authoring. |
| `ARCHITECTURE.md` | Plugin layout, folder structure, manifest format, naming, versioning, packaging. |
| `PATTERNS.md` | Reusable snippets: monday column-value JSON, skill description template, RTL markdown rules, standard email signature. |
| `GLOSSARY.md` | Hebrew/English office vocabulary, the words the team actually uses. |

When two docs seem to disagree:

- STYLE.md wins on voice, language, and operator interaction.
- ARCHITECTURE.md wins on plugin structure and file layout.
- PATTERNS.md wins on the exact shape of a recurring snippet.
- GLOSSARY.md wins on what a term means inside the office.

---

## 6. Current focus

Building a few working agents on a Pain-Driven MVP basis: start from the most painful manual task and automate that first, rather than building generic agents.

Building the structure for implementing Claude AI in the team's day-to-day workflow: which tasks Claude owns, which need human sign-off, how outputs get routed back into monday and make.

---

## 7. Change log

| Date | Editor | Change |
|------|--------|--------|
| 13 May 2026 | Shira (v0 draft) | Initial draft from Layer-1 monorepo setup |
| 24 May 2026 | Shira (with Claude, v0.1) | Full rewrite as the framework index. Removed stale placeholder list. Added pointers to ARCHITECTURE.md and PATTERNS.md. Standardized firm name to "Epstein & Co.". |
