# Cache metrics breakdown — FINAL

Slug: cache-metrics-breakdown · Date: 2026-09-03
Author: Claude Fable 5.1 (medium)
Based on: cache-metrics-breakdown-REVISED.md (Sol 5.6 high via Codex CLI) over cache-metrics-breakdown-PLAN.md
Execution state: executed 2026-09-03 (all phases; bun run typecheck, bun test 465 pass, bun run build, read-only live check of Models, Sessions, Projects, and the cache toggle on the running dev server)
Baseline: `main` @ `cd8123e` (v1.20.1); only the three plan files are untracked
Verification bar: `bun run typecheck`, `bun test`, `bun run build`, then a read-only check of the
already-running app at `http://127.0.0.1:5173` (or `4318`). Never restart, rebuild, or reconfigure
the user's dev server or quota-service; never open, copy, or migrate the live SQLite database.

## Changes from REVISED

- **Cost source decided by the user: app-side split, validated.** The reviewer's Phase 0 (change
  the Rust ccusage CLI, wait for a release, re-pin) is dropped. Per-type cost is derived from
  ccusage's own per-model cost using LiteLLM rates for the three non-write types and taking cache
  write as the residual; every model-row is validated against ccusage before any cost is shown.
  ccusage stays the cost authority: no number is ever shown that does not sum to its `cost`.
- **Empirical basis added.** A read-only dry run on 2026-09-03 against the running app's daily
  rows, Warp excluded: every Codex model reconciles to within rounding at LiteLLM rates
  (250 of 255 model-days within 0.5 %). Every Claude model's ccusage cost lands between the
  all-5-minute and all-1-hour cache-write bounds, with implied 1-hour shares of 38–100 %,
  which matches the ≈50/50 5m/1h mix seen in the transcripts. The residual method is therefore a
  measured fit, not a guess.
- **Reviewer correction accepted:** ccusage 20.0.17 already reads
  `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` and prices 1-hour
  writes at 2× base input. The draft's "priced at the 5-minute rate" claim is withdrawn.
- **TTL split decided by the user: derive, do not index.** No migration, no `PARSER_VERSION`
  bump, no re-index. The 1-hour share is implied per model-row from the residual.
- **Reviewer's reasoning-token exposure accepted** (already stored; API plumbing only).
- **Reviewer's "normalized zero" caveat replaced by a fact:** all 34,061 Codex usage rows on
  this machine carry an explicit `cache_write_input_tokens: 0`, so the footnote states that Codex
  reports cache writes as zero.
- **Accepted from REVISED:** exact tokens as locale-formatted integers; explicit `showCache`
  prop plumbing; Projects built from the range-filtered sessions already passed to
  `ProjectDetails`; Warp tokens excluded with coverage disclosed; no cache sort options; no
  session-level per-model disclosure; ARCHITECTURE/README corrections.
- **Scope decided by the user:** keep one per-model disclosure in Projects (collapsed list of the
  four token rows per model) so a mixed-model project shows which model drives cache reads.
- **README wording:** "cost comes exclusively from ccusage" stays true for totals; the per-type
  split is documented as a validated decomposition of that same ccusage figure.

## Motive

Add this table to the Models view, Session detail, and Projects view:

| Token type | Exact tokens | Token share | Cost | Cost share |
| --- | ---: | ---: | ---: | ---: |
| Cache reads | … | … | … | … |
| Cache writes | … | … | … | … |
| Generated output | … | … | … | … |
| Uncached input | … | … | … | … |

with a footnote that states only what the data supports (cache-write TTL mix, reasoning tokens,
repeated reads, provider gaps, excluded Warp tokens).

Existing state: each ccusage model breakdown carries the four token counts and one cost
(`server/schema.ts:3-10`, `src/types.ts:15`). Models cards print cache counts
(`src/App.tsx:9357-9394`); Session detail collapses types to one total per model
(`src/App.tsx:6144-6153`); Project detail shows tokens and cost per model only
(`src/App.tsx:8579-8655`) although `server/collector.ts:71-83` keeps all four types per model per
day. The Data view's per-model table (`src/views/data/signals.tsx:104-168`, `server/insights.ts:479-509`)
defines `cacheHitRate`, `contextCarry`, and `amplification`; reuse those definitions. ccusage is
invoked without `--offline` (`server/ccusage.ts:49-56`) and fetches LiteLLM pricing live.

## Design principles (locked)

