# Agent Filter Cascade & Effort Layout — Plan

**Status:** Implemented and verified
**Date:** 2026-07-29
**Baseline:** working tree on `main` after the unified Agent filter / Data layout work
(uncommitted; `git status` shows `src/agent-filter.ts`, `src/model-family.ts`,
`src/agent-filter.test.ts` as new files)
**Verification bar:** `bun x tsc --noEmit -p .`, `bun test` (168 passing at plan time),
`bun run build`, plus a live check in the running app.

---

## Context for a cold pickup

Five independent changes requested in one message. They touch four areas:

1. **Agent filter** — parent/child cascade with an indeterminate state.
2. **Data view facet row** — vertical alignment bug in the first column.
3. **Efficiency findings** — drop the Supporting Sessions card, add split badges to list items.
4. **Effort aside** — bound the height of Model/Project breakdowns.
5. **Allowance profile cards** — add per-provider effort pie + top model×effort combos.

They are ordered below roughly by independence. **1, 2, 3 and 4 can each ship alone.**
5 depends on a new `familyColor` helper and a `SplitPill` component that 3 also wants, so
**do 3 before 5** to get the shared pill built once.

Key files:

| Area | File |
| --- | --- |
| Selection model + helpers | `src/agent-filter.ts` (+ `.test.ts`) |
| Filter popover UI | `src/views/chrome.tsx` (`AgentFilter`, `AgentFilterGroup`) |
| Filter wiring / option groups | `src/App.tsx` (`agentFilterGroups` memo, ~line 6260) |
| Facet row | `src/views/data/facets.tsx`, `.data-facets` in `src/styles.css` (~line 313) |
| Findings list | `src/views/data/efficiency.tsx` |
| Effort aside | `src/views/data/effort.tsx` (`ReasoningEffortAnalysis`) |
| Profile cards | `src/views/data/profiles.tsx`, `.profile-grid` in `src/styles.css` (~line 311) |
| Effort colours/labels | `src/components/effort/index.tsx` |
| Layout CSS added last session | `.findings-split*` in `src/styles.css` |

---

## 1. Agent filter: parent/child cascade with indeterminate state

**The pattern is called a tristate / indeterminate parent checkbox** (parent-child cascade
selection). Requested behaviour:

- Checking an agent ("claude") checks every model family under it — it *means* all of them.
- Unchecking one auto-checked child leaves the agent box unchecked while the remaining
  children stay checked.
- Re-checking the last missing child rolls back up to the agent being checked.

### Selection representation

Keep the existing `AgentEntry = "agent:X" | "model:Y"` union and keep union (OR) filter
semantics. **Normalise on every change** rather than storing a parallel "parent" flag:

- All children of an agent checked → store `agent:X`, drop that agent's `model:` entries.
- Some children checked → store the individual `model:` entries, no `agent:X`.
- None → neither.

Why normalise instead of always storing children: `agent:X` matches on `session.agent`, which
still catches a session whose model breakdown is empty or names a model not in the snapshot's
family list. Expanding to children only would silently drop those. This also keeps the server
contract unchanged — `agentSelectionParams` already maps agents to `providers` and models to
`modelFamilies`, and the server ORs them (`matchesAgentScope` in `server/effort-api.ts` and
`server/insights.ts`).

### Work

1. **`src/agent-filter.ts`** — add:
   - `type AgentTree = Array<{ agent: string; models: string[] }>` plus an `unparented: string[]`
     for families whose provider cannot be read from the name.
   - `buildAgentTree(agents: string[], families: string[]): { groups: AgentTree; unparented: string[] }`
     — assign each family to an agent by comparing `providerFromModel(family)` with
     `providerFromAgent(agent)`. Both already exist in `src/provider.ts`.
   - `entryState(selection, agent, models): "checked" | "indeterminate" | "unchecked"`.
   - `toggleAgent(selection, agent, models)` — checked/indeterminate → clear all; unchecked → set.
   - `toggleModel(selection, family, tree)` — flip one family, then normalise its parent.
   - `normalizeSelection(selection, tree)` — the roll-up/roll-down rule above. Every mutation
     returns through this so the invariant holds in one place.
2. **`src/views/chrome.tsx`** — `AgentFilter` renders one group per agent: the agent as a parent
   row, its models indented under it, plus a trailing "Other models" group for `unparented`.
   Parent input gets `ref` + `el.indeterminate = state === "indeterminate"` in an effect (the
   indeterminate flag is DOM-only, not an attribute). Give the parent
   `aria-checked="mixed"` when indeterminate.
   - **Change the `AgentFilterGroup` shape** to carry the parent, e.g.
     `{ agent?: {value, label}; options: [...] }`. `App.tsx` builds it from `buildAgentTree`.
3. **`src/App.tsx`** — replace the flat two-group `agentFilterGroups` memo with the tree form.
   Summary text in the button: when an `agent:` entry is present show the agent label; otherwise
   the existing "N selected" / single-label logic.
