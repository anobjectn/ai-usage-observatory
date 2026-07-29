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
version; aggregate and session-digest ETags include both snapshot and index versions. Data's effort
facet also includes the index version in `/api/insights` because it selects whole sessions before
existing metrics are computed.

## Quota integration

[`quota-service`](https://github.com/anobjectn/quota-service) remains an optional, separate localhost dependency. The adapter reads `/usage`, `/resets`, and `/status`. It does not supply analytical cost, so two cost methodologies cannot appear for the same activity.
