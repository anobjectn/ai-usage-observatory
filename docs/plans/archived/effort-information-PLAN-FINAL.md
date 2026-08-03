# Effort Information Across the Observatory — FINAL Implementation Plan

**Status:** Ready for phased implementation after the Phase 0 contract gate  
**Date:** 2026-07-28  
**Baseline:** v1.5.0  
**Supersedes:** `effort-information-PLAN.md` and
`effort-information-PLAN-reviewed.md` for this scope  
**Scope:** Add provider-recorded reasoning-effort information, where present, to
Dashboard, Explorer, Sessions, Projects, Models, and Data.

This plan refines only the effort-specific portion of
`../archived/data-sources-usage-introspection-PLAN-FINAL.md`. It does not
supersede unrelated work in that plan.

---

## Execution recommendation

**Recommended primary executor:** `gpt-5.6-sol` with high reasoning, one phase at
a time.

The difficult part is not the six UI additions. It is keeping transcript parsing,
incremental byte offsets, SQLite idempotency, snapshot reconciliation, scope
semantics, and privacy correct at the same time. A single subtle error can
double-count usage or attribute tokens to the wrong effort.

If execution must use one of the proposed lighter models, choose
**`gpt-5.6-terra` at xhigh reasoning**, still phase by phase, and require a Sol
review after Phases 1 and 2. Do not select an unspecified “Sonnet” version; its
exact model and context limits are part of the execution decision.

Do not hand the entire plan to one model turn. Each phase has an exit gate and
should land as a separately reviewable change.

Suggested commit sequence:

1. `test(effort): lock transcript attribution contracts`
2. `feat(effort): add incremental observation index`
3. `feat(effort): expose scoped effort aggregates`
4. `feat(effort): add effort information across views`
5. `docs(effort): document indexing and privacy boundaries`

---

## Review disposition

The reviewed draft found important problems in the baseline plan. This final
revision keeps its fixes for background indexing, byte offsets, bounded
responses, explicit indexing state, and shared aggregation arithmetic.

It also corrects the following remaining issues:

| Issue in reviewed draft | Final correction |
| --- | --- |
| Unattributed counts existed only on the session state row | Persist supported observations with missing effort as an internal unknown bucket, so date/model/project observation coverage can be computed |
| “Turns” meant a Codex turn context but a Claude assistant response | Rename the cross-provider unit **Observations** and explain the provider-specific meaning |
| Initial backfill consumed only “changed files” | Build backlog from the complete current path catalog joined against parser state |
| Deleted transcripts were not discoverable | Reconcile a complete catalog and cascade-delete derived rows for missing sources |
| Retention stopped after 120 days, while the app supports All time | Prioritize the recent 120 days, then continue through the older backlog |
| Yielding happened only between files | Yield between bounded byte chunks; a single large file must not monopolize the event loop |
| Append-only detection used only size and mtime | Store and verify a resume-boundary hash before appending; rebuild on mismatch |
| A skipped/malformed relevant line could leave stale Codex parser state active | Record a parser gap and clear active attribution before later token events |
| The dashboard was “unchanged” but was also supposed to carry `effortIndexVersion` | Keep effort versioning and polling independent of `/api/dashboard` |
| One aggregate response lacked per-row denominators and project-day support | Return one requested grouping at a time, with a complete `EffortSummary` for each row |
| A fixed ETag embedded JSON scope text | Hash a canonical key into an HTTP-safe ETag |
| Phase 0 moved five views before adding the feature | Remove the broad refactor; add small shared components and extract existing code only where an edit requires it |
| Phase 4 proposed effort-based scoring/advice | Defer all scoring and recommendations until outcome evidence exists |
| UI components were assigned to a pure model module | Keep pure arithmetic in `src/effort-model.ts` and React components in `src/components/effort/` |
| A hard-coded 0.5% reconciliation tolerance hid integer mismatches | Report the exact delta; never turn an unexplained mismatch into a plausible chart |

---

## Verified baseline

Re-measure these values before enforcing budgets because active transcript files
continue to change.