4. **CSS** — indent child rows (`padding-left`) and give the parent row slightly stronger text.

### Tests (`src/agent-filter.test.ts`)

- checking an agent yields `["agent:claude"]`, not the expanded children;
- unchecking one child of a checked agent yields every other claude family and no `agent:` entry;
- re-checking that child collapses back to `["agent:claude"]`;
- `entryState` returns `indeterminate` for a partial set;
- a family with no resolvable provider stays standalone and never affects a parent;
- filtering results are unchanged between `["agent:claude"]` and the fully-expanded child list
  **except** for a session whose models are unknown — assert that case explicitly, it is the
  reason normalisation exists.

---

## 2. Data facet row: first column vertical alignment

`.data-facets` (styles.css ~313) is `display:flex; align-items:end`. The controls are
label-over-input stacks, so their boxes sit on the baseline while `.data-facets__lead`
(icon + two lines of text) is bottom-aligned as a whole and reads as misaligned.

**Fix:** align the lead to the *control boxes*, not the row. Concretely: keep
`align-items:end` on the row, and give `.data-facets__lead` a `padding-bottom` equal to nothing
while setting its own `align-items:center`; if that still reads off, switch the row to
`align-items:center` and add `margin-top:auto` to the control stacks. Verify in the browser at
1600px and at the 1100px breakpoint — do not ship this one on CSS reasoning alone, it is
purely visual.

Also check the icon: `.data-facets__lead>svg` is `flex:0 0 auto` and centres against a
two-line block, which usually wants `align-self:flex-start` plus a small `margin-top`.

---

## 3. Findings list: drop Supporting Sessions, add split badges

The finding list already deep-links to each session, so the Supporting Sessions card in the
effort aside is redundant.

1. **`src/views/data/effort.tsx`** — delete the `SUPPORTING SESSIONS` `<article>` from
   `ReasoningEffortAnalysis`. The `supporting` memo and the `decoded` map in
   `useReasoningEffort` are still needed (see below), so keep `decoded` and **delete the
   `supporting` memo** and its now-unused `data.sessions` dependency. `effortColor`/`effortLabel`
   imports may become unused there — check before removing.
   `.effort-analysis-grid` drops from 3 columns to 2; update the rule and the `max-width:1100px`
   override that special-cases `:last-child`.
2. **New `SplitPill` component** (put it in `src/components/effort/index.tsx` next to
   `EffortBadge`, both sides of the app already import from there):
   `<SplitPill left={{label, color}} right={{label, color}} trailing?={string} />`
   rendering two colour-keyed halves. Colour must never be the only carrier — both halves keep
   their text label.
3. **`src/views/data/efficiency.tsx`** — accept a new prop
   `effortBySession: Map<string, DecodedSessionEffort>` (type from `src/hooks/use-effort.ts`),
   passed down from `intelligence.tsx` as `effort.decoded`. For each finding render
   `<SplitPill left={model} right={effortLabel(...)} />` in `.finding__top`. Use
   `effortSummaryLabel(decoded)` from `use-effort.ts` for the text so "mixed, mostly high" is
   phrased once in the codebase. Drop the now-duplicated model name from `.finding__meta`.
4. **`familyColor(family)`** — new helper, needed for the pill's left half. There is no
   family-colour helper today. Mirror `effortColor`'s structure in
   `src/components/effort/index.tsx`: fixed entries where sensible, otherwise a stable hash into
   a fallback palette. **Do not reuse `providerColor`** — every Claude model would be one colour
   and the pill would carry no information.

---

## 4. Effort aside: bound Model/Project breakdown height

Goal: the aside matches the findings row height, splits it between the two breakdown cards, and
respects a floor when the findings list is short.

Recipe (all in `src/styles.css`, `.findings-split*` block):

```
.findings-split{align-items:stretch}            /* was: start */
.findings-split__aside{
  display:flex; flex-direction:column; gap:10px;
  min-height:460px;                              /* floor for short lists */
  max-height:calc(100vh - 28px);                 /* ceiling for long lists */
}
.findings-split__aside .effort-analysis{flex:1 1 auto; min-height:0; display:flex; flex-direction:column}
.findings-split__aside .effort-analysis-grid{flex:1 1 auto; min-height:0}
.findings-split__aside .effort-analysis-card{min-height:170px; display:flex; flex-direction:column}
.findings-split__aside .effort-breakdown-list{flex:1 1 0; min-height:0; overflow:auto}
```

Notes:
- `position:sticky` currently on `.findings-split__aside` **conflicts with `align-items:stretch`**
  — a stretched grid item has a resolved height, so sticky then pins a full-height box and does
  nothing useful. Drop sticky, or keep it and drop stretch. Recommend dropping sticky; the
  max-height already keeps the aside near viewport height.
- `min-height:0` on every flex ancestor is load-bearing; without it `overflow:auto` never engages.
- Give the scrollable lists a visible scroll affordance (existing scrollbar styling if any).
- Re-check the `max-width:1240px` single-column fallback: the floor/ceiling should be relaxed
  there, since the aside is full-width and stacked.

