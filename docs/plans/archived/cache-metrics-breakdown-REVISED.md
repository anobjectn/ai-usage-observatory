# Cache metrics breakdown — REVISED

Slug: cache-metrics-breakdown · Date: 2026-09-03
Reviewer: Sol 5.6 (high) via Codex CLI `codex exec` (read-only sandbox, `-m gpt-5.6-sol -c model_reasoning_effort=high`)
Based on: cache-metrics-breakdown-PLAN.md
Note: the reviewer's text below is verbatim; it repeats its own heading and header lines.

---

# Cache metrics breakdown — REVISED

## Review notes

- The baseline commit is `cd8123e`, but the worktree is not clean because this plan is untracked.
- Pinned `ccusage@20.0.17` already parses 5-minute and 1-hour cache-write tokens and prices 1-hour writes at 2× input; the draft's underpricing claim is stale after [ccusage PR #1221](https://github.com/ccusage/ccusage/pull/1221).
- Current ccusage JSON exposes four token counts and one aggregate model cost only (`server/schema.ts:3-10`); the app cannot reliably decompose that cost.
- Fetching LiteLLM again would not reproduce ccusage's fetched snapshot, embedded fallback, custom overrides, long-context tiers, or Codex speed tier, so reconciliation after the fact is not a sound cost source.
- A second rate-card fetch would also introduce a new app-originated internet request for no necessary benefit.
- The optional effort index already stores Codex reasoning output (`server/effort-parse.ts:21-27`, `254-297`); no migration, parser-version bump, or reindex is needed.
- The effort aggregate and session-detail APIs currently discard those stored reasoning fields (`server/effort-store.ts:330-378`, `server/effort-api.ts:282-289`, `818-829`).
- A normalized zero cache-write count does not prove that a provider explicitly reported zero, so Codex rows must not say "not reported" without availability metadata.
- "Exact tokens" requires visible locale-formatted integers, not `formatCompact` plus a tooltip.
- The cache toggle removes cache counts before Models, Projects, and Sessions receive data (`src/App.tsx:2166-2192`), but those views do not receive `showCache`; explicit prop plumbing is required.
- Projects already receive range-filtered sessions and an in-range merged trend (`src/App.tsx:7800-7827`, `8800-8813`, `8992-9007`); another project effort request is unnecessary.
- Cache sorts, per-model disclosure tables, and compact strips are extra scope and should be omitted.

Slug: cache-metrics-breakdown · Date: 2026-09-03  
Author: independent review  
Baseline: `main` @ `cd8123e`; plan file untracked  
Verification bar: dependency-contract tests, `bun run typecheck`, `bun test`, `bun run build`, then read-only inspection of the already-running app at `http://127.0.0.1:5173`. Never restart the user's server or quota-service, and never open or migrate the live SQLite database for verification.

## Motive

Add this four-row table to the Models view, Session detail, and Projects view:

| Token type | Exact tokens | Token share | Cost | Cost share |
| --- | ---: | ---: | ---: | ---: |
| Cache reads | … | … | … | … |
| Cache writes | … | … | … | … |
| Generated output | … | … | … | … |
| Uncached input | … | … | … | … |

The existing normalized model record has the required token counts but only one aggregate cost (`server/schema.ts:3-10`, `src/types.ts:1-16`). Models already show cache counts (`src/App.tsx:9357-9394`), Session detail reduces each model to one token total (`src/App.tsx:6144-6153`), and Projects retain per-type model counts in their daily trend (`server/collector.ts:55-100`).

Cost must remain exclusively ccusage-derived, as documented in `README.md:285-299`. Projects may sum component costs across differently priced models only when ccusage supplies those components from the same pricing calculation that produced each model's aggregate cost.

## Design principles

