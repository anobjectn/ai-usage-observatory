# Architecture and data contracts

## Boundary

The React frontend only consumes normalized local API responses. It never reads agent records or raw `ccusage` JSON directly.

## Collection flow

1. The server invokes the project-pinned `node_modules/.bin/ccusage` binary in offline mode.
2. Zod validates unified, block, and Claude project-instance reports.
3. The metadata-only path indexer incrementally reads session file heads when mtimes change.
4. Native report sessions are joined to indexed paths without copying transcript content.
5. Project activity groups joined session totals by provider, working directory, and local last-activity day. A session spanning multiple days is attributed to its latest activity day.
6. Path rules are evaluated on demand, so edits apply retroactively.
7. A successful in-memory snapshot replaces the prior one. A failure preserves the last success and marks it stale.
8. When the private effort index is enabled, the complete reconciled path catalog schedules an
   incremental byte scan after the snapshot succeeds. Requests never await transcript parsing.

## Stable session identity

```text
session_id = sha256(agent + NUL + source_file_relative_path + NUL + native_session_key)[0:24]
```

Agent and source path namespace native identifiers. The source path and key are taken from the agent record, not from mutable `ccusage` display ordering. If a future pinned ccusage version changes native session keys, an explicit compatibility map must be added before upgrade; unmapped rows must be surfaced in source health rather than silently orphaning annotations.

## Local storage

SQLite stores path rules, session working-directory metadata, manual annotations, settings, and
optional derived effort aggregates. Reports remain in memory and are recomputed on refresh. Raw
prompts and responses are never duplicated.

## Reasoning-effort index

The effort index is disabled by default. Enabling it builds a recent-first backlog from the full
current source catalog and then continues through older history. Each session stores a byte offset,
resume-boundary hash, parser version, active Codex attribution state, aggregate quality counters,
and grouped categorical/numeric usage. A span transaction advances the offset and aggregates
together, so interrupted work can resume without double-counting.

Claude assistant usage events and Codex turn contexts are observation boundaries. Codex token
events use `last_token_usage`; cached input remains a subset of input and reasoning output remains
a subset of output. Forked Codex parent history and repeated token events are de-duplicated to
match the pinned ccusage denominator. Malformed relevant records clear active attribution and
surface quality counters.

The database never stores prompt or response content, reasoning text, commands, tool payloads,
file contents, or transcript fragments. Disabling retains derived rows but excludes them from
analysis. Deleting derived observations disables indexing and removes only the two effort-derived
tables' contents.

Effort freshness is independent of `/api/dashboard`. Status polling watches the private index
version; aggregate, combo, and session-digest ETags include both snapshot and index versions.
Data's effort facet also includes the index version in `/api/insights` because it selects whole
sessions before existing metrics are computed.

## Model family x effort

The unit of comparison is the **combo**: `{ family, effort }`, where family comes from `familyOf()`
and effort is the provider-recorded label, normalized but never inferred. An effort value on its
own is not a decision unit — `Opus 5 · High` and `Sol · High` are different cohorts. `src/combo.ts`
owns the vocabulary (keys, labels, colours, facet encoding, series selection) and is shared by the
server and the client so a model can never be grouped one way in a chart and another in a filter.

`/api/effort/combo-days` returns day rows of family x effort buckets. Raw model variants collapse
to families in TypeScript, not SQL, and reconciliation stays **per day** against the existing
authoritative day total: there is no `(day, model)` denominator, so a multi-day session allocated
to its last-activity day cannot suppress otherwise-valid model cells. Days present only in the
denominator are returned as all-unknown coverage rather than disappearing.

`/api/effort/combos` is the scoreboard. Tokens, observations, appearances, and reasoning share are
combo-attributable. Median tokens, median cost, efficiency flag rate, and verdict are *whole-session*
statistics over the sessions a combo **uniquely led** — the single combo with strictly more
attributed tokens than every other. A tie is not broken alphabetically: those sessions contribute
volume to every combo present and outcomes to none. Comparative cells need five led sessions;
verdict rates need five ratings, counted separately. Automated, synthetic, and unrecorded-model
rows keep their volume and never receive comparative metrics. Flag rate comes from an untruncated
pass over the efficiency rules, not from the 80-item public findings array.

Reasoning share is `reasoningOutputTokens / outputTokens`, and is `null` when the provider reported
no reasoning events at all. A provider-reported zero stays zero; the two are distinguished by the
event count, never by the sum.

The session digest is version 2 and carries family and effort as separate indexes plus a per-session
combo bitmask, so the Sessions table can render, sort, search, and filter by dominant combo. "Mixed
effort" (two or more distinct efforts) and "multiple combos" are separate flags. The Data effort
facet is one field extended rather than duplicated: `all`, `mixed`, `unknown`, `value:<effort>`, and
`combo:<JSON tuple>`. A combo selection chooses **sessions**; those sessions keep every other combo
they recorded in each downstream metric.

## Session verdict

`verdict` is the user's own rating of a session (`good`, `mixed`, `bad`, or unrated). It is never
inferred from tokens, cost, effort, or any heuristic, and it is the only user-supplied signal in the
app. Annotation writes are field-preserving: `setAnnotationText()` cannot clear a verdict and
`setVerdict()` cannot clear tags or a note.

A verdict changes neither `collectedAt` nor the effort index version, so `annotation_meta.version`
is bumped in the same transaction as every write. The cached dashboard snapshot re-overlays
annotations when that revision changes — no ccusage recollection — and the revision is part of both
the dashboard ETag and the combo-scoreboard ETag.

## Quota integration

[`quota-service`](https://github.com/anobjectn/quota-service) remains an optional, separate localhost dependency. The adapter reads `/usage`, `/resets`, and `/status`. It does not supply analytical cost, so two cost methodologies cannot appear for the same activity.