| Quantity | Observed 2026-07-28 |
| --- | ---: |
| Rows in `session_paths` | 935 (`196` Claude, `739` Codex) |
| Existing transcript files | 919 (`180` Claude, `739` Codex) |
| Stale `session_paths` rows whose source file is gone | 16, all Claude |
| Transcript corpus | about 1.05 GiB |
| Claude files containing an `effort` field | 52 |
| Codex files containing an `effort` field | 739 |
| Claude assistant observations | 10,858; 5,739 carry effort |
| Codex `turn_context` observations | 6,438; all carry effort and model |
| Codex `token_count` events | about 31,400 |
| Empty Codex `last_token_usage` sentinels with nonzero `total_tokens` | 157 |
| `.usage-observatory/data.db` | about 416 KiB, excluding WAL |
| `src/App.tsx` | 6,058 lines |

The 16 stale path rows prove that disappearance reconciliation is required; it
is not only a theoretical cleanup case.

The local corpus also confirms two token-shape details that fixtures must lock:

- Claude usage exposes fresh input, cache-read input, cache-creation input, and
  output as separate fields.
- Codex `cached_input_tokens` is a subset of `input_tokens`, and
  `reasoning_output_tokens` is a subset of `output_tokens`. Neither may be added
  a second time.
- Some Codex events contain zero for every last-usage component while retaining
  a cumulative-like nonzero `total_tokens`. They are empty usage sentinels, not
  billable event totals.

Corpus measurements support the design, but sanitized fixtures are the parser
contract. The implementation must not depend on this machine continuing to have
the same shapes.

---

## Objective

Make provider-recorded effort visible alongside tokens, cost, models, projects,
and sessions without implying that every provider, historical record, or model
call reports it.

The result must answer:

- Which effort values were observed?
- How much observed token activity used each value?
- Did a session contain more than one effort value?
- Which projects and models were associated with each value?
- How much of the selected scope has attributable effort data?
- Is the index disabled, still working, stale, or degraded?

## Product decisions

1. Compact UI uses **Effort**. Help text uses **provider-recorded reasoning
   effort**.
2. Effort is an observed categorical value, not a capability, quality score,
   model tier, or recommendation.
3. Normalize by trimming and lowercasing. Do not infer effort from model names,
   model catalogs, reasoning-token counts, or token ratios.
4. Preserve every non-empty observed value. Canonical display order is `low`,
   `medium`, `high`, `xhigh`, then other values alphabetically.
5. Missing effort is **Unknown**. It is not stored or presented as a provider
   value.
6. A session with two or more observed effort values is **Mixed**. Preserve its
   underlying distribution.
7. Token distribution is the primary comparison. Also retain **Observations**:
   one Claude assistant usage event or one Codex `turn_context`. Do not label
   this cross-provider count “turns.”
8. Always display token coverage. Display observation coverage when the source
   supplied a supported observation boundary.
9. Transcript-derived indexing is opt-in and off by default.
10. Disabling stops new indexing but retains derived rows until the user chooses
    **Delete derived observations**. Disabled retained rows are excluded from
    current analysis.
11. Do not add a global effort filter in this release. Add a Data-only facet and
    a Sessions filter.
12. Render at most five known effort values per chart, followed by `Other` and
    `Unknown`. Storage and APIs retain every value.
13. Do not compare Claude and Codex effort labels as though their semantics were
    equivalent. Combined charts describe recorded labels, and provider-separated
    coverage remains available.

## Explicit non-goals

- Displaying or persisting chain-of-thought, reasoning text, prompts, responses,
  commands, tool arguments/results, or file contents.
- Judging answer quality from effort.
- Recommending an effort value.
- Adding effort to Frontier Intensity, advice, or outlier scoring in this
  release.
- Inferring effort for records that do not contain it.
- Changing a provider setting or a running session’s effort.
- Adding HTTP compression.
- Refactoring all of `src/App.tsx`.
- Building a worker before a measured event-loop problem requires one.

---

## Source attribution contract

### Claude Code

Supported observation:

- An event with `type === "assistant"` and a supported `message.usage` object.
- `effort` is read only from the event’s top-level `effort`.
- `model` is read from `message.model`.
- Timestamp is read from the event timestamp and converted through one shared
  local-date helper.
- One supported assistant event increments `observations` once, whether effort
  is known or missing.

Token mapping:

```text
input_tokens                -> inputTokens
cache_read_input_tokens     -> cacheReadTokens
cache_creation_input_tokens -> cacheCreationTokens
output_tokens               -> outputTokens
totalTokens = input + cacheRead + cacheCreation + output
```

Do not inspect message content to derive any field.

### Codex

Supported observation:

- `turn_context.payload.effort` and `.model` establish the active categorical
  state.
