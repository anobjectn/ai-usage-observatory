# Effort Information Across the Observatory — Implementation Plan

**Status:** Ready for implementation
**Date:** 2026-07-27
**Baseline:** v1.5.0
**Scope:** Add provider-recorded reasoning-effort information, where present, to
Dashboard, Explorer, Sessions, Projects, Models, and Data.
**Relationship to existing plan:** This refines the effort-specific portion of
Phase 2 in `../archived/data-sources-usage-introspection-PLAN-FINAL.md`; it does not
supersede that plan's unrelated work.

---

## Objective

Make effort visible alongside tokens, cost, models, and projects without
pretending that every provider, historical record, or turn reports it.

The result must answer:

- Which effort levels were observed?
- How much observed activity used each level?
- Did effort change within a session?
- Which projects and models were associated with each effort level?
- How much of the selected scope has usable effort data?

## Product decisions

1. Label the field **Effort** in compact UI and explain it as
   **provider-recorded reasoning effort** in tooltips and provenance.
2. Treat effort as an observed categorical value, not a model capability,
   quality score, or recommendation.
3. Preserve provider values after trimming and lowercasing. Do not infer effort
   from model names, token ratios, reasoning-token counts, or model catalogs.
4. Preserve every observed value. The initial display order is `low`, `medium`,
   `high`, `xhigh`, followed by any other values alphabetically; missing data is
   a separate `Unknown` bucket.
5. A session may contain more than one effort. Show **Mixed** as the session
   summary and retain the underlying distribution.
6. Weight distributions by attributed tokens when the transcript format links
   usage to effort. Also retain turn counts. Never substitute session counts for
   token share without labeling the unit.
7. Always show coverage beside aggregate effort information. Unknown or
   unindexed activity remains in the denominator.
8. Transcript-derived indexing is opt-in and off by default. Effort UI remains
   present but unavailable until enabled, with a direct explanation rather than
   zeros or an empty chart.
9. Do not add an app-wide effort filter in the first release. Add effort to the
   Data analysis facets and Sessions controls, then evaluate a global filter
   after the display semantics are stable.

## Current state and data availability

The normalized `ccusage` reports validated in `server/schema.ts` contain token,
cost, model, provider, and session information but no effort field. The existing
path index reads only the beginning of each transcript and currently retains
session identity and working directory. Session detail reads a whole transcript
on demand but does not persist derived data.

The local record formats provide effort differently:

| Source | Observed shape | Attribution available | Known limitation |
| --- | --- | --- | --- |
| Codex | `turn_context.payload.effort`, with the active model on the same event | Apply the active turn context to subsequent `token_count.info.last_token_usage` events until the next turn context | Historical records may omit either event; effort can change during a session |
| Claude Code | `effort` on assistant events, with model and `message.usage` on the event | Attribute that event's usage directly to its effort | Older sessions may have usage but no effort; effort can change during a session |
| `ccusage` normalized output | No effort field | None | Cannot provide effort without reading local transcript metadata |

Parser fixtures, not these examples alone, are the contract. Unsupported or
changed shapes must reduce coverage and source health rather than silently map to
`Unknown`.

## Measurement semantics

### Observation row

Normalize both sources into:

```ts
type EffortObservation = {
  sessionId: string;
  provider: "anthropic" | "codex";
  occurredOn: string | null; // local YYYY-MM-DD when the source has a timestamp
  model: string | null;
  effort: string;
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  totalTokens: number;
};
```

- `totalTokens` uses the provider event's own usage fields.
- `reasoningOutputTokens` is supplemental and must not be added to
  `totalTokens` unless the provider's `outputTokens` excludes it.
- Rows with an effort but no attributable usage still increment `turns`; their
  token fields remain zero and their coverage records that token attribution was
  unavailable.
- Rows with usage but no effort contribute to unattributed tokens, never to an
  invented effort level.
- Duplicate or cumulative usage events must be handled per provider fixture.
  Codex uses `last_token_usage`, not `total_token_usage`.

### Shared summary

Every view consumes the same summary shape and aggregation rules:

