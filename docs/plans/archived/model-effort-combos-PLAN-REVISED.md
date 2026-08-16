# Model × Effort Rework — Revised Plan

**Status:** Not started  
**Revised:** 2026-08-15  
**Validated against:** local `main` at `78833bb` (v1.12.0 plus the Explorer overflow fix),
with unrelated in-progress plan archival changes already present  
**Original:** `model-effort-combos-PLAN.md` (preserved unchanged)  
**Verification bar:** `bun run typecheck`, `bun test`, `bun run build`, and live keyboard,
hover, pin, filter, and responsive checks in the already-running app on `5173`.

---

## Goal and product contract

Make **model family × provider-recorded effort** the primary unit everywhere a user is comparing
effort. `High` alone is not a decision unit; `Opus 5 · High` and `Sol · High` are different
cohorts.

Keep these contracts throughout the implementation:

- The combo is `{ family: familyOf(rawModel), effort: normalizeEffort(rawEffort) }`.
- Effort-only aggregates remain available as an explicit secondary mode.
- Recorded evidence is never turned into a recommendation or a causal claim.
- Tokens and observations are combo-attributable. Session cost, efficiency findings, and verdict
  are not; those outcome metrics are shown only for sessions a combo uniquely led.
- Missing reasoning reporting is `null`, not zero. A reported zero remains zero.
- Unknown, synthetic, and automated activity remains in volume and coverage totals, but never in
  human-work comparisons.
- Capped charts preserve totals through `Other combos`; they never discard the remainder.
- A user's verdict is never inferred and is never silently overwritten by another annotation
  write.

The user's task axis remains project (`cwd`) plus path tag. Both are session-derived proxies, so
copy must say “session context,” not imply that every transcript event was directly attributed to
a task.

### Volatile corpus evidence

The local index changes while the app runs. At review time it contained 32 non-empty-effort raw
model × effort pairs across 14 raw model keys and five efforts (`low`, `medium`, `high`, `xhigh`,
`max`). These numbers are motivation, not fixtures or acceptance criteria. Keep the diagnostic SQL
in a code comment or test helper instead of freezing live counts into UI copy.

---

## Corrections incorporated from review

The original direction is sound, but these implementation assumptions need correction:

1. **Do not add `day-model` to the current `EffortGroup` pipeline.** `denominators()` handles only
   `day` specially; an unmodified new group would fall into the raw-model branch and produce keys
   that cannot match `date\0model`, giving every cell a zero denominator. More importantly, the
   chart only needs day-level reconciliation, not a new per-model denominator.
2. **The daily ccusage snapshot does have model breakdowns.** Both `snapshot.daily[*]` and its
   provider rows carry `modelBreakdowns`; `projectActivity[*].models` also carries model totals.
   The original “no per-model split” premise is false. The revised chart still uses the existing
   authoritative *day total*, which avoids unnecessary per-cell allocation entirely.
3. **Reconciliation stays per day.** Query flat day × raw-model × effort buckets, collapse raw
   models to families in TypeScript, and reconcile their sum against `dailyDenominators()`. This
   preserves the existing suppression contract and avoids suppressing valid model cells merely
   because a multi-day session is allocated to its last-activity day.
4. **The session digest must change.** Its current tuple contains only effort-level information;
   it cannot render, sort, search, or filter by a dominant combo.
5. **The combo facet must keep session-selection semantics.** Selecting a combo chooses sessions
   containing it, then retains every combo in those sessions downstream. Pushing a model/effort
   predicate into all SQL queries would silently erase the rest of each selected session.
6. **Annotation writes are replacements today.** `setAnnotation()` overwrites tags and note, the
   table has no foreign-key cascade, and the dashboard snapshot is cached. Verdict capture needs
   field-preserving setters plus explicit cache/version invalidation.
7. **The combo ETag must include annotation state.** `snapshot.collectedAt` and effort
   `indexVersion` do not change when a verdict changes; without an annotation revision, scoreboard
   ratings remain stale behind `304` responses and `memoizedBody()`.
8. **Reasoning availability is determined by `reasoning_reported_events`.** A zero sum can mean a
   real reported zero. Use the event count to distinguish it from an unsupported provider.