- One supported `turn_context` increments `observations` once, even if no later
  usage event arrives.
- Subsequent `token_count.info.last_token_usage` values are attributed to that
  active state until the next `turn_context`.
- Use `last_token_usage`, never cumulative `total_token_usage`.
- Ignore a `last_token_usage` event whose input, cached input, cache write,
  output, and reasoning output components are all zero. Do not import its
  potentially nonzero `total_tokens`.
- A token event with no valid active context contributes tokens to Unknown and
  records a context-gap quality count.

Token mapping:

```text
rawInput = input_tokens
cacheReadTokens = cached_input_tokens
cacheCreationTokens = cache_write_input_tokens ?? 0
inputTokens = rawInput - cacheReadTokens - cacheCreationTokens
outputTokens = output_tokens
reasoningOutputTokens = reasoning_output_tokens // supplemental subset of output
totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens
```

For a non-empty event, the computed total normally equals source `total_tokens`.
A disagreement, negative `inputTokens`, or
`reasoningOutputTokens > outputTokens` is an unsupported-shape error. Do not
clamp it and continue as healthy data.

### Provider and session identity

- Keep `agent` (`claude` / `codex`), API `provider` (`anthropic` / `codex`), and
  stable `session_id` as distinct concepts.
- Extract one `providerFromAgent()` into `src/provider.ts` and use it from
  collector, insights, and effort code.
- Preserve the broader existing Insights behavior: strings containing `claude`
  or `anthropic` map to Anthropic; strings containing `codex` or `openai` map to
  Codex. Cover the current collector/insights difference with a regression test
  and changelog note.
- A ccusage session without a path-index match remains in token/session
  denominators and is reported as unjoinable Unknown. Do not invent a transcript
  association.

### Parser gaps

- A malformed irrelevant line may be counted and skipped.
- A malformed or over-limit line containing a provider marker creates a parser
  gap. For Codex, clear active effort/model state before processing subsequent
  token events.
- A single line may be buffered only up to 4 MiB. Crossing that limit records a
  gap and skipped-byte count; no transcript fragment is persisted.
- Unsupported shapes reduce quality and coverage. They are never silently
  converted into a healthy Unknown observation.

---

## Shared measurement model

Use orthogonal status fields. One enum must not try to represent combinations
such as “indexing with partial coverage and stale rows.”

```ts
type EffortIndexStatus = {
  enabled: boolean;
  phase: "disabled" | "indexing" | "ready" | "error";
  quality: "ok" | "stale" | "degraded";
  parserVersion: number;
  indexVersion: number;
  indexedAt: string | null;
  error: string | null;
  progress: {
    indexedSessions: number;
    pendingSessions: number;
    indexedBytes: number;
    pendingBytes: number;
  } | null;
  parseErrors: number;
  contextGaps: number;
  skippedBytes: number;
};

type EffortLevelBucket = {
  effort: string;
  observations: number;
  tokens: number;
};

type EffortSummary = {
  coverageState: "unavailable" | "partial" | "complete";
  quality: "ok" | "stale" | "degraded";
  dominant: string | null;
  dominantBasis: "tokens" | "observations" | null;
  mixed: boolean;
  levels: Array<EffortLevelBucket & { tokenShare: number | null }>;
  observedObservations: number;
  unknownObservations: number;
  observationCoverage: number | null;
  eligibleTokens: number;
  attributedTokens: number;
  unknownTokens: number | null;
  tokenCoverage: number | null;
  reconciliationDeltaTokens: number;
};
```

Rules:

- `eligibleTokens` comes from the matching normalized ccusage scope. This keeps
  the application’s existing token totals authoritative.
- `attributedTokens` is the sum of supported transcript usage associated with a
  non-empty effort.
- `unknownTokens = eligibleTokens - attributedTokens` only when the result is
  non-negative.
- If attributed tokens exceed eligible tokens, return the exact positive
  `reconciliationDeltaTokens`, set quality to `degraded`, set `unknownTokens` and
  token shares to `null`, and schedule a normal snapshot refresh. Never clamp.
- Missing-effort observation rows determine `unknownObservations`; parser gaps
  are reported separately because their observation boundary may be unknown.
- `observationCoverage = observed / (observed + unknown)` when that denominator
  is non-zero.
- During backfill, observation coverage describes parsed observations only. The
  UI must pair it with index progress and must not present it as corpus-wide.