```ts
type EffortSummary = {
  state: "available" | "partial" | "unavailable" | "disabled";
  dominant: string | null;
  mixed: boolean;
  levels: Array<{
    effort: string;
    turns: number;
    tokens: number;
    tokenShare: number | null;
  }>;
  observedTurns: number;
  unattributedTurns: number;
  turnCoverage: number | null;
  eligibleTokens: number;
  attributedTokens: number;
  unattributedTokens: number;
  tokenCoverage: number | null;
};
```

Rules:

- `dominant` is the largest attributed-token bucket. If no tokens can be
  attributed, it is the largest turn-count bucket and the UI labels the basis as
  turns.
- `mixed` means two or more effort values were observed, regardless of which is
  dominant.
- `eligibleTokens` comes from the matching normalized `ccusage` scope, which
  remains authoritative for usage totals. `unattributedTokens` is
  `eligibleTokens - attributedTokens`, not a second independently summed usage
  stream.
- `tokenCoverage = attributedTokens / eligibleTokens`. It is `null` when the
  scope has no eligible tokens.
- `turnCoverage = observedTurns / (observedTurns + unattributedTurns)`. It is
  `null` when the parser saw no eligible turn events.
- If observed attributed tokens exceed the matching `ccusage` total beyond a
  fixture-defined integer-rounding tolerance, mark token attribution degraded,
  suppress token shares, and retain the turn distribution. Never clamp the
  mismatch into a plausible-looking chart.
- `available` means all eligible tokens in scope were attributed; `partial`
  means some were attributed; `unavailable` means indexing ran but produced no
  supported effort observations; `disabled` means the user has not enabled the
  index.
- Aggregate shares use attributed plus unattributed tokens as the denominator.
  The visible `Unknown` segment therefore prevents known effort levels from
  reading as 100% when coverage is incomplete.
- Session, project, model, date, provider, and Data summaries all use one
  pure aggregation function shared by the server and frontend so counts cannot
  disagree between views.

## Storage and indexing

### Migration

Add migration 3 with two numeric/categorical tables:

```text
session_observations
  session_id PRIMARY KEY
  parser_version
  source_size
  source_mtime
  last_offset
  current_effort
  current_model
  first_event_at
  last_event_at
  attributed_turns
  unattributed_turns
  observed_usage_tokens
  attributed_tokens
  coverage_state
  last_indexed_at

session_effort_usage
  session_id
  occurred_on
  provider
  model
  effort
  turns
  input_tokens
  cache_read_tokens
  cache_creation_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens
  PRIMARY KEY (session_id, occurred_on, model, effort)
```

`current_effort` and `current_model` are categorical parser state. Never persist
an incomplete JSONL fragment because it may contain transcript content. Advance
`last_offset` only through the final complete line and re-read any incomplete
line on the next pass.

Store `occurred_on` and `model` as non-null keys, using an internal empty-string
sentinel when the source omits them; convert the sentinel back to `null` at the
typed API boundary. This keeps the composite primary key deterministic in
SQLite.

### Incremental parser

Create `server/session-observations.ts`:

1. Run only when the `transcriptInsightsEnabled` setting is `true`.
2. Discover files through the same stable session identity used by
   `server/path-indexer.ts`.
3. Skip unchanged files by size, mtime, and parser version.
4. Resume append-only files from `last_offset`.
5. Preserve the active Codex effort/model across chunks so a later token-count
   event is attributed correctly.
6. Rebuild one session if its file shrinks, rotates, or the parser version
   changes.
7. Stop at the last complete JSONL line; incomplete active-session writes are
   normal.
8. Commit one session's offset and aggregate changes in a transaction.
9. Delete observation rows when the source session disappears or when the user
   chooses **Delete derived observations**.
10. Never persist prompt text, response text, reasoning text, commands, tool
    arguments/results, file contents, or newly discovered paths.

Run observation indexing on the collector refresh path after path identity is
available. A parser failure must mark effort data stale/degraded without
invalidating the last successful `ccusage` dashboard snapshot.

### API contract

Add `GET /api/effort` with an ETag based on the observation index version and
last successful index time. Return:

```ts
type EffortData = {
  enabled: boolean;
  parserVersion: number;
  indexedAt: string | null;
  stale: boolean;
  error: string | null;
  coverage: {
    indexedSessions: number;
    eligibleSessions: number;
    sessionsWithEffort: number;
    attributedTurns: number;
    unattributedTurns: number;
    eligibleTokens: number;
    attributedTokens: number;
    unattributedTokens: number;
  };
  total: EffortSummary;
  sessions: Record<string, EffortSummary>;
  days: Array<{ date: string; provider: string; summary: EffortSummary }>;
  projects: Record<string, EffortSummary>;
  models: Record<string, EffortSummary>;
};
```

The endpoint aggregates from the observation tables plus the current snapshot:

- Session keys use the existing stable session ID.
- Project keys use the normalized `cwd` already used by `aggregateProjects()`.
- Model rows use the model attached to each provider effort event. Events
  without a model contribute to coverage but not to a named model.
- Date rows use event dates. Missing timestamps remain visible in total and
  session summaries but are excluded from a dated trend.
- Project and model summaries match the full 120-day snapshot used by their
  current cards. Dashboard and Explorer select from `days` using their current
  range/provider controls. Path-filtered Dashboard and Explorer summaries
  aggregate the matching session summaries; document that a multi-day session
  follows the existing session-date attribution until per-event project/path
  joins are available.

Load this endpoint once at app level when indexing is enabled. A failed effort
request must not take the rest of the app offline.

Extend `/api/insights` from the same observation tables rather than copying
client aggregates back to the server. Add `effort` to `AnalysisScope` with
`all` as the default.

## View changes

### Dashboard

- Add an **Effort mix** panel beside the existing agent mix, using token share
  plus an `Unknown` segment and a visible coverage caption.
- Keep the four headline metric cards unchanged; effort is context for usage,
  not a replacement for a token or cost metric.
- Add a compact effort badge to each **Latest sessions** row:
  `High`, `Low`, `Mixed`, or `Unknown`.
- Respect the existing time, agent, and path controls. If a range has no dated
  effort observations, show the session-based coverage note rather than
  backfilling from all time.

### Explorer

- Add an **Effort distribution** panel below the activity chart.
- Show a stacked daily series for attributed tokens by effort plus `Unknown`;
  the selected time range and provider filter drive the series.
- Provide a `Tokens` / `Turns` unit toggle. The default is `Tokens`; `Turns`
  remains available when token attribution is sparse.
- Keep **Model signals** and **Token composition** unchanged. Effort is a new
  dimension, not another token metric in their existing segmented control.
- Tooltips show the effort value, amount, share of the day's eligible activity,
  and daily coverage.

### Sessions

- Add effort to search text and add an **Effort** select:
  `All`, each observed value, `Mixed`, and `Unknown`.
- Add a sortable **Effort** column. A single observed value shows its badge;
  multiple values show `Mixed`; no value shows `Unknown`.
- In expanded detail, add an **Effort mix** section with token and turn counts
  per value, dominant basis, coverage, and the provider-observed provenance
  label.
- Do not expose reasoning text or add it to session detail.
- Update table `colSpan`, narrow-layout behavior, keyboard labels, and empty
  states.

### Projects

- Add a compact effort-mix strip to each project card beside its existing model
  list. Show at most the three largest known levels plus `Unknown`.
- In project detail, add an **Effort by day** stacked series aligned with the
  selected date range and existing project session set.
- Add effort badges to the linked recent-session list.
- Project effort uses only sessions with the exact normalized project path.
  Sessions without `cwd` stay in overall coverage and never get assigned to a
  project by guesswork.

### Models

- Add **Effort mix** to each model card's definition list, showing the dominant
  level and coverage.
- Expanded model detail shows a compact distribution by tokens and turns.
- Add the session effort badge to each linked session row.
- Attribute effort to the model on the provider event, not merely the session's
  dominant model. Missing event models are `Unknown model` coverage and do not
  inflate a named model's effort mix.
- Preserve the existing unpriced-model ordering and cost wording.