1. **ccusage remains the cost authority.** Do not add a LiteLLM client, fallback rate card, SQLite rate cache, inferred model matching, or Anthropic-only price formulas.
2. **Per-type cost needs an upstream contract.** Extend ccusage JSON to emit the component costs it already calculates. Until the pinned dependency provides that contract, render all four token rows and withhold cost cells with "Breakdown unavailable from ccusage."
3. **Validate rather than reprice.** For every contributing model, component costs must be finite, nonnegative, and sum to its existing `cost` within floating-point tolerance. One missing or invalid contributor withholds every cost cell for the containing model, session, or project.
4. **Mixed-model cost is summed by component.** Never apply a blended rate to aggregate project tokens.
5. **Shares have explicit denominators.** Token share uses the sum of the four displayed token rows. Cost share uses the sum of the four validated component costs.
6. **Warp is not silently classified.** Warp records generic tokens and credits, not these four API token types (`server/collector.ts:139-175`). Exclude Warp tokens from the table, show classified-token coverage, and omit the table when a scope contains only Warp.
7. **Footnotes describe evidence.** State TTL coverage, reasoning-token availability, repeated cache reads, normalized-zero ambiguity, and excluded Warp tokens without inferring missing fields.
8. **Cache-hidden state is explicit.** When `showCache` is false, replace the table with a short message rather than displaying zero cache rows beside unchanged historical cost.

## Phases

### Phase 0 — Add the required ccusage JSON contract

1. Extend ccusage's per-model JSON breakdown in all unified sections and nested agent rows with an optional structure such as:

   ```ts
   {
     costBreakdown: {
       uncachedInput: number;
       cacheRead: number;
       cacheWrite: number;
       generatedOutput: number;
       basis: "calculated";
     } | null;
     cacheWriteTtl: {
       fiveMinuteTokens: number;
       oneHourTokens: number;
       fallbackTokens: number;
     };
   }
   ```

2. Populate `costBreakdown` inside the same ccusage calculation that produces `model.cost`. Do not reconstruct it after aggregation. Emit `null` when ccusage uses a provider-reported total that it cannot decompose or when the model is unpriced.
3. Carry the existing 5-minute, 1-hour, and legacy fallback counts through per-model daily, weekly, monthly, and session aggregation. Require their sum to equal `cacheCreationTokens`.
4. Cover Claude 5-minute-only, 1-hour-only, mixed-TTL, and missing-TTL records; long-context tiers; Codex cached input; Codex standard and fast service tiers; custom pricing overrides; and unpriced models.
5. Publish and pin the first ccusage release containing this contract in `package.json:17-23` and `bun.lock`. Confirm the exact JSON shape with a captured fixture before changing the app schema.
6. If an upstream change or dependency pin is not acceptable, stop here for cost work. The safe fallback is a token-composition table whose cost columns are always withheld.

### Phase 1 — Normalize and validate token-type data

7. Extend `modelBreakdownSchema` in `server/schema.ts:3-10` and `ModelBreakdown` in `src/types.ts:15` with optional `costBreakdown` and `cacheWriteTtl` fields. Optional fields preserve a clear degraded state for old or incomplete ccusage output.
8. Add `src/token-types.ts` with pure helpers that:

   - Convert one or more provider-tagged model breakdowns into the four ordered rows.
   - Exclude Warp contributions while counting their tokens as unclassified coverage.
   - Sum exact tokens directly.
   - Accept component costs only when every non-Warp, token-contributing model has a calculated breakdown and is not listed in `unpricedModels`.
   - Reconcile each component sum to that model's existing `cost`.
   - Withhold the containing table's costs and return the failing model names when any contributor is incomplete or mismatched.
   - Aggregate TTL counts and reject impossible totals.
   - Compute token and cost shares without rounding the underlying values.

9. Build inputs from authoritative rows already available to each view:

   - Models: iterate the selected `daily` rows and their `agents` branches, matching the raw model name. This avoids confusing Warp and ccusage observations that share a model name (`src/model-aggregation.ts:14-45`).
   - Session detail: use `session.modelBreakdowns`.
   - Projects: use the range-filtered project `sessions` already passed to `ProjectDetails` (`src/App.tsx:8992-9007`), including every grouped `memberId`.

10. Add `src/token-types.test.ts` for exact totals, zero traffic, mixed models, Warp exclusion, unpriced models, missing components, reconciliation failure, TTL inconsistency, and cost-withholding propagation.
11. Add schema fixtures in `server/schema.test.ts` for the new ccusage shape and for legacy output without it.

### Phase 2 — Expose existing reasoning-token evidence

