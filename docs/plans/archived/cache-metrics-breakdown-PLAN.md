# Cache metrics breakdown — PLAN

Slug: cache-metrics-breakdown · Date: 2026-09-03
Author: Claude Fable 5.1 (medium)
Baseline: `main` @ `cd8123e`, clean working tree (v1.20.1)
Verification bar: `bun run typecheck`, `bun test`, `bun run build`, plus a read-only check
against the already-running dev server at `http://127.0.0.1:5173` (Models card, one Claude
session, one Codex session, one mixed-model project). Never restart or rebuild the user's dev
server or quota-service.

## Motive

The user wants a token-type table like the Anthropic console's:

| Token type | Exact tokens | Token share | Cost | Cost share |
| --- | --- | --- | --- | --- |
| Cache reads / Cache writes / Generated output / Uncached input | … | … | … | … |

with an honest footnote (cache-write TTL mix, thinking tokens, repeated reads), shown in three
places: the **Models** view (per model, under the global date range), **Session detail** (per
session), and **Projects** (per project, which mixes models and therefore mixes prices).

What exists today:

- Every ccusage row and per-model breakdown already carries the four token counts plus **one**
  cost per model (`server/schema.ts:3-10`, `src/types.ts:15`). There is no per-type cost, no
  cache-write TTL, and no thinking count for Claude anywhere in the pipeline.
- Models cards print cache read / write as bare numbers (`src/App.tsx:9367-9373`). Session
  detail collapses the four types into one number per model (`src/App.tsx:6144-6153`).
  Project detail shows tokens and cost per model only (`src/App.tsx:8620-8660`), although
  `server/collector.ts:71-83` keeps all four types per model per day in `project.trend`.
- The Data view already has a per-model table with hit rate, carry, and blended $/Mtok
  (`src/views/data/signals.tsx:104-168`, fed by `server/insights.ts:479-509`). Its ratio
  definitions (`cacheHitRate`, `amplification`, `contextCarry`) are the ones to reuse.
- ccusage prices every cache write at the 5-minute rate: its bundled rate card has one
  cache-write rate per model and only references `ephemeral_5m_input_tokens`. Claude transcripts
  on this machine carry `cache_creation.ephemeral_1h_input_tokens` in roughly as many usage rows
  as 5-minute writes (≈17.7k each), so cache-write cost is understated here. The effort indexer
  already reads every usage row (`server/effort-parse.ts:171-200`) but drops that split.
- Codex reports cache reads but never writes; Warp reports neither
  (`src/App.tsx:4295`, `server/effort-parse.ts:250-258`). Codex reports
  `reasoning_output_tokens`; Claude reports no thinking count.
- The "Show cache" toggle zeroes cache tokens upstream of every view
  (`src/App.tsx:2096-2098`, `2166-2192`).

## Design principles (locked unless the review overturns them)

1. **Tokens are always shown; cost is shown only when it reconciles.** Per-type cost is
   `tokens × rate` from a rate card. For each model the four computed costs must sum to
   ccusage's own `cost` within 0.5 %; otherwise the cost columns for that model read "—" with
   a reason. This is what makes the Projects table a reliable signal: cost is computed **per
   model first, then summed**, and any unpriced or unreconciled contributor withholds the
   cost columns for the whole project table (tokens stay).
2. **Provider gaps are stated, not zeroed.** Codex cache writes read "not reported"; Warp
   sessions do not render the table at all; a mixed project footnotes which providers lack
   which fields.
3. **Footnotes only claim what the data supports.** The TTL footnote comes from the effort
   index's 5m/1h split when available, and degrades to "TTL not indexed; priced at the
   5-minute rate" otherwise. The thinking-token footnote appears only for Codex rows that
   reported reasoning tokens.
4. **No new outbound dependency without a fallback.** The rate card fetches the same LiteLLM
   JSON ccusage uses, caches it in SQLite, and ships a checked-in fallback so the table works
   offline. This is the app's first app-originated network call; see Uncertainties.

## Phases

### Phase 1 — Rate card and per-type cost (server + shared pure module)