9. **Outcome leadership needs a tie rule.** Only a unique largest attributed-token combo leads a
   session. Tied sessions contribute volume to every present combo but to no outcome cohort.
10. **Verdict percentages need their own sample floor.** Five led sessions do not make one rating
    a credible `100% good`; show verdict percentages only after at least five ratings.
11. **Top-project context is not available from the current `EffortByDay` props.** Add the correct
    context input. On the project page, showing the same project repeatedly is redundant; show path
    tags there instead.

---

## Phase 0 — Shared combo vocabulary and the two `max` fixes

Create `src/combo.ts` and `src/combo.test.ts`. Keep it dependency-light so both server and client
can use it.

```ts
export type Combo = { family: string; effort: string };
export type ComboKind = "interactive" | "automated" | "synthetic" | "unknown";

comboOf(rawModel, rawEffort): Combo
comboKey(combo): string                    // internal NUL-delimited key
parseComboKey(key): Combo | null
comboLabel(combo): string                  // "Opus 5 · High"
comboShortLabel(combo): string             // dense axis/legend form
comboKind(rawModel): ComboKind
comboColor(combo): string
encodeComboFacet(combo): string            // URL/form-safe JSON tuple; not the NUL key
parseComboFacet(value): Combo | null
selectComboSeries(buckets, limit): string[] // top N globally, then family-block display order
capComboBuckets(buckets, selected): ...     // totals-preserving `other`
```

Implementation rules:

- `comboOf()` is the only raw-model → family conversion and calls `familyOf()`.
- `comboKey()` is for in-memory maps and chart series only. The facet encoder uses
  `combo:${JSON.stringify([family, effort])}` so delimiters in future model names cannot collide.
- Keep lexical combo comparison pure. Volume-aware display order belongs in
  `selectComboSeries()`: select the top N combos by total tokens (observations when that basis is
  active), then order selected families by their selected total and efforts by `effortRank()`.
- `comboColor()` uses the family hue and a bounded effort tint. Prefer `color-mix(in oklab, ...,
  white)` weights that approach the base family colour as effort rises; do not mix toward black on
  the dark theme. Unknown/other remain neutral. Verify every ramp segment against the panel
  background and never rely on colour without text.
- Classify `codex-auto-review` as `automated`, `<synthetic>` as `synthetic`, and an empty model as
  `unknown`. These rows remain visible in volume/coverage with explicit labels. Only
  `interactive` rows enter outcome comparisons or contrast copy.

Update `src/effort-model.ts`:

- Change canonical order to `low`, `medium`, `high`, `xhigh`, `max`.
- Add tests proving `max` sorts after `xhigh`, and future unknown efforts still sort afterward.

Update `src/components/effort/index.tsx`:

- Give `max` an explicit effort-only colour.
- Extend `EFFORT_HELP` to say effort is meaningful only beside the model that recorded it.
- Narrow `EffortCoverage`'s prop to the coverage fields it actually reads so combo responses can
  reuse it without pretending their buckets are effort-only `EffortSummary.levels`.

Do **not** put “family by volume” into a `compareCombo(a, b)` API: a `Combo` contains no volume, so
that contract cannot be implemented honestly.

---

## Phase 1 — Combo data contracts

### 1a. Daily combo endpoint; keep day-level reconciliation

Add `queryEffortCombosByDay()` in `server/effort-store.ts`. Its SQL text stays constant and uses
the existing bound scope filters:

```sql
SELECT u.occurred_on AS day, u.model, u.effort,
       SUM(u.observations) AS observations,
       SUM(u.total_tokens) AS tokens,
       SUM(u.output_tokens) AS output_tokens,
       SUM(u.reasoning_output_tokens) AS reasoning_output_tokens,
       SUM(u.reasoning_reported_events) AS reasoning_reported_events
FROM session_effort_usage u
JOIN session_paths p ON p.session_id = u.session_id
-- existing bound filters
GROUP BY u.occurred_on, u.model, u.effort
```

Add `buildEffortComboDays(snapshot, scope)` and `GET /api/effort/combo-days`.

Server folding algorithm:

1. Reuse `scopedSessions()`, the effort facet's session allowlist, `effortQuery()` date semantics,
   and `dailyDenominators()`.
2. Collapse raw model variants with `comboOf()` in TypeScript, summing equal family × effort
   buckets for each day.
3. Build output dates from the **union** of query dates and denominator dates. A day with no
   derived rows must still be representable as all-unknown coverage rather than disappearing.
4. For each day, sum tokens only from rows with a recorded effort into `attributedTokens`.
   Empty-effort observations contribute to `unknownObservations`; un-attributed authoritative
   tokens remain `unknownTokens`.
5. Reconcile the entire day's attributed tokens against the existing authoritative day total.
   If attributed exceeds eligible, suppress the whole day exactly as today. Do not invent a
   `(day, model)` denominator or per-cell suppression.
6. Calculate bucket reasoning share as:

   ```ts
   reasoningReportedEvents === 0 || outputTokens === 0
     ? null
     : reasoningOutputTokens / outputTokens
   ```

   Thus a provider-reported zero is `0`, while unsupported reporting is `null`.

Add explicit types in `src/types.ts`:

```ts
type EffortComboBucket = Combo & {
  kind: ComboKind;
  observations: number;
  tokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  reasoningReportedEvents: number;
  reasoningShare: number | null;
};

type EffortComboDayRow = {
  key: string;
  buckets: EffortComboBucket[];
  coverage: EffortCoverageFields;
  suppressed: boolean;
};
```

The response also carries the overall coverage and current `EffortIndexStatus`. ETag and memo keys
include the route, `snapshot.collectedAt`, effort `indexVersion`, and `scopeKey(scope)`.

Add `useEffortComboDays()` beside the existing effort hooks. Do not add `day-model` to
`EffortGroup`; the existing effort-only API stays unchanged.

### 1b. Combo scoreboard endpoint

Add `queryEffortCombosBySession()` grouped by `session_id, model, effort`, returning token,
observation, output, reasoning-output, and reporting-event sums. Collapse raw models to families
per session before determining leadership.

Add `buildEffortComboBoard(snapshot, scope)` and `GET /api/effort/combos`.

For every combo return:

| Field | Exact meaning |
| --- | --- |
| `family`, `effort`, `kind` | Shared combo vocabulary |
| `tokens`, `observations` | All scoped appearances of the combo |
| `sessionsAppeared` | Distinct scoped sessions containing the combo |
| `sessionsLed` | Sessions where it is the unique largest combo by attributed tokens |
| `tiesExcluded` | Tied sessions that entered no outcome cohort |
| `reasoningShare` | All attributable appearances; event-count availability guard |
| `medianTokensPerLedSession` | Median whole-session tokens over the led cohort |
| `medianCostPerLedSession` | Median whole-session cost over the led cohort |
| `flagRate` | Led sessions with at least one existing efficiency rule finding / led sessions |
| `verdict` | `{ rated, good, mixed, bad, goodRate }` over led sessions only |
| `projects` | Top project ids by this combo's attributed tokens |

Outcome rules:

- A session with one combo leads that combo.
- A session with several combos has a leader only when one has strictly more attributed tokens
  than every other combo. A tie is not broken alphabetically.
- If attributed tokens are all zero, fall back to observations only when there is one unique
  observation leader; otherwise it is a tie/no leader.
- Cost, token, and flag comparisons render only for `sessionsLed >= 5`.
- Verdict counts may always render, but `goodRate` is `null` until `rated >= 5`.
- `synthetic`, `automated`, and `unknown` combos never receive comparative metrics, even when
  their volume is high.

Do not derive flag rate from `buildInsights().efficiency.findings`, because that public array is
truncated to 80. Refactor/export a server helper that returns the **untruncated set of session
ids** tripping at least one of the same six rules, and call it once for the scoped cohort.

### 1c. Digest v2 and combo facet

Replace the effort-only session digest with a versioned combo-aware shape. Keep it compact, but do
not encode model family into an effort index.