### Data

- Add an **Effort** facet beside model family and outlier controls. The available
  values come from the scoped observation data; include `Unknown`.
- Add a **Reasoning effort** signal section containing:
  - token and turn distributions;
  - provider-separated coverage;
  - sessions that changed effort;
  - model-by-effort and project-by-effort breakdowns;
  - direct links to supporting sessions.
- Include effort in comparable cohorts only when present:
  `provider + model family + effort`. Unknown-effort sessions form their own
  cohort and are never assigned to a known level.
- Extend Frontier Intensity only after the effort distribution and model catalog
  are independently tested. The raw effort panel ships first and must not depend
  on a score.
- Add a provenance/privacy card with index state, parser version, last indexed
  time, session and token coverage, stored field list, never-stored field list,
  enable/disable control, and **Delete derived observations** action.
- Disabling stops future indexing but retains existing rows until the user
  deletes them. Retained rows must be labeled paused/stale and excluded from new
  analysis by default.

## UI states and language

Use the same four states everywhere:

| State | Display |
| --- | --- |
| Disabled | “Enable transcript-derived effort indexing in Data.” |
| Unavailable | “No supported effort metadata was found in this scope.” |
| Partial | Render known values plus `Unknown` and state the percentage covered |
| Available | Render the distribution and still show the coverage count |

Accessibility requirements:

- Do not rely on effort colors alone; every segment has a text or pattern label.
- Use one stable color per normalized effort value across every view.
- Charts have full text summaries and coverage in their accessible names.
- `Mixed` tooltips list the underlying values and units.
- Reduced motion and the existing Data text-scale setting continue to work.

## Implementation sequence

### Phase 1 — Parser, storage, and privacy controls

1. Add migration 3 and store helpers.
2. Add Claude and Codex fixture builders with sensitive text traps.
3. Implement the incremental effort parser and provider adapters.
4. Add opt-in, disable, and delete-derived-data controls.
5. Update source health and privacy documentation before enabling the index.

**Exit:** With indexing off, no transcript is scanned for effort. With it on,
only the documented numeric/categorical fields appear in SQLite; unchanged files
are not rescanned.

### Phase 2 — Shared contracts and aggregates

1. Add shared effort types and a pure `src/effort.ts` module for
   normalization, ordering, and summary aggregation.
2. Build session, date, project, model, provider, and total summaries on the
   server.
3. Add `/api/effort`, ETag handling, stale/error isolation, and app-level loading.
4. Add effort to `AnalysisScope` and `/api/insights`.

**Exit:** The same fixture scope produces identical effort totals and coverage in
all aggregate paths.

### Phase 3 — Six-view presentation

1. Sessions, including mixed-state detail, filtering, and sorting.
2. Dashboard recent-session badges and aggregate mix.
3. Explorer daily distribution.
4. Projects and Models summaries/details.
5. Data facet, raw signal section, and provenance controls.

**Exit:** Every requested view has a useful disabled, unavailable, partial, and
available state; no view silently hides unknown effort.

### Phase 4 — Scoring and advice integration

1. Validate model catalog support separately from observed effort.
2. Add effort to Frontier Intensity and comparable outlier cohorts.
3. Add high-effort mismatch advice only with minimum cohort and coverage guards.

**Exit:** Raw effort information remains available even when scoring is
ungradeable, and every score exposes its effort coverage.

## File map

| File | Change |
| --- | --- |
| `server/migrations.ts` | Add observation tables and indexes |
| `server/store.ts` | Settings, observation reads/writes, and delete transaction |
| `server/session-observations.ts` | New incremental provider-aware parser |
| `server/effort.ts` | New observation queries and scoped aggregate assembly |
| `server/collector.ts` | Run opt-in index without invalidating core snapshots |
| `server/index.ts` | `/api/effort`, settings, and delete endpoint |
| `server/insights.ts` | Effort facet, cohorts, and Data summaries |
| `src/types.ts` | `EffortSummary`, `EffortData`, and insight contract additions |
| `src/effort.ts` | Shared pure normalization, ordering, and summary aggregation |
| `src/App.tsx` | App-level effort loading and view props; extract view code when touched |
| `src/views/data/facets.tsx` | Effort facet |
| `src/views/data/signals.tsx` | Reasoning-effort analysis section |
| `src/views/data/intelligence.tsx` | Wire effort data and privacy/provenance controls |
| `src/styles.css` | Shared badges, stacks, coverage, responsive and accessible states |
| `README.md` | Accurate opt-in indexing and privacy boundary |
| `docs/ARCHITECTURE.md` | Observation-index collection and storage contracts |