1. **ccusage is the cost authority; the app only decomposes.** For each model-row (a model
   inside one ccusage daily-agent row or one session row):
   `costIn = input × rate.input`, `costOut = output × rate.output`,
   `costRead = cacheRead × rate.cacheRead`, `costWrite = model.cost − costIn − costOut − costRead`.
2. **Validation gates every cost cell.** A model-row is *reconciled* when:
   - the model has a rate card entry and is not in `unpricedModels`; and
   - if the entry has no 1-hour rate: `|costWrite − cacheWrite × rate.cacheWrite5m| ≤ 0.5 % × cost`
     (Codex and other non-Anthropic models: exact match); or
   - if it has a 1-hour rate: `cacheWrite × rate.cacheWrite5m − tol ≤ costWrite ≤ cacheWrite × rate.cacheWrite1h + tol`
     with `tol = 0.5 % × cost`; and
   - when `cacheWrite = 0`, `|costWrite| ≤ tol`.
   Unreconciled rows keep their tokens and withhold cost; withholding propagates to the
   containing model card, session, or project table, which names the failing models.
3. **Mixed-model cost is summed by component, never by blended rate.** Projects and mixed
   sessions sum reconciled per-model components. One unreconciled contributor withholds the
   whole table's cost columns.
4. **Implied 1-hour share** for an Anthropic model-row with `cacheWrite > 0`:
   `(costWrite − cacheWrite × rate5m) / (cacheWrite × (rate1h − rate5m))`, clamped to [0, 1] after
   validation. Aggregate as a token-weighted share across rows.
5. **Warp is excluded, not classified.** Warp tokens are generic (`server/collector.ts:139-175`).
   Tables exclude them and print "N Warp tokens excluded (no token-type detail)"; a Warp-only
   scope shows that line instead of a table.
6. **Shares have explicit denominators.** Token share over the four displayed rows; cost share
   over the four reconciled components.
7. **Footnotes describe evidence.** Nothing inferred from missing fields.
8. **Cache-hidden state is explicit.** With `showCache` off, each mount shows one line instead of
   a table computed from zeroed rows.
9. **No new outbound dependency without a fallback and an off switch.**

## Phases

### Phase 1 — Rate card and validated decomposition