- `complete` means all eligible tokens have known effort and no relevant parser
  gap exists. `partial` means some attributable effort exists. `unavailable`
  means none exists in the completed scope.
- Dominance uses attributed tokens when non-zero, otherwise observations. The
  API supplies `dominantBasis`; views do not infer it.
- `mixed` means two or more non-empty effort values were observed.
- Unknown remains in the token-share denominator.

One pure function owns this arithmetic:

```ts
// src/effort-model.ts
export function foldEffort(
  knownBuckets: EffortLevelBucket[],
  context: {
    eligibleTokens: number;
    unknownObservations: number;
    quality: EffortSummary["quality"];
  },
): EffortSummary;
```

The server calls it on SQL-grouped rows. The client may call it only on already
grouped rows, such as an Explorer brush subrange.

---

## Storage and migration

Add migration 3.

First extend the path catalog so the existing stat sweep can be reused:

```sql
ALTER TABLE session_paths ADD COLUMN source_size INTEGER NOT NULL DEFAULT 0;
```

Add derived tables and a private singleton metadata row:

```sql
CREATE TABLE effort_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  index_version INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  last_error TEXT
);

INSERT INTO effort_index_meta(id) VALUES (1);

CREATE TABLE session_effort_state (
  session_id TEXT PRIMARY KEY
    REFERENCES session_paths(session_id) ON DELETE CASCADE,
  parser_version INTEGER NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime REAL NOT NULL,
  source_identity TEXT,
  last_offset INTEGER NOT NULL,        -- byte offset of first unparsed byte
  resume_hash TEXT NOT NULL,           -- hash of bytes immediately before offset
  current_effort TEXT,
  current_model TEXT,
  observations INTEGER NOT NULL DEFAULT 0,
  unknown_observations INTEGER NOT NULL DEFAULT 0,
  observed_usage_tokens INTEGER NOT NULL DEFAULT 0,
  attributed_tokens INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  context_gaps INTEGER NOT NULL DEFAULT 0,
  skipped_bytes INTEGER NOT NULL DEFAULT 0,
  coverage_state TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL
);

CREATE TABLE session_effort_usage (
  session_id TEXT NOT NULL
    REFERENCES session_effort_state(session_id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL,           -- '' sentinel for missing date
  model TEXT NOT NULL,                 -- '' sentinel for missing model
  effort TEXT NOT NULL,                -- '' sentinel for missing effort
  observations INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_reported_events INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, occurred_on, model, effort)
) WITHOUT ROWID;

CREATE INDEX session_effort_usage_day
  ON session_effort_usage(occurred_on, effort);
CREATE INDEX session_effort_usage_model
  ON session_effort_usage(model, effort);
```

Storage rules:

- `server/effort-store.ts` alone converts internal empty-string sentinels to
  typed `null` or Unknown values.
- Missing effort rows are retained because scoped observation coverage cannot be
  reconstructed from session-level counters.
- Additive upserts use `COALESCE`-safe numeric expressions. No nullable numeric
  accumulator may erase a prior value.
- Agent/provider identity comes from `session_paths` and is not duplicated on
  every usage row.
- `effort_index_meta.index_version` is monotonic and bumped inside every
  transaction that changes derived rows.
- Code owns the parser-version constant. The private metadata row stores index
  version, last completed time, enabled state, and last error—not the parser
  contract itself. It is not returned in `/api/dashboard` settings.
- The database stores categorical values and numeric aggregates only.

Before merging, verify migration from a copy of a v1.5.0 database, foreign-key
cascades, `WITHOUT ROWID` size, and rollback behavior.

---

## Catalog reconciliation and indexing

### Complete source catalog

Change `indexSessionPaths()` to return a complete catalog:

```ts
type SessionSource = {
  sessionId: string;
  agent: "claude" | "codex";
  sourceFile: string;
  mtimeMs: number;
  size: number;
  sourceIdentity: string | null; // device/inode where the platform exposes it
};

type PathIndexResult = {
  catalog: SessionSource[];
  changed: SessionSource[];
  removedSessionIds: string[];
};
```

- The existing glob already stats every current transcript. Persist
  `source_size` and return every source; do not perform a second glob/stat sweep.
- Reconcile rows belonging to the two managed roots that were not seen in the
  completed scan. Delete their `session_paths` rows in a transaction; derived
  rows cascade.