1. `server/rate-card.ts` (new):
   - `RateCard = Record<modelName, { input, output, cacheRead, cacheWrite5m, cacheWrite1h? }>`
     in USD per token.
   - `parseLiteLlmRates(json)` → RateCard. Read only
     `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`,
     `cache_creation_input_token_cost`, and (if present) the LiteLLM 1-hour cache-write field.
     Verify the exact 1-hour key name at implementation time (believed to be
     `cache_creation_input_token_cost_above_1hr`).
   - `matchRate(card, modelName)`: exact name, then provider-prefixed variants
     (`anthropic/…`, `claude-3-5-…` date suffix stripping), then `null`. Mirror ccusage's
     matching order so reconciliation succeeds for the same models ccusage prices. Unit-test
     with the model names present in `server/effort-fixtures.ts` and the Models view.
   - `loadRateCard()`: read cached card from `settings` (key `rate_card.litellm`, JSON with
     `fetchedAt`); refetch when older than 24 h; on fetch failure keep the cached card; on no
     cache use `server/rate-card-fallback.json`. Returns `{ card, status:
     "live" | "cached" | "fallback", fetchedAt }`. Never throws.
   - `scripts/refresh-rate-card.ts`: regenerates the fallback JSON (only models seen in
     ccusage's pricing table families: claude-*, gpt-*, o*, gemini-* are enough).
2. `src/token-types.ts` (new, shared by client and server like `src/model-aggregation.ts`):
   - `tokenTypeRows(breakdown, rates?, cacheWrites?)` → four rows
     `{ type, tokens, tokenShare, cost | null, costShare | null }` plus
     `{ reconciled: boolean, reconciledDelta, reason }`. Cache-write cost uses the 5m/1h
     split when supplied and the 1h rate exists; otherwise all writes at the 5m rate.
   - `sumTokenTypeRows(perModel[])` for Projects and mixed-model sessions: sums tokens always;
     sums cost only when every input is reconciled, else `cost: null` with the list of
     withheld models.
   - Tests in `src/token-types.test.ts`: shares sum to 100 %, reconciliation pass/fail,
     withheld propagation, Codex "not reported" write row, zero-traffic row.
3. Snapshot plumbing: `server/collector.ts` adds `rateCard: { status, fetchedAt, models }`
   to the dashboard snapshot (only the models present in `snapshot.models`, to keep the
   payload small; the perf memory notes payload size matters). Add a "Rate card" entry to
   `sources` with `status` healthy/degraded and detail text. Extend `DashboardData` in
   `src/types.ts`.
4. Reconciliation smoke test: `server/rate-card.test.ts` feeds the fallback card and a
   recorded ccusage daily row and asserts the computed sum matches `model.cost` within 0.5 %
   for at least one Claude and one Codex model.

### Phase 2 — Cache-write TTL split in the effort index

5. `server/effort-parse.ts` `claudeLine`: read
   `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` when the
   object is present; count the event as `cacheTtlReportedEvents: 1`. Sanity: 5m + 1h must
   equal `cache_creation_input_tokens`, otherwise treat as not reported for that event (do not
   throw; older transcripts predate the field).
6. Migration 7 in `server/migrations.ts` (PRAGMA-guarded `ALTER TABLE` like migration 4):
   `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `cache_ttl_reported_events` on
   `session_effort_usage`. Bump `PARSER_VERSION` so the index rebuilds (this reparses every
   transcript; note it in the CHANGELOG and the effort status detail).
7. `server/effort-store.ts`: extend `upsertUsage`, `comboColumns`, and the grouped aggregate
   queries with the three sums. `server/effort-api.ts`: add
   `cacheWrites: { fiveMinute, oneHour, reportedEvents } | null` to `EffortSummary` (group
   totals) and to `EffortComboBucket`. `null` when `reportedEvents === 0`.
8. Session detail endpoint (`server/index.ts:196-207`) already returns `effort` and
   `effortCombos`; the new field rides along. Models view already calls
   `useEffortAggregate("model", …)`; Projects' `EffortByDay` scope carries `project`, and a
   `useEffortAggregate("total", { …scope, project })` call gives the per-project split.
9. Tests: `server/effort-parse.test.ts` fixtures with 5m-only, 1h-only, mixed, and missing
   `cache_creation` objects; `server/effort-store` round-trip through migration 7.

### Phase 3 — Shared `TokenTypeTable` component

10. `src/components/token-types.tsx` (new): props
    `{ rows: TokenTypeRow[], summary, footnotes: string[], title?, compact? }`. Four body
    rows in the screenshot's order, right-aligned numbers, `formatCompact` with exact value
    in `title`, `sharePercent` from `src/components/effort/index.tsx:55`, `formatMoney` for
    cost. "—" for withheld cost, "not reported" for a provider-missing type. Colour swatch per
    row reuses the `Composition` palette indices (`src/App.tsx:5316-5327`) so the bar in
    Explorer and this table agree on colours.
11. `footnotesFor(inputs)` pure helper (in `src/token-types.ts`) builds the footnote lines:
    - TTL: "All indexed cache writes used the 5-minute rate" / "N % of indexed cache writes
      used the 1-hour rate; ccusage prices them at the 5-minute rate, about $X under" /
      "Cache-write TTL not indexed; priced at the 5-minute rate".
    - Reasoning: "The N reported reasoning tokens are already inside output" (Codex only).
    - Always: "Token totals count repeated reads, not unique text."
    - Provider gaps as applicable.
12. Style block in `src/styles.css` under a `.token-types` namespace; matches the existing
    `measure-table` density.

### Phase 4 — Models view

13. In the model card's expanded panel (`src/App.tsx:9396-9420`), above the effort
    distributions, render `TokenTypeTable` for `model` using
    `tokenTypeRows(model, rateCard.models[model.model], effortByModel.get(model.model)?.cacheWrites)`.
    Keep the existing `dl` as the collapsed summary. Skip for Warp-only models.
14. Add "Cache read" and "Cache write" to the `ModelOrder` sort menu (`src/App.tsx:9039`)
    since the four values are now first-class.

### Phase 5 — Session detail

15. In `SessionDetailPanel`, add a "TOKEN TYPES" block in the summary column after the
    patch summary (`src/App.tsx:6215-6300` region). For a single-model session pass its
    breakdown; for a mixed session render the summed table plus a per-model disclosure
    (reuse `tooltip-disclosure`) listing each model's four rows. Cache-write split comes
    from `detail.effortCombos` summed over the session. Warp sessions skip the block.
16. Keep the sessions list "carry" chip (`src/App.tsx:7562`) unchanged; it is a different
    signal.

### Phase 6 — Projects

17. In `ProjectDetails` "MODEL MIX" section (`src/App.tsx:8576`), render the summed table
    above the per-model list, built from the in-range `project.trend[].modelBreakdowns`
    (the same rows `projectSummaryInRange` already narrows, `src/App.tsx:7788-7826`).
    Sum via `sumTokenTypeRows`; when cost is withheld, the cost columns read "—" and a
    footnote names the withheld models.
18. Each per-model row in the list gains a compact four-type strip (tokens + share only) so
    the mixed-model reader can see which model drives the cache reads.
19. Project rows in the Projects list (`src/App.tsx:8965-8978`) are unchanged; the table lives
    on the detail page only.

### Phase 7 — Cache toggle and edge states

20. When `showCache` is off, every `TokenTypeTable` mount is replaced by one line: "Token
    types are hidden while cache tokens are excluded." Decide the gate in the three parents,
    not in the component.
21. Unpriced models (`model.priced === false`) render tokens only with the existing "no rate
    card in ccusage" wording.

### Phase 8 — Docs, changelog, verification

22. `docs/ARCHITECTURE.md`: add the rate card to Collection flow and Local storage; correct
    the "offline mode" sentence, which no longer matches `server/ccusage.ts:49-56`.
23. `CHANGELOG.md` unreleased entry; note the effort index rebuild.
24. Run `bun run typecheck`, `bun test`, `bun run build`. Then, without restarting anything,
    open `http://127.0.0.1:5173` (check the port is served first) and verify: a Claude model
    card reconciles; a Codex model card shows "not reported" writes; a mixed-model project
    sums cost only when all contributors reconcile; the cache toggle hides the tables.

## Dependencies and order

Phase 1 and Phase 2 are independent. Phase 3 depends on Phase 1's types. Phases 4–6 depend on
Phase 3 and consume Phase 2 when present. Phase 7 touches the same parents as 4–6 and should
land with them. Phase 8 last.

## Uncertainties (real ones)

1. **Outbound fetch policy.** The server makes no HTTP calls today; ccusage does. Adding an
   app-originated fetch to LiteLLM is a policy change. Fallback JSON keeps it optional, and a
   `RATE_CARD_OFFLINE=1` env or settings key can disable the fetch entirely.
2. **LiteLLM 1-hour field name and coverage.** If LiteLLM lacks a 1-hour rate for the
   relevant models, use the Anthropic published ratio (1-hour write = 2 × base input, 5-minute
   = 1.25 ×) only for `claude-*` models and say so in the footnote.
3. **Tiered pricing.** ccusage's card has above-200k tiers for a few models (keys `ia`, `oa`,
   `cra`, `cca`). Days that crossed the tier will fail reconciliation; the table then withholds
   cost for that model. Acceptable; measure how often it happens on the dev data before
   tightening or loosening the 0.5 % threshold.
4. **Effort index disabled.** The TTL split needs the optional effort index. When disabled the
   footnote degrades; nothing else breaks.
5. **Codex uncached input semantics.** ccusage's Codex `inputTokens` is believed to be net of
   cached tokens (the effort parser subtracts them "to align with ccusage",
   `server/effort-parse.ts:263`). Confirm on one row before trusting Codex reconciliation.

## Stopping conditions

- If more than 10 % of Claude model-days on the dev data fail reconciliation with the
  fallback card, stop after Phase 1 and diagnose rate matching before building UI on it.
- If the effort index rebuild triggered by the parser version bump takes longer than the
  current full index (check `effort status` detail), keep the migration but gate the parser
  bump behind a second look.
- Do not touch the running dev server, quota-service, or the live SQLite file; use a copy for
  any migration dry run.
