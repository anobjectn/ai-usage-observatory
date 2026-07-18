# Architecture and data contracts

## Boundary

The React frontend only consumes normalized local API responses. It never reads agent records or raw `ccusage` JSON directly.

## Collection flow

1. The server invokes the project-pinned `node_modules/.bin/ccusage` binary in offline mode.
2. Zod validates unified, block, and Claude project-instance reports.
3. The metadata-only path indexer incrementally reads session file heads when mtimes change.
4. Native report sessions are joined to indexed paths without copying transcript content.
5. Project activity groups joined session totals by provider, working directory, and local last-activity day. A session spanning multiple days is attributed to its latest activity day.
5. Path rules are evaluated on demand, so edits apply retroactively.
6. A successful in-memory snapshot replaces the prior one. A failure preserves the last success and marks it stale.

## Stable session identity

```text
session_id = sha256(agent + NUL + source_file_relative_path + NUL + native_session_key)[0:24]
```

Agent and source path namespace native identifiers. The source path and key are taken from the agent record, not from mutable `ccusage` display ordering. If a future pinned ccusage version changes native session keys, an explicit compatibility map must be added before upgrade; unmapped rows must be surfaced in source health rather than silently orphaning annotations.

## Local storage

SQLite stores path rules, session working-directory metadata, manual annotations, and settings. Reports remain in memory and are recomputed on refresh. Raw prompts and responses are never duplicated.

## Quota integration

`quota-service` remains an optional, separate localhost dependency. The adapter reads `/usage`, `/resets`, and `/status`. It does not supply analytical cost, so two cost methodologies cannot appear for the same activity.