- Do not prune after a failed or partial glob scan.
- Build the effort backlog by left-joining the full catalog to
  `session_effort_state`. This makes first enable work even when no path changed.

### Incremental parser

Implement `server/effort-index.ts` with these invariants:

1. Do no full-transcript effort reads while indexing is disabled.
2. Skip a file only when parser version, size, mtime, completed offset, and
   resume-boundary hash all agree.
3. Hash up to 4 KiB immediately before `last_offset`. Before an append resume,
   read and verify that boundary.
4. Rebuild one session when the parser version or source identity changes, the
   file shrinks, the same-size file has a new mtime, mtime moves backward, or the
   resume-boundary hash no longer matches.
5. Read raw byte chunks. Split on `0x0A`; decode only complete lines.
6. `last_offset` is a byte count. Never derive it from JavaScript string length.
7. Do not persist an incomplete trailing fragment. Re-read it from `last_offset`
   during the next pass.
8. Prefilter raw lines by provider marker before `JSON.parse`. A fixture test
   must prove prefilter-on and prefilter-off produce identical aggregates and
   quality counters.
9. Preserve active Codex effort/model across chunks in
   `session_effort_state`.
10. Commit each parsed byte span atomically: additive grouped rows, counters,
   resume hash, next offset, and index-version bump in one transaction.
11. A rebuild deletes one session’s grouped rows and resets its state in the same
    transaction before reading from byte zero.
12. A crash before a span transaction re-reads that span. A crash after it
    resumes after the committed offset. Neither path double-counts.

### Scheduler

- `refresh()` schedules work only after the dashboard snapshot and path catalog
  succeed. No request handler awaits transcript parsing.
- Use one single-flight loop.
- Prioritize sources with activity in the current 120-day window, then continue
  through the older backlog until All time is complete.
- Bound work by both bytes and elapsed time. Start with 4 MiB chunks and yield
  after a 25 ms time slice or each chunk, whichever comes first.
- Yield within a large file, not only between files.
- Recompute pending work from catalog/state rather than relying on an in-memory
  queue or a fragile cursor.
- An active append schedules another pass. An incomplete final line is normal,
  not an error.
- A parser failure records the error and quality counters but never invalidates
  the last successful dashboard snapshot.
- If a benchmark still shows request latency above the performance gate, move
  per-chunk parsing into a Bun `Worker`. Keep SQLite writes in the main process.

### Enable, disable, and delete

Add explicit validated endpoints:

- `PUT /api/effort/settings` with `{ "enabled": boolean }`
- `DELETE /api/effort/derived`

Delete removes both derived data tables’ rows in one transaction, disables
indexing so the rows are not immediately rebuilt, clears response memoization,
and bumps the private index version. It does not delete transcripts, path
metadata, annotations, or usage snapshots.

---

## Scope and API

### Scope semantics

Two date bases already exist in the app and must not be conflated:

- `basis=timeline`: date range applies to calendar activity, for Dashboard and
  Explorer.
- `basis=sessions`: date range selects sessions by their existing last-activity
  semantics, for Sessions and Data; selected sessions contribute their full
  session totals.

Projects and Models use their existing dashboard denominator helpers. Extract
those helpers into a shared pure module only if the server needs them; do not
move whole views.

Supported validated scope fields:

```ts
type EffortScope = {
  basis: "timeline" | "sessions";
  rangeDays: number | null;
  provider: "all" | "anthropic" | "codex";
  pathTag: string;
  project: string | null;
  model: string | null;
  effort: "all" | "mixed" | "unknown" | `value:${string}`;
};
```

Data facet semantics:

- `value:x` selects sessions containing observed value `x`.
- `mixed` selects sessions containing two or more known values.
- `unknown` selects sessions with no known value.
- Once a session is selected, existing Data metrics use the complete session;
  the facet does not erase its other effort values.

For path-tag scopes, resolve the matching session IDs from the current snapshot.
Pass them to constant SQL through a bound JSON array and `json_each(?)`; add a
startup/test assertion that the bundled SQLite supports it. Never interpolate an
`IN (...)` list.

### Endpoints

```text
GET /api/effort/status
GET /api/effort?group=total|day|project|model|provider&<EffortScope>
GET /api/effort/sessions
GET /api/sessions/:id/detail
```

