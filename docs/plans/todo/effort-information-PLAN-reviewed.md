# Effort Information Across the Observatory — Reviewed Implementation Plan

**Status:** Ready for implementation
**Date:** 2026-07-28
**Baseline:** v1.5.0
**Supersedes:** `effort-information-PLAN.md` (same scope, revised for runtime
performance, code maintainability, and app quality)
**Scope:** Add provider-recorded reasoning-effort information, where present, to
Dashboard, Explorer, Sessions, Projects, Models, and Data.
**Relationship to existing plans:** This refines the effort-specific portion of
Phase 2 in `../archived/data-sources-usage-introspection-PLAN-FINAL.md`; it does
not supersede that plan's unrelated work.

---

## What this revision changes

The product decisions, measurement semantics, and privacy boundary of the
baseline plan are kept. The changes below are engineering corrections found by
checking the plan against the actual code and the actual local corpus.

| # | Baseline plan | Problem | This revision |
| --- | --- | --- | --- |
| 1 | `/api/effort` returns `sessions: Record<string, EffortSummary>` | ~934 indexed sessions × a nested `levels` array blows the stated payload budget on day one and grows without bound | Three-tier delivery: scoped aggregates, a compact all-session digest, and lazy per-session distributions folded into the existing detail endpoint |
| 2 | Budget "less than 100 KB compressed" | Nothing in `server/index.ts` sets `Content-Encoding`; every response is uncompressed | Budgets restated in uncompressed bytes; compression explicitly rejected for a localhost server (see [Payload budgets](#payload-budgets)) |
| 3 | ETag from "observation index version and last successful index time" | `eligibleTokens` comes from the ccusage snapshot, which changes independently — a 304 can serve stale coverage | ETag composes `collectedAt` + `effortIndexVersion` + scope key; same fix applied to `/api/insights` |
| 4 | Client aggregates path-filtered summaries from per-session summaries | Forces the whole session fact table onto the wire and duplicates aggregation logic | `/api/effort` takes the existing `AnalysisScope` query params and aggregates server-side via SQL, mirroring `/api/insights` |
| 5 | "Run observation indexing on the collector refresh path" | First enable parses **1.07 GB** across 918 files inside the request that `/api/dashboard` awaits | Indexing runs as a background worker loop with a byte budget per tick, a persisted backfill cursor, and per-file yields; no request ever waits on it |
| 6 | `last_offset` with no unit stated | JS string length is UTF-16 code units; transcripts are UTF-8 — a character offset silently corrupts resume on any non-ASCII line | `last_offset` is a **byte** offset; the parser splits raw bytes on `0x0A` and decodes complete lines only |
| 7 | Upsert semantics unspecified | Additive vs. replace decides whether a re-read double-counts | Additive upserts, byte span and counters committed in one transaction; rebuild deletes the session's rows in the same transaction that resets the offset |
| 8 | Every line `JSON.parse`d | ~1 GB of JSON parsing for a handful of event types | Byte-level substring prefilter per provider, with a fixture test asserting prefilter-on and prefilter-off produce identical rows |
| 9 | `provider` column on every usage row; PK omits it | Denormalized per row, and a PK that excludes it lets an upsert silently flip provider | Provider lives once on the per-session state row; usage rows join to it |
| 10 | `server/effort.ts` **and** `src/effort.ts` | Two files with the same basename, different responsibilities | `src/effort-model.ts` (pure, shared), `server/effort-index.ts` (parser), `server/effort-store.ts` (SQL) |
| 11 | `EffortObservation.provider: "anthropic" \| "codex"` | The path index stores `agent` (`claude`/`codex`); two different agent→provider mappers already exist in `server/collector.ts` and `server/insights.ts` | One shared `providerFromAgent()`; the third copy is not written |
| 12 | Four UI states | A multi-minute first backfill has no state — it reads as "unavailable" | Fifth state `indexing`, with progress, everywhere the other four appear |
| 13 | "Preserve every observed value" with per-value colors | Effort values are open-ended; unbounded categories break both the palette and stacked charts | Canonical order retained; display capped at top *N* + `Other` + `Unknown`, with deterministic color assignment |
| 14 | Sessions permanently unjoinable to a transcript not modelled | ccusage rows with no path-index match get a synthetic id and can never carry effort — they would sit in "unattributed" forever with no explanation | Explicit `unjoinableSessions` coverage bucket with its own UI wording |
| 15 | View extraction "before or with its effort UI" | Mixing a 6,058-line file's extraction with new features makes the diff unreviewable | Phase 0: extraction lands first as a behaviour-neutral change |

## Measured baseline (this machine, 2026-07-28)

Numbers the budgets below are derived from. Re-measure before enforcing.

| Quantity | Value |
| --- | --- |
| Indexed sessions | 934 (196 `claude`, 738 `codex`) |
| Transcript corpus | 1.07 GB (110 MB Claude, 960 MB Codex) |
| Transcript files | 918 |
| Files > 5 MB | 29 |
| Files modified in last 120 days | 838 |
| `data.db` | 389 KB |
| `src/App.tsx` | 6,058 lines |

A first enable therefore parses ~1 GB. Every performance decision in this plan
follows from that number.

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
4. Preserve every observed value in storage and in the API. The canonical order
   is `low`, `medium`, `high`, `xhigh`, then any other value alphabetically;
   missing data is a separate `Unknown` bucket.
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
10. **(new)** Rendering caps are a display concern only. Storage and the API keep
    every observed value; a view that caps to top *N* labels the remainder
    `Other` and keeps it in the denominator.

## Current state and data availability

The normalized `ccusage` reports validated in `server/schema.ts` contain token,
cost, model, provider, and session information but no effort field.
`server/path-indexer.ts` reads only the first 96 KB / 80 lines of each transcript
and retains session identity, agent, source file, `cwd`, and mtime. Session
detail (`server/session-detail.ts`) reads a whole transcript on demand behind an
mtime-keyed in-memory cache and persists nothing.

The local record formats provide effort differently:

| Source | Observed shape | Attribution available | Known limitation |
| --- | --- | --- | --- |
| Codex | `turn_context.payload.effort`, with the active model on the same event | Apply the active turn context to subsequent `token_count.info.last_token_usage` events until the next turn context | Historical records may omit either event; effort can change during a session |
| Claude Code | `effort` on assistant events, with model and `message.usage` on the event | Attribute that event's usage directly to its effort | Older sessions may have usage but no effort; effort can change during a session |
| `ccusage` normalized output | No effort field | None | Cannot provide effort without reading local transcript metadata |

Parser fixtures, not these examples alone, are the contract. Unsupported or
changed shapes must reduce coverage and source health rather than silently map to
`Unknown`.

### Identity and joins

Three identifiers already coexist and must not gain a fourth spelling:

- `agent` — `"claude"` / `"codex"` in `session_paths`, and the raw ccusage agent
  string on report rows.
- `provider` — `"anthropic"` / `"codex"` in `src/types.ts` and every API shape.
- `session_id` — `stableSessionId(agent, sourceRelativePath, nativeSessionKey)`.

`server/collector.ts:activityProvider()` and `server/insights.ts:provider()`
already implement the agent→provider mapping twice, and they differ: insights
also matches `"openai"`. Extract one `providerFromAgent()` into
`src/provider.ts` and have both call sites plus the effort code use it. Adopt the
broader (insights) matcher; this makes an `openai`-labelled agent count toward
project activity where it previously did not. That is a defect fix — cover it
with a test naming the previous and new behaviour, and note it in the changelog.

`server/collector.ts` joins ccusage sessions to the path index by
`` `${row.agent}:${row.period}` `` and falls back to a synthetic
`` `${row.agent}-${row.period}` `` id. Sessions on the fallback path have no
source file, so they can never carry effort. They are counted in
`coverage.unjoinableSessions`, not silently pooled into "no effort found".

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
  `totalTokens` unless the provider's `outputTokens` excludes it. A fixture
  asserts the chosen interpretation per provider.
- Rows with an effort but no attributable usage still increment `turns`; their
  token fields remain zero and their coverage records that token attribution was
  unavailable.
- Rows with usage but no effort contribute to unattributed tokens, never to an
  invented effort level.
- Duplicate or cumulative usage events must be handled per provider fixture.
  Codex uses `last_token_usage`, not `total_token_usage`.

### Shared summary

Every view consumes the same summary shape:

```ts
type EffortLevelBucket = { effort: string; turns: number; tokens: number };

type EffortSummary = {
  state: "available" | "partial" | "unavailable" | "disabled" | "indexing";
  dominant: string | null;
  dominantBasis: "tokens" | "turns" | null;
  mixed: boolean;
  levels: Array<EffortLevelBucket & { tokenShare: number | null }>;
  observedTurns: number;
  unattributedTurns: number;
  turnCoverage: number | null;
  eligibleTokens: number;
  attributedTokens: number;
  unattributedTokens: number;
  tokenCoverage: number | null;
  /** Set when attributed tokens exceeded the ccusage total beyond tolerance. */
  degraded: boolean;
};
```

Rules:

- `dominant` is the largest attributed-token bucket; `dominantBasis` is
  `"tokens"`. If no tokens can be attributed it is the largest turn-count bucket
  and `dominantBasis` is `"turns"`. The UI renders the basis rather than
  inferring it.
- `mixed` means two or more effort values were observed, regardless of which is
  dominant.
- `eligibleTokens` comes from the matching normalized `ccusage` scope, which
  remains authoritative for usage totals. `unattributedTokens` is
  `eligibleTokens - attributedTokens`, not a second independently summed usage
  stream.
- `tokenCoverage = attributedTokens / eligibleTokens`, `null` when the scope has
  no eligible tokens.
- `turnCoverage = observedTurns / (observedTurns + unattributedTurns)`, `null`
  when the parser saw no eligible turn events.
- If attributed tokens exceed the matching `ccusage` total by more than
  `max(64 tokens, 0.5%)` — a ratio, not an integer epsilon, because the mismatch
  scales with volume — set `degraded`, suppress token shares, and retain the turn
  distribution. Never clamp the mismatch into a plausible-looking chart.
- `available` means all eligible tokens in scope were attributed; `partial` means
  some were; `unavailable` means indexing completed and found no supported effort
  metadata; `indexing` means a backfill is still running for sessions in scope;
  `disabled` means the user has not enabled the index.
- Aggregate shares use attributed plus unattributed tokens as the denominator, so
  the visible `Unknown` segment prevents known levels from reading as 100% when
  coverage is incomplete.

### One folding function, small inputs

The baseline plan's "one pure aggregation function shared by the server and
frontend" is kept, but narrowed so it does not imply shipping raw rows:

```ts
// src/effort-model.ts
export function foldEffort(
  buckets: EffortLevelBucket[],
  context: { eligibleTokens: number; unattributedTurns: number; state: EffortSummary["state"] },
): EffortSummary;
```

- The server calls `foldEffort` on the output of a SQL `GROUP BY`.
- The client calls `foldEffort` on already-grouped day/level rows when it
  re-folds a sub-range (for example an Explorer brush selection).

Both paths run identical arithmetic over inputs measured in tens of rows, not
tens of thousands. Session, project, model, date, provider, and Data summaries
all terminate in this function, so counts cannot disagree between views.

---

## Storage and indexing

### Migration 3

```sql
CREATE TABLE IF NOT EXISTS session_effort_state (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime REAL NOT NULL,
  last_offset INTEGER NOT NULL,          -- BYTE offset of first unparsed byte
  current_effort TEXT,
  current_model TEXT,
  first_event_at TEXT,
  last_event_at TEXT,
  attributed_turns INTEGER NOT NULL DEFAULT 0,
  unattributed_turns INTEGER NOT NULL DEFAULT 0,
  observed_usage_tokens INTEGER NOT NULL DEFAULT 0,
  attributed_tokens INTEGER NOT NULL DEFAULT 0,
  coverage_state TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_effort_usage (
  session_id TEXT NOT NULL,
  occurred_on TEXT NOT NULL,             -- '' sentinel when the source omits it
  model TEXT NOT NULL,                   -- '' sentinel when the source omits it
  effort TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, occurred_on, model, effort)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS session_effort_usage_day ON session_effort_usage(occurred_on, effort);
CREATE INDEX IF NOT EXISTS session_effort_usage_model ON session_effort_usage(model, effort);
```

Design notes:

- **Provider is not on the usage row.** It is a property of the session; the
  usage table joins `session_effort_state.agent` and maps it through
  `providerFromAgent()`. This removes a per-row duplicate and removes the
  possibility of a usage row disagreeing with its session.
- **`WITHOUT ROWID`** suits a narrow composite-PK table whose rows are well under
  200 bytes and which is always read by PK prefix or by one of the two indexes.
  Verify with a size measurement on real data before merging; revert to a rowid
  table if the file grows.
- **Sentinels.** `occurred_on` and `model` are non-null so the composite PK is
  deterministic in SQLite (`NULL != NULL` would create duplicate rows).
  `server/effort-store.ts` is the only place that converts `''` back to `null`,
  at the typed API boundary.
- **No new metadata table.** Index bookkeeping reuses the existing `settings`
  table: `transcriptInsightsEnabled`, `effortParserVersion`, `effortIndexVersion`
  (monotonic, bumped inside every committing transaction), `effortIndexedAt`,
  `effortBackfillCursor`, `effortIndexError`.
- `current_effort` and `current_model` are categorical parser state. Never
  persist an incomplete JSONL fragment — it may contain transcript content.

### Incremental parser — `server/effort-index.ts`

1. Run only when `transcriptInsightsEnabled` is `true`.
2. Take the work list from `indexSessionPaths()`, which already stats every
   transcript on each refresh. Change it to return the changed sessions
   (`{ sessionId, agent, sourceFile, mtimeMs, size }[]`) instead of a count, so
   the effort indexer does not perform a second 918-file glob and stat sweep.
3. Skip a session when `parser_version`, `source_size`, and `source_mtime` all
   match. Rebuild when `parser_version` changed, `source_size < last_offset`
   (truncation or rotation), or mtime moved backwards.
4. **Byte-accurate resume.** Read `Bun.file(path).slice(last_offset, last_offset + chunk)`
   as a `Uint8Array`, split on `0x0A`, decode only complete lines, and carry the
   trailing partial line's bytes into the next chunk. Advance `last_offset` by
   the exact byte length consumed through the last complete newline. Never derive
   an offset from a decoded string's `.length`.
5. **Prefilter before parsing.** Before `JSON.parse`, test the raw line bytes for
   a provider-specific marker — Codex: `turn_context` or `token_count`; Claude:
   `"effort"` or `"usage"`. Lines without a marker are counted and discarded.
   A test asserts that parsing the fixture corpus with the prefilter disabled
   produces byte-identical rows, so the fast path can never silently drop an
   event.
6. Guard pathological input: a single line over 4 MB is counted as malformed and
   skipped rather than buffered.
7. Preserve the active Codex effort/model across chunk and pass boundaries via
   `current_effort` / `current_model` so a later token-count event is attributed
   correctly.
8. Stop at the last complete JSONL line; incomplete active-session writes are
   normal.
9. **Transaction and idempotency contract.** Per session, in one transaction:
   additive upsert of the parsed span's rows
   (`SET turns = turns + excluded.turns, …`), the new `last_offset`, the updated
   counters, and the `effortIndexVersion` bump. A rebuild deletes that session's
   `session_effort_usage` rows and resets `last_offset` to 0 *in the same
   transaction*. Because the byte span and its derived rows commit atomically, a
   crash or failure re-reads the span rather than double-counting it.
10. Delete rows when the source session disappears, and delete both tables plus
    derived effort advice in one transaction on **Delete derived observations**.
11. Never persist prompt text, response text, reasoning text, commands, tool
    arguments or results, file contents, or newly discovered paths.

### Scheduling — never on the request path

The baseline plan ran indexing on the collector refresh path. On this machine
that is ~1 GB of parsing inside the call `/api/dashboard` awaits, and
`src/App.tsx` re-polls `/api/dashboard` every 60 s.

Instead:

- `refresh()` schedules the indexer the way it already schedules
  `reconcileAdvice()` — after the snapshot resolves, never awaited by a request.
- The indexer is a single-flight background loop with a **byte budget per tick**
  (start at 64 MB) and a persisted cursor, yielding to the event loop between
  files. Work remaining ⇒ next tick on a short timer; no work ⇒ idle until the
  next refresh reports changed sessions.
- Retention bound: only sessions with activity inside the snapshot's 120-day
  window are backfilled by default (838 of 918 files here). Older sessions are
  indexed on demand when a view asks for them, and the setting is adjustable.
- A parser failure marks effort data stale/degraded and records
  `effortIndexError`. It must never invalidate the last successful `ccusage`
  snapshot.
- **Escape hatch, pre-specified:** if measured p99 API latency during a backfill
  exceeds 250 ms, move the per-file parse into a `Worker`. This is cheap to do
  because the parser's input is a path plus an offset and its output is numeric
  and categorical only — there is no shared state to marshal. Do not build the
  worker speculatively; build it if the measurement demands it.

---

## API contract

### Three tiers, sized to their consumers

| Endpoint | Contents | Why not one endpoint |
| --- | --- | --- |
| `GET /api/effort?<AnalysisScope params>` | Index status, dictionaries, and total/day/project/model aggregates **for the requested scope** | Server-side scoping means path/provider/range filtering never requires shipping the session fact table |
| `GET /api/effort/sessions` | Compact digest for every session: dominant level, mixed flag, coverage code | Sessions table badges, search, filter, and sort need all sessions at once; a digest is ~25 KB where full summaries would be ~250 KB |
| `GET /api/sessions/:id/detail` (existing) | `effort: EffortSummary \| null` added to the response | The expanded row already fetches detail — the full per-session distribution costs no extra round trip and no aggregate payload |

```ts
type EffortIndexStatus = {
  enabled: boolean;
  parserVersion: number;
  indexVersion: number;
  indexedAt: string | null;
  stale: boolean;
  error: string | null;
  backfill: { pendingSessions: number; pendingBytes: number; totalBytes: number } | null;
};

type EffortCoverage = {
  indexedSessions: number;
  eligibleSessions: number;
  sessionsWithEffort: number;
  /** ccusage sessions with no path-index match; they can never carry effort. */
  unjoinableSessions: number;
  attributedTurns: number;
  unattributedTurns: number;
  eligibleTokens: number;
  attributedTokens: number;
  unattributedTokens: number;
};

type EffortData = {
  status: EffortIndexStatus;
  /** Dictionaries; every id below indexes into these. */
  levels: string[];   // canonical order
  models: string[];
  projects: string[];
  dates: string[];
  coverage: EffortCoverage;
  total: EffortSummary;
  days: Array<{ date: number; provider: 0 | 1; levels: Array<[level: number, turns: number, tokens: number]> }>;
  projectRows: Array<{ project: number; levels: Array<[level: number, turns: number, tokens: number]> }>;
  modelRows: Array<{ model: number; levels: Array<[level: number, turns: number, tokens: number]> }>;
};

/** One entry per session, ordered to match the dashboard's session array. */
type EffortSessionDigest = {
  levels: string[];
  rows: Array<{ id: string; dominant: number; mixed: 0 | 1; coverage: 0 | 1 | 2 | 3 }>;
};
```

Dictionary ids replace the four high-cardinality strings (level, model, project
path, date), which is where the bytes are. To keep that from leaking into view
code, `src/effort-model.ts` exports the decoders (`levelName`, `projectName`,
`decodeDays`) and **no view touches a raw index**.

### Caching and correctness

- ETag: `"${snapshot.collectedAt}:${effortIndexVersion}:${scopeKey}"`. Both
  inputs are required — coverage denominators come from the snapshot, the
  numerators from the index.
- `/api/insights` gains the same `effortIndexVersion` component once `effort`
  joins `AnalysisScope`; its current `"${collectedAt}:${scope}"` key would
  otherwise serve stale effort facets from a 304.
- Server-side memoization: an LRU of at most 16 assembled `EffortData` payloads
  keyed by the ETag string. Aggregates are recomputed only when the snapshot or
  the index actually changed.
- `db.query()` caches its prepared statement per SQL string. Keep the effort
  queries as constant strings with bound parameters — never build an `IN` list by
  interpolation, or the cache is defeated on every distinct scope.
- Client fetching: the dashboard payload carries `effortIndexVersion`. The effort
  hook refetches when that value or the scope changes — not on an independent
  60-second timer. A failed effort request must not take the rest of the app
  offline.
- `resolveScope()` is reused verbatim for `/api/effort`, with `effort` added to
  `AnalysisScope` defaulting to `all`. One scope parser, one set of URL params,
  one place to validate.

### Payload budgets

Restated in **uncompressed** bytes, because `server/index.ts` sets no
`Content-Encoding` and none should be added: this is a loopback server where the
browser's `JSON.parse` cost dominates transfer cost, so gzip would trade real CPU
on both ends for bytes that are effectively free.

| Response | Budget | Basis |
| --- | --- | --- |
| `/api/effort` (120 days, all providers) | ≤ 120 KB | 120 dates × 2 providers × ~4 levels, plus project and model rows |
| `/api/effort/sessions` | ≤ 40 KB | 934 sessions × ~30 bytes; re-check at 5,000 sessions |
| `/api/dashboard` | unchanged | Effort data must never enter it |

Each budget is asserted by a test that serializes a generated worst-case fixture.
Exceeding a budget fails CI rather than being discovered in a browser.

---

## Code layout

Distinct basenames, one responsibility each:

| Module | Responsibility |
| --- | --- |
| `src/effort-model.ts` | Pure: normalization, canonical ordering, `foldEffort`, dictionary decoders, display capping. Imported by both server and client (the server already imports `../src/types`). |
| `src/provider.ts` | `providerFromAgent()`, replacing the two existing copies. |
| `server/effort-index.ts` | Incremental parser and provider adapters. |
| `server/effort-store.ts` | SQL reads/writes, sentinel conversion, delete transaction. |
| `server/effort-api.ts` | Scoped aggregate assembly, memoization, ETag composition. |

No file named `effort.ts` exists on either side.

---

## View changes

Presentation is unchanged from the baseline plan except where noted. Every view
uses the shared badge, stack, and coverage-caption components from
`src/effort-model.ts` plus one CSS block — not per-view variants.

### Dashboard

- Add an **Effort mix** panel beside the existing agent mix, using token share
  plus an `Unknown` segment and a visible coverage caption.
- Keep the four headline metric cards unchanged; effort is context for usage, not
  a replacement for a token or cost metric.
- Add a compact effort badge to each **Latest sessions** row: `High`, `Low`,
  `Mixed`, or `Unknown`, read from the digest map.
- Respect the existing time, agent, and path controls. If a range has no dated
  effort observations, show the session-based coverage note rather than
  backfilling from all time.

### Explorer

- Add an **Effort distribution** panel below the activity chart: a stacked daily
  series of attributed tokens by effort plus `Unknown`, driven by the selected
  range and provider filter.
- Provide a `Tokens` / `Turns` unit toggle, defaulting to `Tokens`.
- Keep **Model signals** and **Token composition** unchanged.
- Tooltips show the effort value, amount, share of the day's eligible activity,
  and daily coverage.

### Sessions

- Add effort to search text and add an **Effort** select: `All`, each observed
  value, `Mixed`, `Unknown`.
- Add a sortable **Effort** column. Sorting compares the numeric canonical level
  index from the digest, not a localized string.
- In expanded detail, add an **Effort mix** section — token and turn counts per
  value, dominant basis, coverage, provenance label — sourced from the detail
  endpoint's new `effort` field.
- Do not expose reasoning text or add it to session detail.
- Update table `colSpan`, narrow-layout behaviour, keyboard labels, and empty
  states.

### Projects

- Add a compact effort-mix strip to each project card beside its model list, at
  most the three largest known levels plus `Unknown`.
- In project detail, add an **Effort by day** stacked series aligned with the
  selected range and project session set.
- Add effort badges to the linked recent-session list.
- Project effort uses only sessions with the exact normalized project path.
  Sessions without `cwd` stay in overall coverage and are never assigned to a
  project by guesswork.

### Models

- Add **Effort mix** to each model card's definition list, showing the dominant
  level and coverage.
- Expanded model detail shows a compact distribution by tokens and turns.
- Add the session effort badge to each linked session row.
- Attribute effort to the model on the provider event, not the session's dominant
  model. Events without a model are `Unknown model` coverage and never inflate a
  named model's mix.
- Preserve the existing unpriced-model ordering and cost wording.

### Data

- Add an **Effort** facet beside model family and outlier controls, with values
  from the scoped observation data plus `Unknown`.
- Add a **Reasoning effort** signal section: token and turn distributions,
  provider-separated coverage, sessions that changed effort, model-by-effort and
  project-by-effort breakdowns, and links to supporting sessions.
- Include effort in comparable cohorts only when present:
  `provider + model family + effort`. Unknown-effort sessions form their own
  cohort.
- Extend Frontier Intensity only after the effort distribution and model catalog
  are independently tested. The raw panel ships first and must not depend on a
  score.
- Add a provenance/privacy card: index state, backfill progress, parser version,
  last indexed time, session and token coverage, stored field list, never-stored
  field list, enable/disable control, and **Delete derived observations**.
  Deleting also clears the server memo cache and bumps `effortIndexVersion` so
  every ETag invalidates.
- Disabling stops future indexing but retains rows until deletion. Retained rows
  are labeled paused/stale and excluded from new analysis by default.

### Rendering guards

- **Category cap.** Charts and strips render at most the top 5 known levels, then
  `Other` (aggregating the rest, still in the denominator), then `Unknown`. This
  bounds legend width, palette size, and stack segment count regardless of what a
  provider emits.
- **Deterministic color.** The four canonical levels get fixed palette slots.
  Any other value takes a slot by stable hash of the normalized string, so a
  level keeps one color across every view and across reloads. `Unknown` and
  `Other` have reserved neutral slots.
- **Re-render containment.** Effort data lives in its own hook and context, not
  in the existing dashboard state object, so a 60-second dashboard poll does not
  re-render every effort chart. Extracted views are `React.memo` with narrow
  props; digest lookup is a `Map` built once per digest version.

## UI states and language

| State | Display |
| --- | --- |
| Disabled | "Enable transcript-derived effort indexing in Data." |
| Indexing | "Reading transcripts — *n* of *m* sessions." Show partial data with an explicit in-progress marker; never present it as final. |
| Unavailable | "No supported effort metadata was found in this scope." |
| Partial | Render known values plus `Unknown` and state the percentage covered |
| Available | Render the distribution and still show the coverage count |

Accessibility requirements:

- Do not rely on effort colors alone; every segment has a text or pattern label.
- Use one stable color per normalized effort value across every view.
- Charts have full text summaries and coverage in their accessible names.
- `Mixed` tooltips list the underlying values and units.
- The `indexing` state announces progress politely (`aria-live="polite"`), not on
  every tick.
- Reduced motion and the existing Data text-scale setting continue to work.

---

## Implementation sequence

### Phase 0 — View extraction (behaviour-neutral)

1. Extract Dashboard, Explorer, Sessions, Projects, and Models from the
   6,058-line `src/App.tsx` into `src/views/`, moving code without editing it.
2. Extract `providerFromAgent()` into `src/provider.ts` and repoint
   `server/collector.ts` and `server/insights.ts`, with a test covering the
   `openai` behaviour change.
3. Record the performance baselines listed under [Verification](#performance-checks).

**Exit:** `bun test`, `bun run typecheck`, and `bun run build` pass; the rendered
app is visually unchanged; the diff contains no new features.

### Phase 1 — Parser, storage, and privacy controls

1. Add migration 3 and `server/effort-store.ts`.
2. Add Claude and Codex fixture builders with sensitive-text traps.
3. Implement `server/effort-index.ts`: byte-offset resume, prefilter, additive
   transaction contract, rebuild triggers.
4. Add the background scheduler, byte budget, backfill cursor, and retention
   bound; change `indexSessionPaths()` to return changed sessions.
5. Add opt-in, disable, and delete-derived-data controls.
6. Update source health, `README.md`, and `docs/ARCHITECTURE.md` before enabling.

**Exit:** With indexing off, no transcript is read for effort. With it on, only
the documented numeric/categorical fields appear in SQLite; unchanged files are
not rescanned; a full 1 GB backfill completes in the background without a request
exceeding its latency budget.

### Phase 2 — Shared contracts and aggregates

1. Add `src/effort-model.ts` (normalization, ordering, `foldEffort`, decoders,
   capping) and the shared types in `src/types.ts`.
2. Build session, date, project, model, provider, and total aggregates in SQL in
   `server/effort-api.ts`, all terminating in `foldEffort`.
3. Add `/api/effort`, `/api/effort/sessions`, ETag composition, the memo cache,
   payload-budget tests, stale/error isolation, and the client hook.
4. Add `effort` to `AnalysisScope`, `/api/insights`, and the insights ETag.
5. Add `effort` to the session detail response.

**Exit:** The same fixture scope produces identical effort totals and coverage in
every aggregate path, and every payload is inside budget.

### Phase 3 — Six-view presentation

1. Sessions, including mixed-state detail, filtering, and sorting.
2. Dashboard recent-session badges and aggregate mix.
3. Explorer daily distribution.
4. Projects and Models summaries and details.
5. Data facet, raw signal section, and provenance controls.

**Exit:** Every requested view has a useful disabled, indexing, unavailable,
partial, and available state; no view silently hides unknown effort.

### Phase 4 — Scoring and advice integration

1. Validate model catalog support separately from observed effort.
2. Add effort to Frontier Intensity and comparable outlier cohorts.
3. Add high-effort mismatch advice only with minimum cohort and coverage guards.

**Exit:** Raw effort information remains available even when scoring is
ungradeable, and every score exposes its effort coverage.

---

## File map

| File | Change |
| --- | --- |
| `server/migrations.ts` | Migration 3: two tables and two indexes |
| `server/store.ts` | Effort settings keys; re-export the delete transaction |
| `server/effort-index.ts` | New incremental provider-aware parser and scheduler |
| `server/effort-store.ts` | New SQL reads/writes and sentinel boundary |
| `server/effort-api.ts` | New scoped aggregate assembly, memo cache, ETag |
| `server/path-indexer.ts` | Return changed sessions instead of a count |
| `server/collector.ts` | Schedule indexing off the request path; use `providerFromAgent` |
| `server/index.ts` | `/api/effort`, `/api/effort/sessions`, settings, delete endpoint; insights ETag |
| `server/insights.ts` | Effort facet, cohorts, Data summaries; use `providerFromAgent` |
| `server/session-detail.ts` | Add `effort` to the detail response |
| `src/types.ts` | `EffortSummary`, `EffortData`, digest, insight contract additions |
| `src/effort-model.ts` | New shared pure normalization, ordering, folding, decoding, capping |
| `src/provider.ts` | New single agent→provider mapper |
| `src/App.tsx` | Shrinks: view extraction, then effort hook/context wiring only |
| `src/views/dashboard.tsx`, `explorer.tsx`, `sessions.tsx`, `projects.tsx`, `models.tsx` | Extracted in Phase 0, effort UI added in Phase 3 |
| `src/views/data/facets.tsx` | Effort facet |
| `src/views/data/signals.tsx` | Reasoning-effort analysis section |
| `src/views/data/intelligence.tsx` | Effort data wiring and privacy/provenance controls |
| `src/styles.css` | Shared badges, stacks, coverage, responsive and accessible states |
| `README.md` | Accurate opt-in indexing and privacy boundary |
| `docs/ARCHITECTURE.md` | Observation-index collection, scheduling, and storage contracts |
| `CHANGELOG.md` | Feature entry plus the `providerFromAgent` behaviour fix |

---

## Verification

### Parser and storage tests (`server/effort-index.test.ts`)

- Codex: one effort, changed effort, model change, repeated token-count events,
  cumulative-vs-last usage, missing effort, missing token count, malformed line,
  incomplete final line, appended completion, file shrink, parser-version
  rebuild.
- Claude: one effort, changed effort, assistant event without effort, effort
  without usage, multiple assistant events, cache token fields, missing model,
  malformed and incomplete lines.
- **Byte-offset fidelity:** a fixture with multi-byte UTF-8 (emoji, CJK) split
  across a chunk boundary resumes at the correct byte and produces the same rows
  as a single-chunk read.
- **Prefilter equivalence:** parsing the fixture corpus with the prefilter
  disabled yields identical rows.
- **Idempotency:** re-running a completed pass writes nothing; interrupting a
  pass mid-file and resuming produces the same totals as an uninterrupted run;
  a forced rollback leaves the previous successful state intact.
- Incremental and clean rebuilds produce identical rows.
- Unknown future effort values round-trip without schema or UI failure.
- A single line over 4 MB is counted malformed and does not exhaust memory.
- SQLite scan asserts fixture prompt, response, reasoning, command, tool
  argument, and file-content sentinel strings are absent.
- Disable performs no file reads (assert via a stubbed reader); delete removes
  both tables and derived effort advice in one transaction and bumps
  `effortIndexVersion`.

### Aggregate tests (`server/effort-api.test.ts`, `src/effort-model.test.ts`)

- Known plus unknown tokens sum to the eligible total; same for turns.
- Attributed tokens above the ccusage total beyond the ratio tolerance set
  `degraded` and suppress shares; they are never clamped.
- Mixed sessions preserve every value and choose the documented dominant basis.
- Session sums reconcile with project, model, date, and total summaries under one
  scope.
- Unjoinable ccusage sessions land in `unjoinableSessions`, not in
  "no effort found".
- Missing `cwd`, model, timestamp, or effort reduces only the applicable
  breakdown's coverage.
- Provider, date, path, model-family, effort, cache, and outlier facets compose
  without unexpectedly changing the denominator.
- Data and Models report identical model-effort totals for identical scopes.
- Display capping to top *N* preserves the total: capped segments plus `Other`
  plus `Unknown` equal the uncapped sum.
- ETag changes when either `collectedAt` or `effortIndexVersion` changes, and a
  stale ETag never yields a 304.
- Payload-budget assertions on a generated worst-case fixture.

### UI tests

- Each view renders disabled, indexing, unavailable, partial, available, mixed,
  and unknown.
- Effort badges are searchable, sortable, keyboard-accessible, and not
  color-only.
- Dashboard and Explorer respond to range, provider, and path changes.
- Session, project, and model deep links preserve existing behaviour.
- Empty charts carry explanatory text rather than blank plotting areas.
- Narrow viewport, 150% Data text scale, reduced motion, and chart accessible
  names are verified.
- A dashboard poll with unchanged effort data triggers no effort re-render.

### Performance checks

Record before Phase 1, re-measure after Phase 3:

| Metric | Baseline | Target |
| --- | --- | --- |
| `/api/dashboard` duration and byte size | measure in Phase 0 | size unchanged; duration within noise |
| `data.db` size | 389 KB | ≤ 5 MB after full 934-session index |
| Full backfill, 1.07 GB / 918 files | n/a | completes unattended; no API request > 250 ms p99 during it |
| Refresh with no changed files | measure in Phase 0 | added parser work below measurement noise; zero SQLite writes |
| Active-file incremental parse | n/a | proportional to appended bytes, not file size |
| `/api/effort` | n/a | ≤ 120 KB, ≤ 50 ms warm (memo hit ≈ 0 ms) |
| `/api/effort/sessions` | n/a | ≤ 40 KB |

If the backfill misses the latency target, apply the pre-specified `Worker`
escape hatch rather than reducing the byte budget until the backfill takes hours.

---

## Acceptance criteria

- Dashboard, Explorer, Sessions, Projects, Models, and Data all show effort where
  supported and an explicit reason where they do not.
- A session that changes effort is never presented as if it used only one level.
- Every aggregate includes unknown activity and visible coverage.
- No effort value is inferred from model, provider, or token behaviour.
- Provider event token attribution is fixture-tested and reconciles across views.
- Opt-in, disable, delete, indexing, stale, and parser-error paths are complete.
- No raw transcript content is persisted or transmitted.
- Core tokens, costs, quotas, projects, models, and session detail continue to
  work with effort indexing disabled, mid-backfill, or failed.
- No request handler awaits transcript parsing.
- Byte offsets, additive upserts, and rebuilds are proven idempotent by test.
- Every effort payload is inside its asserted budget.
- Exactly one agent→provider mapper and one `foldEffort` exist in the codebase.
- `bun test`, `bun run typecheck`, and `bun run build` pass.
- The local app remains reachable after implementation work.

## Explicit non-goals

- Displaying chain-of-thought or reasoning text.
- Judging answer quality from effort.
- Recommending an effort level without outcome evidence.
- Inferring effort for historical rows that do not record it.
- Comparing Claude and Codex effort labels as if their semantics were guaranteed
  equivalent.
- Changing provider settings or the effort of a running session.
- Adding HTTP compression to a loopback server.
- Building the parser `Worker` before a measurement requires it.