```ts
type EffortSessionDigest = {
  version: 2;
  families: string[];
  efforts: string[];
  combos: Array<[familyIndex: number, effortIndex: number, kind: ComboKind]>;
  // flags: 1 mixed effort, 2 unknown activity, 4 unjoinable, 8 multiple combos
  rows: Array<[
    sessionId: string,
    dominantComboIndex: number,
    flags: number,
    coveragePerMille: number,
    comboMaskHex: string,
  ]>;
};
```

- Dominant display combo uses tokens, then observations, then a stable combo-key tie-break. This
  display tie-break does **not** make the combo an outcome leader.
- Derive each decoded session's combo set and effort set from the mask. Preserve “Mixed effort”
  as two or more distinct efforts; track “multiple combos” separately.
- `effortSearchText()` includes family labels, raw family ids, and efforts so `luna max` works.
- Session table rendering uses the dominant `SplitPill`, with a `+N` trailing count when multiple
  combos were recorded.

Keep one Data facet field rather than introducing a contradictory second scope member. Extend the
existing `effort` facet grammar with the URL-safe value emitted by `encodeComboFacet()`:

- `all`, `mixed`, `unknown`, `value:<effort>` keep current meaning.
- `combo:<JSON tuple>` selects sessions containing that family × effort.
- Invalid or stale combo values resolve to `all`.

Update `sessionsMatchingEffortFacet()` to query combo-aware per-session rows. As today, it returns
a session-id allowlist; downstream SQL receives those session ids and does not erase the selected
sessions' other combos.

---

## Phase 2 — Verdict capture with freshness guarantees

### Storage and writes

Migration 4 adds:

```sql
ALTER TABLE annotations
  ADD COLUMN verdict TEXT CHECK (verdict IN ('good', 'mixed', 'bad'));

CREATE TABLE annotation_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO annotation_meta(id) VALUES (1);
```

There is no existing annotation foreign-key cascade; do not claim or add one as incidental scope.

Replace the broad replacement setter with two field-preserving operations, each transactionally
bumping `annotation_meta.version`:

- `setAnnotationText(sessionId, { tags, note })` updates tags/note and preserves verdict.
- `setVerdict(sessionId, verdict)` updates verdict and preserves tags/note. `null` clears it.

Update `Annotation`, `Session.annotation`, `getAnnotations()`, collector defaults, fixtures, and
tests to carry `verdict: 'good' | 'mixed' | 'bad' | null`.

`PUT /api/sessions/:id/verdict` accepts exactly `{ verdict: 'good' | 'mixed' | 'bad' | null }`,
returns the updated annotation, and rejects every other shape with `400`. The existing annotations
route calls `setAnnotationText()` and returns the updated annotation too.

### Snapshot, ETag, and UI freshness

Verdict updates must be visible without a full ccusage recollection:

- Expose the current annotation version from the store.
- Make the cached dashboard snapshot re-overlay annotations when that version changes, or patch
  the cached session annotation through a dedicated collector function. Do not change the meaning
  of `collectedAt` just to invalidate annotations.
- Include annotation version in the dashboard ETag and combo-scoreboard ETag.
- Clear effort response memoization after a verdict write, or rely on the new versioned ETag key
  and bound the old entry through the existing LRU. Prefer the latter plus a focused endpoint test.
- Have the one-click control patch the returned annotation into visible client state immediately;
  the next conditional fetch must independently return the same value.

### UI

Add a labelled three-state control (good / mixed / bad, plus clear) to the Sessions row and session
detail. It must be keyboard reachable, announce its current value, expose pending/error state, and
cost one action from the table. Do not open the annotation modal.

Copy:

- `12 of 26 led sessions rated · 75% good`
- Fewer than five ratings: `3 of 26 led sessions rated · too few ratings for a rate`
- Zero ratings: `—` with column help saying the data is user-supplied.

---

## Phase 3 — “Model × effort by day”

Update the shared `EffortByDay` panel in `src/App.tsx`; both dashboard and project call sites use
it.

### Controls and data

- Title: **Model × effort by day**.
- Add `Model × effort` (default) / `Effort only` mode.
- Keep `Tokens` / `Observations` basis.
- Include both mode and basis in the tooltip hold `claimKey`; a pinned/held snapshot must not show
  stale rows after a mode switch.
- Combo mode calls `useEffortComboDays()` and selects six combo series globally across the visible
  range, plus `Other combos` and `Unknown`.