- `/api/effort/status` is small and contains only index state/progress.
- `/api/effort` returns one requested grouping. Every row contains its grouping
  key plus a complete `EffortSummary`, including that row’s denominator.
- Project detail requests `group=day&project=<exact normalized path>`.
- Model detail requests `group=total&model=<exact event model>`.
- `/api/effort/sessions` returns one compact digest row for every current
  dashboard session, including unjoinable sessions as Unknown.
- Existing session detail gains `effort: EffortSummary | null`.

Use readable object contracts for grouped responses first. Do not add string
dictionaries unless the payload tests prove they are needed. The high-cardinality
session digest may use documented tuples:

```ts
type EffortSessionDigest = {
  levels: string[];
  // id, dominant level index (-1 unknown), bit flags, coverage per mille
  rows: Array<[string, number, number, number]>;
};
```

Centralize tuple decoding; views never index tuple positions directly.

### Caching and freshness

- Canonicalize the endpoint name, index version, snapshot `collectedAt`, group,
  and validated scope. Hash that string with SHA-256 and quote the hex digest for
  an HTTP-safe ETag.
- `/api/effort/status` ETag depends on index version and status/progress.
- Aggregate ETags depend on both snapshot and index versions.
- `/api/insights` adds index version only after the Data effort facet is wired.
- Memoize at most 16 aggregate responses by ETag.
- Keep SQL text constant with bound parameters.
- Do not add `effortIndexVersion` to `/api/dashboard`.
- The client effort hook polls status conditionally every 5 seconds while
  indexing and on the existing 60-second/manual dashboard refresh while idle.
  When index version changes, refetch only the visible effort group and session
  digest.
- A failed effort request affects effort UI only.

### Payload budgets

Budgets are uncompressed:

| Response | Gate |
| --- | ---: |
| `/api/effort/status` | ≤ 4 KiB |
| Any one `/api/effort` grouping at the measured baseline | ≤ 150 KiB |
| Session digest | ≤ 96 bytes per session plus level dictionary |
| `/api/dashboard` | No effort fields; byte size unchanged within serialized timestamp variance |

Assert budgets using generated high-cardinality fixtures and print actual sizes
in the test failure.

---

## UI

Add pure display components under `src/components/effort/`:

- `EffortBadge`
- `EffortStack`
- `EffortCoverage`
- `EffortState`

Fixed colors belong to `low`, `medium`, `high`, and `xhigh`. Hash other values to
a stable fallback palette. Reserve neutral treatments for Other and Unknown.
Color is never the only label.

### Dashboard

- Add an Effort mix panel with Unknown and a coverage caption.
- Add a badge to Latest sessions.
- Keep headline token/cost cards unchanged.
- Respect the existing global range, provider, and path-tag controls.

### Explorer

- Add a daily stacked effort distribution.
- Toggle Tokens / Observations, default Tokens.
- Tooltip shows value, amount, day share, provider, and coverage.
- Preserve Model signals and Token composition.

### Sessions

- Add effort to search text.
- Add a filter: All, each observed value, Mixed, Unknown.
- Add a sortable Effort column using canonical numeric order.
- Expanded detail shows known values, tokens, observations, dominant basis,
  coverage, and provenance.
- Update `colSpan`, narrow layout, empty states, and keyboard labels.

### Projects

- Add a compact mix to each card, using project-specific denominators.
- Project detail requests and renders effort by day for the exact normalized
  project path.
- Add badges to linked session rows.
- Never assign missing `cwd` activity to a guessed project.

### Models

- Add dominant effort and coverage to each model card.
- Expanded detail shows token and observation distribution.
- Add badges to linked session rows.
- Use the model recorded on the provider event. Missing event model belongs to
  Unknown model coverage, not a named model.

### Data

- Add the Data-only effort facet with the session-selection semantics above.
- Add a raw Reasoning effort section: provider-separated distribution and
  coverage, mixed sessions, model breakdown, project breakdown, and supporting
  session links.
- Add provenance/privacy controls: status, progress, parser version, indexed
  time, quality counters, session/token coverage, stored fields, never-stored
  fields, enable/disable, and Delete derived observations.
- Do not change Frontier Intensity, advice, or outlier rules.

### UI states

| Condition | Display |
| --- | --- |
| Disabled | “Enable transcript-derived effort indexing in Data.” |
| Indexing | Show partial results with progress and an in-progress label |
| Ready + unavailable | “No supported effort metadata was found in this scope.” |
| Partial | Render known values plus Unknown and state coverage |
| Complete | Render distribution and still state coverage |
| Stale | Keep last derived result with a stale explanation |
| Degraded | Suppress invalid token shares and show the exact quality reason |