12. Do not change `server/migrations.ts`, `PARSER_VERSION`, or the stored usage schema. Reasoning output and reporting-event counts already exist in `session_effort_usage` (`server/migrations.ts:92-107`) and are populated by the parser (`server/effort-parse.ts:254-297`).
13. Extend `EffortGroupedRow` and the grouped/session queries in `server/effort-store.ts:52`, `330-378` to return summed `output_tokens`, `reasoning_output_tokens`, and `reasoning_reported_events`.
14. Add an optional reasoning summary to `EffortSummary` and populate it in `foldGroupedRows` and `buildSessionEffortSummary` (`server/effort-api.ts:282-289`, `799-812`). Do not alter `EffortComboBucket` or `SessionEffortCombo`; the table needs a scope total, not another model-by-effort breakdown.
15. Update `mergeEffortSummaries` in `src/project-grouping.ts:141-180` so grouped project members sum the reasoning fields.
16. Test unavailable reporting, reported zero, positive reasoning, session scope, model scope, and merged project scope in `server/effort-api.test.ts` and `src/project-grouping.test.ts`.

### Phase 3 — Build the shared table

17. Add `src/components/token-types.tsx` with props for the computed summary, reasoning evidence, and optional heading.
18. Render semantic table headers and the four rows in the requested order. Use:

   - `tokens.toLocaleString()` for visible exact token counts.
   - A dedicated share formatter with one decimal and `<0.1%` for nonzero tiny shares.
   - A dedicated cost formatter that retains useful precision below one cent, up to six decimal places.
   - `—` plus accessible explanatory text when costs are withheld.
   - Stable token-type colors matching the existing composition mapping in `src/App.tsx:5310-5327`.

19. Generate these footnotes from pure helpers:

   - "Cache-write cost uses the ccusage-recorded 5-minute and 1-hour TTL split." Include token counts or percentages when present.
   - If fallback tokens exist: "N cache-write tokens lacked TTL detail and use ccusage's fallback pricing."
   - "Generated output includes reasoning/thinking tokens."
   - When indexed Codex evidence exists: "Codex reported N reasoning tokens inside generated output."
   - When reasoning evidence is unavailable: "A separate reasoning-token count is unavailable; Claude does not expose one through this pipeline."
   - "Cache reads count repeated reads, not unique text."
   - "A zero cache-write value is ccusage-normalized and does not prove the source emitted an explicit zero."
   - State excluded Warp tokens and classified-token coverage when applicable.

20. Add `.token-types` styles in `src/styles.css`, reusing the density and horizontal-overflow behavior of `.measure-table` (`src/styles.css:508-511`). Test narrow layouts and keyboard/screen-reader output.

### Phase 4 — Integrate the three views

21. Models: render the table inside the expanded panel before the effort distributions at `src/App.tsx:9408-9420`. Keep the collapsed model summary unchanged.
22. Session detail: render a standalone token-types section after the summary grid and before quota context at `src/App.tsx:6200-6243`. A mixed-model session gets one aggregate table; no nested per-model disclosure is required.
23. Projects: render one aggregate table at the top of the "MODEL MIX" section at `src/App.tsx:8579-8655`. Use the passed range-filtered sessions, not a blended project rate and not a new API request.
24. Do not add cache sort options, per-model token strips, or changes to the Projects list rows.

### Phase 5 — Cache toggle and edge states

25. Pass `showCache` explicitly from `App` through:

   - `Sessions` and `SessionDetailPanel` (`src/App.tsx:7022-7032`, `7644-7651`, `11808-11817`).
   - `Projects` and `ProjectDetails` (`src/App.tsx:8770-8786`, `8992-9007`, `11818-11827`).
   - `Models` (`src/App.tsx:9026-9038`, `11829-11836`).

26. When false, render "Token types are hidden while cache tokens are excluded." Do not calculate a table from the zeroed view model.
27. Warp-only scopes render "Token-type accounting is unavailable for Warp's generic recorded tokens." Mixed scopes render the classified ccusage portion and disclose the excluded Warp count.
28. A model with token counts but no component cost remains visible with exact tokens and withheld cost. Name the affected models in session and project footnotes.
29. A zero-token scope shows zero exact counts, `—` shares, and no misleading percentages.