---

## 5. Effort pies in the allowance profile cards

Move the per-provider effort summary out of the aside and into the `profile-grid` row.

**Target:** each profile card gains a column showing (a) a pie of effort distribution across
that provider's models and (b) underneath it, the most popular model×effort combos as split
pills, e.g. `Fable 5 | High  20%`.

### Data

`useEffortAggregate("model", scope)` already returns `rows: EffortGroupRow[]` where each row is
one model and `row.summary.levels[]` carries `{ effort, tokens, tokenShare }`. That is exactly a
model×effort matrix.

- Partition rows by `providerFromModel(row.key)`.
- Pie slices = effort levels summed across that provider's models, coloured with `effortColor`.
- Combos = flatten `(row.key, level.effort, level.tokens)`, share = `tokens / providerTotal`,
  sort desc, take top 3–4.
- Label the model with a shortened family name (`Fable 5` from `claude-fable-5`) — add a
  `familyLabel()` helper alongside `familyColor()`.

`ReasoningEffortAnalysis` currently requests the `provider` group aggregate; after this change
the aside no longer needs it, but the **profiles do**. Lift the effort request: `intelligence.tsx`
already owns `useReasoningEffort` and passes results into both children, so pass
`effort.models` into `AllowanceProfiles` rather than issuing a second request.

### Decisions — RESOLVED 2026-07-29

1. **Which bars move: the Data view's only.** `RAW REASONING EFFORT`'s provider bars (total +
   Codex + Claude articles) are replaced by the profile-card pies. **The Overview page's
   `REASONING SIGNAL` three-bar card is untouched** — the profile grid only exists on the Data
   view, so Overview keeps its own summary.
2. **The pies are UNFILTERED.** They request an empty effort scope (whole corpus) and do *not*
   move with the Agent filter, range, path tag, or the Data facets. This keeps the existing
   "the session facets below do not change these scores" sentence literally true for the whole
   card. Make the unfiltered-ness explicit in the UI rather than relying on the reader:
   - column heading per card: `EFFORTS ACROSS ALL CLAUDE` / `EFFORTS ACROSS ALL CODEX`
     (overline style), or a shared `UNFILTERED EFFORT DISTRIBUTION`;
   - a one-line note that the filters and rule chips below apply to the sessions sections, not
     to this column.
   Implementation consequence: **do not** reuse `effort.models` from `useReasoningEffort` (that
   one is scoped). Issue a separate `useEffortAggregate("model", {})` — an empty scope object
   already means "everything" after the previous session's plural-scope change. Put that request
   in `intelligence.tsx` and pass the aggregate into `AllowanceProfiles`.
3. Where the provider bars' **coverage line** goes. `EffortCoverage` ("87% of tokens have a
   recorded effort") is a real caveat and must not be dropped silently when the bars are replaced
   by pies. Put it under the pie legend in the card.

### Work

1. `familyColor()` + `familyLabel()` in `src/components/effort/index.tsx` (see §3).
2. New `ProviderEffortPie` component — Recharts `PieChart`, matching the existing `agent-mix`
   pie in `src/App.tsx` (~line 2555) for donut sizing and legend conventions.
3. `AllowanceProfiles` takes `modelEffort: EffortAggregate | null`; renders the new column inside
   `.profile-card`. Card becomes a 2-column grid on wide screens, stacked under ~420px.
4. Delete the provider bar block (`EffortStack` total + `.effort-provider-grid`) from
   `ReasoningEffortAnalysis`, leaving it as: heading, help text, then the two breakdown cards.
5. Empty/disabled states: `EffortState` already handles disabled/indexing/unavailable — reuse it
   inside the card column rather than inventing a second empty state.

---

## Risks / watch-items

- **`.effort-provider-grid` and `.effort-provider-bars`** (added last session for the Overview
  card) are separate rules. Deleting the Data-view provider grid must not disturb the Overview
  card's bars — grep both class names before removing CSS.
- The `insights.facets.modelFamilies` field is already unused by the client after the previous
  change. Leave it; unrelated to this work.
- `src/App.tsx` is ~6,600 lines. Prefer adding to `src/views/` and `src/components/` over growing it.
- Every new colour must pair with a text label — the codebase is explicit that colour is never
  the sole carrier of meaning (see the `effortColor` doc comment).

## Definition of done

- [x] Cascade behaves as described, including the partial-then-complete round trip.
- [x] Facet row first column visually aligned at 1600px and at the 1100px breakpoint.
- [x] Supporting Sessions gone; every finding row carries a model|effort split pill.
- [x] Aside height tracks the findings row with a working floor and internal scrolling.
- [x] Both profile cards show an effort pie + top combos, with the coverage caveat retained.
- [x] `bun x tsc --noEmit -p .` clean, `bun test` green, `bun run build` succeeds.
- [x] Live check of Overview, Explorer, Sessions and Data — no console errors, filters still narrow.
