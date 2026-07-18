# Usage Observatory

A local-first mission control for understanding AI coding usage. It combines pinned `ccusage` analytics, metadata-only working-directory indexing, and optional provider quota data from `quota-service`.

## Start

Requirements: Bun 1.3 or newer.

```bash
bun install
bun run dev
```

Open `http://127.0.0.1:5173`.

For a production build:

```bash
bun run build
bun run start
```

Open `http://127.0.0.1:4318`.

## What ships in this first release

- Overview, Explorer, Sessions, Projects, Models, and Limits/source-health views.
- Daily, weekly, monthly, session, project-instance, and five-hour-block ingestion from pinned `ccusage@20.0.17`.
- Token composition and ccusage-sourced API-equivalent cost.
- Linked date, agent, and derived path filters.
- Tier 1 working-directory index for Claude Code and Codex session records.
- Glob and regex path rules, evaluated retroactively.
- Manual session tags and notes.
- Optional read-only `quota-service` integration at `http://127.0.0.1:8787`.
- Startup, 60-second, and manual refresh with last-success retention.
- A semantic dark Observatory theme with reduced-motion support.

## Data and privacy

The application binds to localhost and makes no analytics calls. `ccusage` runs in offline-pricing mode. The path indexer reads only the beginning of local session files to extract native session ID and working directory; it stores no prompt or response content. Application state is written to `.usage-observatory/data.db`, which is ignored by Git.

Set `USAGE_OBSERVATORY_DB` to use another database path. Set `QUOTA_SERVICE_URL` to point at a different quota-service instance.

## Methodology boundaries

- Historical cost: `ccusage` only.
- Provider allowance: optional `quota-service`, visibly labeled provider-reported.
- Five-hour block: locally reconstructed by `ccusage`; currently Claude Code-scoped.
- Personal budget: user-defined and not a billing limit.

## Verification

```bash
bun run typecheck
bun test
bun run build
```

## Deferred from the larger plan

The first release intentionally defers additional theme packs, wallpaper engines, git-aware worktree canonicalization, touched-file indexing, task classification, filesystem watching, a desktop wrapper, and native provider collectors.