### Phase 6 — Documentation and changelog

30. Correct `docs/ARCHITECTURE.md:9`: `server/ccusage.ts:49-55` currently invokes ccusage without `--offline`, so ccusage may fetch pricing and fall back to its embedded catalog.
31. Document the new ccusage-provided component-cost and TTL contract in the collection flow. State that the app performs no separate pricing fetch and stores no rate card.
32. Update `README.md:296-299` to say per-type costs come from the same ccusage calculation as aggregate cost and are withheld when that breakdown is unavailable.
33. Add a `CHANGELOG.md` entry. Do not claim an effort-index rebuild because none is required.

### Phase 7 — Verification

34. Run the dependency-contract fixtures, `bun run typecheck`, `bun test`, and `bun run build`. The test preload already redirects SQLite access to a temporary database (`bunfig.toml:1-5`, `server/test-setup.ts:5-12`).
35. Check whether ports `5173` or `4318` already respond. Reuse the running instance and do not restart, rebuild, or reconfigure it.
36. Verify without changing settings or live SQLite state:

   - A Claude model shows exact tokens, reconciled component costs, and TTL footnotes.
   - A Codex model shows exact normalized input/cache/output counts and a reasoning footnote when indexed.
   - A session's component costs sum to its existing ccusage cost.
   - A mixed-price project sums per-model components and never uses a blended rate.
   - One missing or unpriced project contributor withholds all project cost cells.
   - Warp-only and mixed-Warp scopes disclose classification coverage.
   - Turning off "Show cache" replaces all three tables with the hidden-state message.
   - Narrow layouts remain readable without clipping exact integers.

## Dependencies and order

Phase 0 is a hard dependency for trustworthy cost columns. Phase 1 can support legacy output immediately and therefore enables a tokens-only table while waiting for the dependency release. Phase 2 is independent and can run alongside Phase 1. Phase 3 depends on Phase 1. Phases 4 and 5 depend on Phase 3. Documentation and verification come last.

## Uncertainties

1. **Upstream dependency change.** The outcome changes materially if modifying and repinning ccusage is out of scope. Without that change, costs must remain withheld.
2. **Reported versus calculated cost.** The ccusage contract must identify whether component costs decompose the exact aggregate `cost`; a separately calculated estimate is insufficient.
3. **Warp coverage.** The recommended behavior excludes generic Warp tokens and reports coverage. Treating them as uncached input would be simpler but false.
4. **Normalized zeros.** Current JSON cannot distinguish an explicitly reported zero from an omitted provider field. The UI must retain the caveat unless ccusage adds availability metadata.
5. **Reasoning coverage.** The optional effort index can report observed Codex reasoning tokens, but absence of that evidence is not proof of zero reasoning.
6. **Dependency publication time.** An upstream release may dominate elapsed time even if the code change is small.

## Stopping conditions

- Stop cost implementation if ccusage cannot emit component costs from the same calculation and cost source as `model.cost`.
- Stop and diagnose if any ccusage contract fixture fails component-to-total reconciliation; do not loosen the tolerance to hide a semantic mismatch.
- Stop project cost rendering if one contributing model lacks a valid component breakdown.
- Do not add a second pricing engine as a workaround.
- Do not migrate, copy, or mutate the live SQLite database.
- Do not restart the user's dev server or quota-service.

## Execution recommendation

Use `gpt-5.6-sol` at xhigh effort for Phase 0 because it crosses the Rust ccusage pricing contract, JSON aggregation, provider-specific pricing modes, and dependency release. Use `gpt-5.6-sol` at high effort for Phases 1-5, then medium effort for documentation and verification.

Phase 0 is most likely to run long because it may require upstream review and publication. UI verification may also wait on a running instance that has loaded the new dependency.

Safe handoff points are:

1. After the ccusage JSON contract is merged, released, and pinned.
2. After the pure token-type helper and schema tests pass, with token-only fallback working.
3. After reasoning evidence is exposed without a migration.
4. After the shared component passes isolated rendering tests.
5. After each view integration, before final cross-view verification.