1. `server/rate-card.ts` (new):
   - `RateCard = Record<string, { input; output; cacheRead; cacheWrite5m; cacheWrite1h: number | null }>`
     in USD per token.
   - `parseLiteLlmRates(json)`: read `input_cost_per_token`, `output_cost_per_token`,
     `cache_read_input_token_cost`, `cache_creation_input_token_cost`, and
     `cache_creation_input_token_cost_above_1hr` (verified present on 2026-09-03 for
     claude-opus-5, claude-sonnet-5, claude-fable-5-1, claude-opus-4-1; absent for gpt-*).
     Keep only entries whose key matches `/^(anthropic\/)?claude-|^gpt-|^o[1-9]|^gemini-/`.
   - `matchRate(card, modelName)`: exact key; then `anthropic/<name>`; then strip a trailing
     `-YYYYMMDD` date; then `null`. Unit-test with every model name in `_temp`-free fixtures
     (use names from `server/effort-fixtures.ts` and `server/pricing-coverage.test.ts`).
   - `loadRateCard()`: read `settings` key `rate_card.litellm` (`{ fetchedAt, card }`); refetch
     from `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
     when older than 24 h and `USAGE_OBSERVATORY_OFFLINE_PRICING` is unset; on failure keep the
     cached card; with no cache use `server/rate-card-fallback.json`. Returns
     `{ card, status: "live" | "cached" | "fallback", fetchedAt }`; never throws; 10 s timeout;
     never blocks a collection tick (kick off, use last known).
   - `scripts/refresh-rate-card.ts`: regenerates the fallback JSON from LiteLLM with the same
     filter. Commit the generated file.
2. `src/token-types.ts` (new, shared pure module like `src/model-aggregation.ts`):
   - `decomposeModelRow(breakdown, rate, unpriced) → { rows: TokenTypeRow[4], reconciled, reason, impliedOneHourShare }`.
   - `summarizeTokenTypes(modelRows: Array<{ agent; breakdown }>, card, unpricedModels) →
     { rows, costAvailable, withheldModels, warpTokensExcluded, impliedOneHourShare, providers }`.
     Skips Warp agents (`providerKey(agent) === "warp"`), sums tokens always, sums cost only when
     every non-Warp contributor reconciled.
   - `footnotesFor(summary, reasoning?)` returns the footnote strings (Phase 3 lists them).
   - `src/token-types.test.ts`: exact totals; shares sum to 100 %; Codex exact match pass/fail;
     Claude within-bounds pass and out-of-bounds fail; zero-write row; unpriced model withholds;
     mixed-project propagation names the failing model; Warp exclusion and coverage; implied
     1-hour share clamps; zero-traffic scope.
3. Snapshot plumbing in `server/collector.ts`: add `rateCard: { status, fetchedAt, models }` to
   the dashboard snapshot, restricted to models present in `snapshot.models` (payload size
   matters; see the perf notes). Add a `sources` entry "Pricing rate card" (healthy for live or
   cached under 7 days, degraded for fallback or stale). Extend `DashboardData` in `src/types.ts`.
4. Reconciliation fixture test, `server/rate-card.test.ts`: a checked-in fixture of ~10 real
   daily-agent rows (Codex and Claude, Warp excluded, numbers copied from a one-off read of
   `/api/usage`) plus the fallback card; assert Codex rows reconcile exactly and Claude rows fall
   inside the bounds. This is the guard for the stopping condition below.

### Phase 2 — Expose stored reasoning evidence (no migration)

5. `server/effort-store.ts`: extend `EffortGroupedRow` (`:52`) and the grouped and session
   queries (`:312-378`) with summed `output_tokens`, `reasoning_output_tokens`,
   `reasoning_reported_events`. No schema change: the columns exist (`server/migrations.ts:92-107`)
   and are populated by `server/effort-parse.ts:254-297`.
6. `server/effort-api.ts`: add optional
   `reasoning: { outputTokens, reasoningOutputTokens, reportedEvents } | null` to `EffortSummary`
   in `foldGroupedRows` (`:282`) and `buildSessionEffortSummary` (`:799`). Leave combos alone.
7. `src/project-grouping.ts` `mergeEffortSummaries` (`:144`): sum the new fields.
8. Tests in `server/effort-api.test.ts` and `src/project-grouping.test.ts`: unavailable,
   reported-zero, positive, session scope, model scope, merged project scope.

### Phase 3 — Shared `TokenTypeTable` component

9. `src/components/token-types.tsx` (new): props `{ summary, reasoning?, heading? }`. Semantic
   `<table>` with the four rows in the screenshot's order. Cells:
   - exact tokens: `tokens.toLocaleString()` (never compact);
   - share: one decimal, `<0.1%` for nonzero tiny values, `—` for zero traffic;
   - cost: `formatMoney` above one cent, otherwise up to six decimals;
   - withheld cost: `—` with `aria-label` text naming the reason;
   - row swatch colours match the Explorer composition mapping (`src/App.tsx:5310-5327`).
10. Footnote lines from `footnotesFor`:
    - "Cache-write cost is the ccusage residual after input, output, and cache-read rates;
      about N % of write tokens were priced at the 1-hour rate." (Anthropic rows with writes)
    - "Codex reports cache writes as zero." (any Codex contributor)
    - "Generated output includes reasoning tokens." plus, when Phase 2 evidence exists,
      "Codex reported N reasoning tokens inside output." When the effort index is off:
      "No separate reasoning count is available for this scope."
    - "Cache reads count repeated reads, not unique text."
    - "Cost withheld: <models> did not reconcile with ccusage." (when applicable)
    - "N Warp tokens excluded (no token-type detail)." (when applicable)
    - Rate card provenance: "Rates: LiteLLM, fetched <date>" or "Rates: bundled fallback".
11. `.token-types` styles in `src/styles.css`, reusing `.measure-table` density (`:511`) and its
    horizontal overflow wrapper. Check narrow widths and screen-reader order.

### Phase 4 — Integrate the three views

12. **Models** (`src/App.tsx:9026`): build the input by iterating the selected `daily` rows and
    their `agents` branches for the card's raw model name (not `aggregateModels`, which merges
    Warp and ccusage observations of the same name, `src/model-aggregation.ts:14-45`). Render the
    table inside the expanded panel before the effort distributions (`src/App.tsx:9408-9420`).
    Collapsed card unchanged. Reasoning evidence from `effortByModel.get(model.model)`.
13. **Session detail** (`SessionDetailPanel`, `src/App.tsx:6022`): one aggregate table from
    `session.modelBreakdowns` (each carries its own ccusage cost), placed after the summary grid
    and before the quota-context panel (`src/App.tsx:6242`). Reasoning from `detail.effort`.
    Warp sessions show the exclusion line only.
14. **Projects** (`ProjectDetails`, `src/App.tsx:8228`): one aggregate table at the top of the
    "MODEL MIX" section (`src/App.tsx:8579`) built from the range-filtered `sessions` prop
    (`src/App.tsx:8992-9007`, all grouped `memberIds`). Below it, a collapsed "By model"
    disclosure (reuse `src/components/tooltip-disclosure.tsx` or the existing details pattern)
    listing each model's four token rows with its own reconciled cost or `—`. Reasoning from the
    existing project effort scope. Project list rows unchanged. No new API request.

### Phase 5 — Cache toggle and edge states

15. Pass `showCache` explicitly from `App` (`src/App.tsx:11256`) into `Sessions` →
    `SessionDetailPanel` (`:7022`, `:7644-7651`, `:11808-11817`), `Projects` → `ProjectDetails`
    (`:8770`, `:8992-9007`, `:11818-11827`), and `Models` (`:9026`, `:11829-11836`).
16. When false, every mount renders "Token types are hidden while cache tokens are excluded."
    Never compute from the zeroed view model.
17. Unpriced models (`priced === false` or in `unpricedModels`): tokens shown, cost `—`, existing
    "no rate card in ccusage" wording.
18. Zero-token scope: zero counts, `—` shares, no percentages.

### Phase 6 — Docs and changelog

19. `docs/ARCHITECTURE.md:9`: ccusage runs without `--offline` and fetches pricing; document the
    rate card (LiteLLM, 24 h cache in `settings`, bundled fallback, off switch) and the
    decomposition-with-validation rule in Collection flow and Local storage.
20. `README.md:296-299`: totals still come exclusively from ccusage; per-type costs are a
    validated decomposition of that figure and are withheld when they do not reconcile.
21. `CHANGELOG.md` unreleased entry. No effort-index rebuild to announce.

### Phase 7 — Verification

22. `bun run typecheck`, `bun test`, `bun run build`.
23. Check whether `5173` or `4318` responds; reuse it read-only. Verify:
    - a Claude model card reconciles and shows an implied 1-hour share;
    - a Codex model card reconciles exactly and says writes are reported as zero;
    - a session's four costs sum to its ccusage cost;
    - a mixed-price project sums components and withholds cost when one contributor fails;
    - a Warp-only scope shows the exclusion line;
    - "Show cache" off replaces all three tables with the hidden-state line;
    - narrow layout keeps exact integers unclipped.

## Dependencies and order

Phase 1 and Phase 2 are independent. Phase 3 depends on Phase 1 types. Phases 4 and 5 depend on
Phase 3 and land together per view. Phase 6 and 7 last.

## Uncertainties

1. **Rate drift between ccusage's pricing snapshot and the app's fetch.** ccusage fetches LiteLLM
   at each run and may cache; the app fetches daily. A drift day fails validation and is withheld
   rather than mispriced. Measure how often this happens on the fixture and on the live dev data
   before tightening the 0.5 % tolerance.
2. **Long-context tiers.** LiteLLM carries above-200k tiers for some models; ccusage applies them
   per request. A day that crossed a tier fails validation and is withheld. Acceptable.
3. **Model-name variants.** ccusage may see names such as `claude-sonnet-5[1m]`; confirm on the
   fixture whether ccusage's matching maps them and mirror it in `matchRate`.
4. **Effort index disabled.** Reasoning footnote degrades; nothing else depends on it.
5. **Outbound fetch.** First app-originated request; the env switch and fallback file make it
   optional, and the source-health entry makes its state visible.

## Stopping conditions

- If the Phase 1 fixture test shows any Codex row outside 0.5 % or any Claude row outside the
  bounds, stop and diagnose rate matching before building UI on it.
- If rate-card fetch failures would ever block or slow a collection tick, restructure to
  background refresh before shipping.
- Do not touch the running dev server, quota-service, or the live SQLite file.

## Execution recommendation

- **Phase 1** (pricing semantics, validation rule, fixture): Fable 5.1 high, or Sol 5.6 high
  if the executor is on the OpenAI side. This phase carries the correctness risk.
- **Phase 2**: Sonnet high (bounded SQL and API plumbing with existing tests as the template).
- **Phases 3–5**: Sonnet high. Bounded UI work, but `src/App.tsx` is ~11.9k lines; Phase 4 is the
  phase most likely to run long because of three separate integration points and prop plumbing.
- **Phases 6–7**: Sonnet medium.
- Safe handoff points: after Phase 1 tests pass (tokens-only table is already viable); after the
  component renders in isolation; after each view integration; before final cross-view checks.