Do not add all new view markup to the already-large `src/App.tsx`. Extract each
touched view into `src/views/` before or with its effort UI, without unrelated
visual changes.

## Verification

### Parser and storage tests

- Codex: one effort, changed effort, model change, repeated token-count events,
  cumulative-vs-last usage, missing effort, missing token count, malformed line,
  incomplete final line, appended completion, file shrink, parser-version rebuild.
- Claude: one effort, changed effort, assistant event without effort, effort
  without usage, multiple assistant events, cache token fields, missing model,
  malformed and incomplete lines.
- Unknown future effort values round-trip without schema or UI failure.
- Incremental and clean rebuilds produce identical rows.
- Re-running unchanged files performs no writes.
- A failed session transaction leaves its previous successful observation intact.
- SQLite scan asserts that fixture prompt, response, reasoning, command, tool
  argument, and file-content sentinel strings are absent.
- Disable performs no reads; delete removes both observation tables and derived
  effort advice in one transaction.

### Aggregate tests

- Known plus unknown tokens sum to the eligible total.
- Attributed tokens above the matching `ccusage` total trigger the degraded
  reconciliation path; they are never silently clamped.
- Known plus unknown turns sum to the parser's eligible turn count.
- Mixed sessions preserve every value and choose the documented dominant basis.
- Session sums reconcile with project/model/date/total summaries under the same
  scope.
- Missing `cwd`, model, timestamp, or effort reduces only the applicable
  breakdown's coverage.
- Provider, date, path, model-family, effort, cache, and outlier facets compose
  without changing the underlying denominator unexpectedly.
- Data and Models report identical model-effort totals for identical scopes.

### UI tests

- Each view renders disabled, unavailable, partial, available, mixed, and unknown.
- Effort badges are searchable, sortable, keyboard-accessible, and not color-only.
- Dashboard and Explorer respond to range/provider/path changes.
- Session and project/model deep links preserve existing behavior.
- Empty charts have explanatory text instead of blank plotting areas.
- Narrow viewport, 150% Data text scale, reduced motion, and chart accessible
  names are verified.

### Performance checks

- Record baseline refresh duration, database size, `/api/dashboard` size, and
  `/api/effort` size before implementation.
- Unchanged-file refresh adds negligible parser work.
- Active-file parsing is proportional to appended bytes.
- `/api/dashboard` does not grow with effort data.
- Set and enforce a `/api/effort` payload budget after measuring real data;
  target less than 100 KB compressed for 120 days.

## Acceptance criteria

- Dashboard, Explorer, Sessions, Projects, Models, and Data all show effort where
  supported and an explicit reason where it is not.
- A session that changes effort is never presented as if it used only one level.
- Every aggregate includes unknown activity and visible coverage.
- No effort value is inferred from model, provider, or token behavior.
- Provider event token attribution is fixture-tested and reconciles across views.
- Opt-in, disable, delete, stale, and parser-error paths are complete.
- No raw transcript content is persisted or transmitted.
- Core tokens, costs, quotas, projects, models, and session detail continue to
  work with effort indexing disabled or failed.
- `bun test`, `bun run typecheck`, and `bun run build` pass.
- The existing local app remains reachable after implementation work.

## Explicit non-goals

- Displaying chain-of-thought or reasoning text.
- Judging answer quality from effort.
- Recommending an effort level without outcome evidence.
- Inferring effort for historical rows that do not record it.
- Comparing Claude and Codex effort labels as if their semantics were guaranteed
  equivalent.
- Changing provider settings or the effort of a running session.