Use `aria-live="polite"` for coarse progress changes only. Charts need text
summaries and accessible names. Existing reduced-motion and Data text-scale
behavior must continue to work.

---

## Implementation sequence

### Phase 0 — Contract and benchmark gate

1. Add sanitized Claude and Codex fixture builders with sensitive-text traps.
2. Lock provider-specific effort, observation, token, timestamp, and model
   mappings.
3. Prove Codex cached/reasoning tokens are subsets and are not double-counted.
4. Compare parser totals with pinned ccusage totals for a controlled fixture.
5. Benchmark raw parsing, prefiltering, 4 MiB chunking, and event-loop delay.
6. Add golden tests for timeline versus session scope semantics.

**Exit:** Contracts are unambiguous, reconciliation is exact on controlled
fixtures, and the measured parser design meets the event-loop gate or the plan is
revised to require a Worker before production code.

### Phase 1 — Catalog, storage, and indexer

1. Add migration 3 and migration tests.
2. Return/reconcile the complete source catalog.
3. Implement `server/effort-store.ts`.
4. Implement byte-accurate parsing, resume hashing, gaps, atomic spans, rebuild,
   and deletion.
5. Add the single-flight recent-first/full-backlog scheduler.
6. Add validated enable, disable, delete, status, and source-health paths.

**Exit:** Disabled mode performs no full effort reads; a clean backfill,
interrupted/resumed backfill, rebuild, and incremental append produce identical
rows; deleted sources cascade; no sensitive sentinel appears in SQLite.

### Phase 2 — Summaries and APIs

1. Add `src/effort-model.ts` and shared types.
2. Implement exact denominators for total/day/project/model/provider groups.
3. Add status, grouped aggregate, digest, and session-detail contracts.
4. Add hashed ETags, bounded memoization, payload tests, and the client hook.
5. Add the Data effort facet to `AnalysisScope` and only then update the insights
   ETag.

**Exit:** All grouping paths reconcile on golden fixtures, invalid reconciliation
suppresses shares, the dashboard payload is unchanged, and effort failures are
isolated.

### Phase 3 — Six-view presentation

1. Add shared effort components.
2. Implement Sessions first, including mixed detail/filter/sort.
3. Add Dashboard and Explorer.
4. Add Projects and Models.
5. Add Data raw analysis and privacy controls.
6. Extract only code directly made clearer by these edits.

**Exit:** Every view handles disabled, indexing, unavailable, partial, complete,
stale, degraded, mixed, and unknown states without hiding coverage.

### Phase 4 — Documentation and verification

1. Update `README.md`, `docs/ARCHITECTURE.md`, source health, and `CHANGELOG.md`.
2. Run parser/storage/API/pure UI tests.
3. Run typecheck and production build.
4. Exercise the live app at desktop and narrow widths, with 150% Data text and
   reduced motion.
5. Capture before/after response sizes, database size, backfill duration,
   incremental duration, and request latency.

**Exit:** All acceptance criteria and performance gates pass; the local app
remains reachable.

---

## File map

| File | Change |
| --- | --- |
| `server/migrations.ts` | Migration 3 |
| `server/path-indexer.ts` | Complete catalog, sizes, missing-source reconciliation |
| `server/collector.ts` | Schedule background indexing after collection |
| `server/effort-index.ts` | Parser, scheduler, resume/gap handling |
| `server/effort-store.ts` | Derived-row transactions and grouped SQL |
| `server/effort-api.ts` | Scope, summaries, ETags, memoization |
| `server/index.ts` | Effort status/settings/delete/aggregate routes |
| `server/session-detail.ts` | Lazy per-session effort summary |
| `server/insights.ts` | Data-only effort facet; shared provider mapper |
| `src/provider.ts` | One `providerFromAgent()` |
| `src/effort-model.ts` | Pure normalization, folding, order, display capping |
| `src/types.ts` | Effort contracts |
| `src/hooks/use-effort.ts` | Independent status/data freshness |
| `src/components/effort/*` | Shared React presentation |
| `src/App.tsx` | Minimal view wiring only |
| `src/styles.css` | Shared, responsive, accessible effort styles |
| `README.md` | Opt-in behavior and privacy |
| `docs/ARCHITECTURE.md` | Index lifecycle and data flow |
| `CHANGELOG.md` | Feature and provider-mapper fix |

