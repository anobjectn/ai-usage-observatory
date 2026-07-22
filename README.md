# AI Usage Observatory

A local-first dashboard for understanding how you actually use AI coding tools.

It answers the questions your provider's billing page does not: where the tokens
went, which projects consumed them, how model choice shifted over time, and how
close you are to the end of the current allowance window. Everything is computed
on your machine from data that is already there.

Three sources feed it: pinned [`ccusage`](https://github.com/ccusage/ccusage)
analytics for tokens and API-equivalent cost, metadata-only indexing of local
Claude Code and Codex session files for project attribution, and an optional
[`quota-service`](https://github.com/anobjectn/quota-service) instance for
provider-reported allowance windows.

## Screenshots

![Overview dashboard with subscription windows and usage trajectory](docs/screenshots/1.dashboard.png)

![Usage explorer with provider activity and model distribution](docs/screenshots/2.explorer.png)

![Session ledger with transcript, tool, and patch details](docs/screenshots/3.sessions.png)

![Project cartography with daily signal, model mix, and diff trail](docs/screenshots/4.projects.png)

![Model mix and efficiency comparison](docs/screenshots/5.models.png)

![Data provenance with source separation and data source health](docs/screenshots/6.data-provenance.png)

![Appearance settings for signal colors, text size, and scene effects](docs/screenshots/7.appearance.png)

## Getting started

Requires Bun 1.3 or newer.

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

## What you get

- Six views — Overview, Explorer, Sessions, Projects, Models, and Sources — that
  share one filter state, so narrowing a date range or an agent narrows all of them.
- Usage rolled up daily, weekly, monthly, per session, per project instance, and
  per five-hour block, ingested from pinned `ccusage@20.0.17`.
- Token composition alongside `ccusage`-derived API-equivalent cost.
- Cross-provider project attribution built from session working directories,
  broken out by model.
- Glob and regex path rules that apply retroactively to everything already indexed.
- Session tags and notes you write yourself.
- Optional [`quota-service`](https://github.com/anobjectn/quota-service) integration
  at `http://127.0.0.1:8787`, read-only.
- Refresh on startup, every 60 seconds, and on demand, keeping the last successful
  result if a refresh fails.
- A dark Observatory theme that honors reduced-motion preferences.

## Data and privacy

Nothing leaves your machine, and there is no new cloud login or service to sign up
for. The server binds to localhost, sends no analytics, and runs `ccusage` in
offline-pricing mode.

Indexing is metadata-only: the path indexer reads just the opening bytes of each
session file, enough to recover the native session ID and working directory.

Session detail is the one place your own prompts appear. When you open a session,
the server reads that file on demand and returns the most recent user prompts so
you can tell one session from another. Nothing from that read is written to the
database or sent anywhere — it goes to your browser on localhost and is gone on the
next request. Application state lives in `.usage-observatory/data.db`, which Git
ignores.

Set `USAGE_OBSERVATORY_DB` to relocate the database, or `QUOTA_SERVICE_URL` to
point at a different [`quota-service`](https://github.com/anobjectn/quota-service).

## Sources and credit

- [ccusage](https://github.com/ccusage/ccusage) v20.0.17 by ryoppippi (MIT) supplies
  the usage analytics and offline API-equivalent price estimates.
- Local Claude Code and Codex session files supply session identifiers and
  working-directory metadata during indexing, plus recent prompts read on demand
  when you open a single session.
- [`quota-service`](https://github.com/anobjectn/quota-service) optionally supplies
  provider-reported allowance windows, resets, and status. It is a separate
  localhost service, not a bundled dependency.

## What the numbers mean

- Historical cost comes from `ccusage` and nowhere else.
- Allowance figures come from the optional
  [`quota-service`](https://github.com/anobjectn/quota-service) and are labeled in
  the UI as provider-reported.
- Five-hour blocks are reconstructed locally by `ccusage` and currently cover
  Claude Code only.
- A personal budget is a number you set for yourself. It is not a billing limit and
  does not stop anything.


## About [`quota-service`](https://github.com/anobjectn/quota-service) 

The recommended setup is to clone [`quota-service`](https://github.com/anobjectn/quota-service)
and run it alongside this project. It takes a couple of minutes.

Without it, everything still works — tokens, costs, sessions, projects, and local
activity blocks are all `ccusage`-derived. You simply lose the provider allowance
cards. This project ships no provider collector of its own.

## Bringing your own quota service

Prefer a different implementation? Point `QUOTA_SERVICE_URL` at its base URL. AI
Usage Observatory only reads from it: three concurrent `GET` requests to `/usage`,
`/resets`, and `/status`, each with a four-second timeout. All three must return a
successful JSON response for the quota source to count as available. `/status` feeds
source-health reporting and may return any JSON value.

`/usage` must return an object with `generatedAt` (a number) and `providers` (an array). Each provider has a `provider` value of `anthropic`, `codex`, or `warp`; a `status` of `ok`, `stale`, `unavailable`, or `unknown`; a nullable `source`; and a nullable `snapshot`. `error` is optional. A window snapshot supports Anthropic and Codex allowance windows; a pool snapshot supports Warp-style request pools:

```json
{
  "generatedAt": 1763894400000,
  "providers": [
    {
      "provider": "anthropic",
      "status": "ok",
      "source": "my-collector",
      "snapshot": {
        "kind": "window",
        "fiveHour": { "usedPercent": 36, "resetsAt": 1763912400000 },
        "weekly": { "usedPercent": 12, "resetsAt": 1764499200000 },
        "modelWindows": {
          "example-model": { "usedPercent": 18, "resetsAt": 1763912400000 }
        }
      }
    },
    {
      "provider": "warp",
      "status": "ok",
      "source": "my-collector",
      "snapshot": {
        "kind": "pool",
        "pool": {
          "used": 42,
          "limit": 100,
          "usedPercent": 42,
          "refreshesAt": 1767225600000,
          "cadence": "Monthly"
        }
      }
    }
  ]
}
```

Window fields `fiveHour` and `weekly` may be `null`; `modelWindows` is optional. Every window uses a numeric `usedPercent` and a Unix-millisecond `resetsAt` (or `null`). A pool uses numeric `used`, `limit`, and `usedPercent`, a Unix-millisecond `refreshesAt` (or `null`), and an optional `cadence` label.

`/resets` may return an empty object when you do not provide banked Codex reset credits. When provided, use this shape:

```json
{
  "codexBankedResetCredits": {
    "availableCount": 1,
    "totalEarnedCount": 3,
    "status": "ok",
    "credits": [
      {
        "id": "credit-123",
        "title": "Extra reset",
        "status": "available",
        "expiresAt": "2026-12-31T00:00:00.000Z"
      }
    ]
  }
}
```

The dashboard uses `available` credits for the visible banked-reset list. It does not require a particular `status` string for individual credits, and `expiresAt` may be `null`.

The optional local history summary (observed quota reaches and consumed reset credits) is specific to quota-service's SQLite database. For each 5-hour and weekly allowance, it retains the first local observation for every full quota cycle and lists all observed-at-limit times alongside the total. It is not part of the HTTP replacement contract. It remains unavailable for another service unless it also provides a compatible database through `QUOTA_DB_PATH`.

## Not here yet

Deliberately out of scope for now: additional theme packs, wallpaper engines,
git-aware worktree canonicalization, touched-file indexing, task classification,
filesystem watching, a desktop wrapper, and native provider collectors.