- Effort-only mode keeps `useEffortAggregate('day')` and `buildEffortDaySeries()`.
- Unknown is outside the six-combo budget. It represents authoritative tokens or observations
  without a complete recorded combo.

The combo series builder selects keys once for the full range, preserves day totals in `other`,
orders families as blocks, and keeps suppression per day. Add pure tests for key stability,
family-collapse, cap reconciliation, denominator-only dates, and basis switching.

### Tooltip

Combo rows use `SplitPill` and show amount, share of the drawn day, and reasoning share only when
reported. `Other combos` and `Unknown` use textual neutral rows, not fake split pills.

Effort-only rows keep their current form and add a concise model-family subline such as
`Mostly Sol, Opus 5, Luna (+2)`. Derive it from combo buckets for that day, not from the current
top-three raw-model context.

Replace redundant provider/model usage context with task context:

- Dashboard: pass already-scoped `projectActivity` and show top projects for the day.
- Project page: show top path tags among the scoped project's sessions for the day; omit the block
  if only an uninformative default is available.
- Label this block `Session context`; project/path attribution is session-level and may not align
  to every event in a multi-day transcript.

Keep `useChartTooltipHold`, `PinnableChartTooltip`, coverage copy, and pin behavior. The `sr-only`
summary mirrors the active mode's exact visible rows, including Other/Unknown and suppressed days.

Suppression copy remains day-level: `N days drew no stack because derived combo tokens exceeded
the authoritative day total.` No “cells” wording is needed.

Responsive acceptance: the two segmented controls wrap without horizontal panel overflow at the
current narrowest supported viewport.

---

## Phase 4 — “What works where”

Replace `ReasoningEffortAnalysis`'s two breakdown lists with a sortable combo scoreboard in the
Data / Intelligence view.

### 4a. Scoreboard first

- Rows: combo `SplitPill`; non-interactive kind badge where applicable.
- Columns: attributable volume, appeared sessions, led sessions, median tokens/led session,
  median cost/led session, efficiency flag rate, reasoning share, and verdict.
- Default sort: attributable tokens descending.
- Comparative cells below their sample floor say `Too few led sessions`; verdict uses its separate
  rated floor.
- Every session-level outcome header has help text: `Whole-session statistic over sessions this
  combo uniquely led; observational, not causal.`
- Show `N tied sessions excluded from outcome cohorts` in coverage copy when nonzero.

Do not add one selector that mixes project ids and path-tag strings. The Data view already has a
global path-tag control. Add a local `All projects | project` selector to the panel, combine it
with the global path-tag scope, and echo both in the panel subtitle.

### 4b. Contrast strip after the table is trusted

Add the observational contrast strip only after 4a's cohorts reconcile in live data.

- Interactive combos only.
- Each candidate project × combo cohort and the project baseline must meet the five-led-session
  floor.
- Compare median cost with a log ratio and flag rate with an absolute percentage-point delta;
  do not divide by a zero flag rate.
- Show up to three strongest positive or negative deviations and identify the metric and cohort
  sizes.
- Never say “best,” “better,” or “use.” Prefer: `In ai-usage-observatory, Luna · Max led 26
  sessions; its median session cost was 2.1× the project median, while its efficiency-rule flag
  rate was 14 percentage points lower.`

Splitting 4a and 4b keeps an interpretive feature from blocking the factual scoreboard.

---

## Phase 5 — Messaging and reuse sweep

All surfaces consume the shared combo helpers and digest; no local family/effort concatenation.

| Surface | Change |
| --- | --- |
| Dashboard `Effort mix` | Keep aggregate stack; add top combo pills underneath |
| Model signal tooltip | Replace dominant effort text with the matching combo pill where model is known |
| Sessions table | Dominant combo pill, `+N` count, combo-aware search and sort |
| Efficiency findings | Switch existing family × effort pills to shared label/colour helpers |
| Profile cards | Switch `TOP MODEL × EFFORT` to shared helpers |
| Data effort facet | Group effort-only options separately from combo options by family |
| Help copy | Say effort is meaningful only next to its recording model |
| `README.md`, `docs/ARCHITECTURE.md` | Describe combo unit, cohort attribution, verdict source, and privacy |
| `CHANGELOG.md` | Update only when preparing the release, not during an unshipped implementation branch |