Do not create `server/effort.ts` and `src/effort.ts` with different
responsibilities.

---

## Verification matrix

### Parser and storage

- Claude: known/missing/changed effort; usage without effort; effort without
  usable usage; cache fields; missing model/date; malformed and partial lines.
- Codex: known/changed effort; model change; multiple `last_token_usage` events;
  no active context; cumulative usage ignored; reasoning subset; incomplete
  final line; append; shrink; rewritten boundary; parser-version rebuild.
- Multi-byte UTF-8 split at every chunk boundary.
- Relevant line over 4 MiB clears active attribution and records a gap.
- Prefilter enabled/disabled equivalence.
- Clean, interrupted, resumed, and rebuilt indexes are identical.
- Forced transaction rollback leaves the previous offset and aggregates intact.
- Unknown future effort values round-trip.
- Full catalog enqueues first enable even with zero changed paths.
- Missing source cleanup runs only after a successful complete catalog scan.
- Sensitive sentinel strings are absent from the database.
- Disable performs no full effort reads; delete touches derived rows only.

### Aggregation and API

- Known plus Unknown equals eligible tokens when reconciliation is valid.
- Positive reconciliation delta degrades and suppresses token shares.
- Missing effort rows provide scoped unknown-observation counts.
- Session, date, provider, project, model, and total summaries reconcile.
- Timeline and session bases follow their documented, tested semantics.
- Path-tag scoping uses bound IDs and cannot alter SQL.
- Project-day and model-detail denominators are specific to their group.
- Unjoinable sessions are explicit and never presented as parser failures.
- Category capping preserves totals.
- ETags change on snapshot, index, group, or scope changes.
- Conditional status polling discovers backfill progress without dashboard
  fields.
- Generated payloads stay inside budget.

### UI and regression

- Every required state renders useful text.
- Mixed and Unknown remain searchable, filterable, and sortable.
- Range/provider/path controls update Dashboard and Explorer effort data.
- Project/model/session deep links keep working.
- Empty/degraded charts do not render misleading zero stacks.
- Keyboard, non-color labels, accessible summaries, reduced motion, narrow
  viewport, and 150% Data text are verified.
- Existing token, cost, cache, quota, project, model, and session-detail behavior
  is unchanged with indexing disabled.

Run:

```sh
bun test
bun run typecheck
bun run build
```

### Performance gates

Record baselines before Phase 1 and compare after Phase 3:

| Metric | Gate |
| --- | --- |
| `/api/dashboard` bytes | Unchanged except timestamp-value length variance |
| No-change refresh | Zero effort SQLite writes |
| Active append | Work proportional to appended bytes |
| Background parsing | Event-loop delay p95 ≤ 50 ms over the benchmark run |
| Warm effort aggregate | p95 ≤ 50 ms over at least 100 requests |
| Any API request during backfill | p95 ≤ 100 ms and max ≤ 250 ms over at least 1,000 requests |
| Derived database size | Measure and report; investigate if over 10 MiB at this baseline |
| Payloads | Meet the API budgets above |

If the backfill latency gate fails after time/byte slicing, use the specified
Worker boundary. Do not hide the failure by making backfill effectively
unbounded.

---

## Acceptance criteria

- All six requested views expose observed effort or an explicit reason it is not
  available.
- Mixed sessions preserve every known value.
- Unknown activity and coverage remain visible.
- Claude and Codex token fields are normalized without double-counting cached or
  reasoning subsets.
- No effort value is inferred.
- Initial enable works with a warm path index.
- Recent history is prioritized and All time eventually completes.
- Deleted, truncated, rewritten, appended, malformed, and partial sources have
  tested behavior.
- No request awaits transcript parsing.
- No raw transcript content is persisted or transmitted.
- Indexing disabled, indexing in progress, and index failure cannot break core
  dashboard collection.
- Scoped summaries have correct per-row denominators.
- Invalid reconciliation never produces a plausible-looking share.
- Effort freshness does not require changing `/api/dashboard`.
- Exactly one provider mapper and one folding function exist.
- No effort-based score, advice, or recommendation ships in this release.
- `bun test`, `bun run typecheck`, and `bun run build` pass.
- The local app is left reachable after implementation.