The facet should remain usable as combos grow: `<optgroup>` by family, interactive combos first,
then an explicit non-interactive group. Do not list denominator-only synthetic combinations that
have never been observed.

---

## Tests required before each phase is considered complete

### Pure/domain tests

- `max` ordering and explicit effort colour.
- Raw release aliases collapse to one family combo.
- Combo key round-trip and malformed facet rejection.
- Kind classification for unknown, synthetic, automated, and interactive.
- Global top-N selection, family-block order, Other totals, Unknown outside cap.
- Reported-zero reasoning vs unsupported reasoning.
- Unique leader, token tie, observation fallback, and all-zero cases.
- Verdict rate requires five ratings independently of the led-session floor.
- Digest v2 round-trip, mixed-effort vs multi-combo flags, and search text.

### Store/API tests

- Day combo rows reconcile against the same day totals as effort-only rows.
- Denominator-only days remain as Unknown; over-attributed days suppress completely.
- Provider, family, path tag, project, exact model, date basis, effort facet, and outlier scopes
  narrow numerator and denominator consistently.
- Combo facet selects sessions but retains their other combos.
- Family aliases merge before leadership and aggregation.
- Flag rate uses all untruncated finding session ids and counts a session once.
- Non-interactive rows retain volume but have null comparisons.
- Annotation text preserves verdict; verdict preserves text/tags; clear works; invalid verdict is
  `400`.
- Annotation version changes dashboard and scoreboard ETags; the next conditional request is
  `200`, followed by `304` for the new version.
- Migration 4 upgrades a database at version 3 without losing annotations.

### UI/live checks

- Combo mode is the default in dashboard and project views.
- Tokens/observations and combo/effort-only switches update bars, `sr-only` text, and tooltip rows.
- Tooltip hover, grace, freeze, pin, drag, Escape, and keyboard behavior still work.
- Dashboard shows project context; project view shows path-tag context without repeating itself.
- Session verdict control is keyboard operable, survives annotation edits, and updates the
  scoreboard without a full refresh.
- Table sorting, facet selection, `luna max` search, empty states, and sample-floor copy.
- Narrow layout has no horizontal overflow.

Final repository checks:

```sh
bun run typecheck
bun test
bun run build
```

Reuse the healthy server on `5173`; do not restart it for hot-reloadable changes, and leave it
reachable when implementation ends.

---

## Order and independently shippable cuts

```text
Phase 0  shared vocabulary + max fixes
   ├── Phase 1a  daily combo endpoint ──> Phase 3  chart and tooltip
   ├── Phase 1b  scoreboard endpoint ──> Phase 4a table ──> Phase 4b contrasts
   ├── Phase 1c  digest/facet ──────────> Phase 5 session/facet sweep
   └── Phase 2   verdict + freshness ───> verdict column becomes active
```

**Recommended first cut: Phase 0 + 1a + 3.** It resolves the original complaint without a
migration or outcome interpretation. Ship Phase 1c before changing the Sessions column. Ship 4a
before 4b. The scoreboard may initially show a dormant verdict column, but it must already use the
separate led/rated sample-floor contracts.

---

## Risks and non-goals

- Day token coverage remains authoritative only where `dailyDenominators()` has an authoritative
  source; existing path-tag/session allocation caveats remain and must be surfaced, not hidden.
- Session-led metrics describe cohorts. They do not attribute a session's cost or success to one
  combo and do not control for task difficulty.
- Reasoning share is provider-availability-sensitive and is not comparable when one provider does
  not report it.
- Project and path tags are coarse session context, not ground-truth task labels.
- Every new model can add several combos. Cap charts, paginate or virtualize the scoreboard if
  needed, and keep the facet grouped.
- Do not infer effort, verdict, task, quality, or model recommendations.
- Do not re-index transcripts: the needed raw fields already exist.
- Do not fold unrelated annotation staleness cleanup beyond what verdict correctness requires;
  if broader annotation UX repair is desired, track it separately.
