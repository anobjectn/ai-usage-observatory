# In-app fast-forward update — FINAL

Slug: in-app-update · Date: 2026-10-13
Author: Claude Opus 5.5 (1M context) (session default effort)
Based on: in-app-update-REVISED.md
Execution state: implemented on branch feat/in-app-update (2026-10-13)

## Changes from REVISED

User decisions (2026-10-13):

- **Apply is production-only.** `bun run dev` gets Check plus manual commands. `scripts/dev.ts`,
  Vite configuration ports, and the dev process tree stay unchanged. This removes the Vite
  stop/restart, the maintenance listener on `5173`, `strictPort`, and dev E2E from scope.
- **Schema guard warns; it does not refuse startup.** Developers switch between branches with
  different migrations; a fail-closed guard would block that workflow. Reason missed by REVISED.
- **Background check runs at most once per 24 h on page load**, so an available update takes one
  click.

Accepted from REVISED without change: Apply bound to a launcher-held `checkId` with a 10-minute
expiry; `git merge --ff-only --no-edit --no-autostash --no-overwrite-ignore` (flag verified on Git
2.54); post-merge reconciliation of HEAD and tree regardless of exit status; `gitState` instead of a
boolean; persisting the job before `202`; idempotent Apply per check; no staging `dist` directories
(the server is stopped during the build); strict update-route origin policy without an originless
exception; remote Apply opt-in; updater protocol number; recovery UI mounted before `App.tsx`
loading/error returns; true two-click flow without a panel-opening click; blocking shallow clones,
linked worktrees, sparse checkouts, and submodules; no `git reset` command in the UI; client polling
for the full job deadline; Bun native IPC (now simpler, because the production child has no
`--watch`).

Rejected or adjusted:

- Types go in `src/types.ts`, not `server/update/types.ts`: the server already imports
  `../src/types` (for example `server/app.ts:76`), and the frontend should not import server modules.
- Readiness must not wait on the snapshot or on effort indexing. An updated parser version can
  start a long reindex on first boot (project memory "PARSER_VERSION hazard"); readiness means
  "migrations ran and the HTTP listener answers", not "data refreshed". REVISED did not state this.

## 0. Facts

Verified by both passes at `7215d40`: F1–F12 of PLAN, with REVISED's corrections:

- `requestOriginAllowed` accepts any loopback Origin port but rejects `Sec-Fetch-Site: cross-site`.
  `/api/refresh` and other mutations do not call `readBody`, so JSON preflight is not a general
  protection. Update routes get their own stricter rule (§5).
- `server/index.ts` imports `app.ts`, which imports `store.ts`, which runs migrations at import.
  The readiness response therefore implies that migrations completed.
- `src/App.tsx` returns a loading or error screen before the sidebar renders.

Assumptions to probe in step 1:

- A1. `Bun.spawn({ ipc })` with `process.send` works between the launcher and
  `bun server/index.ts` on Bun 1.3.14.
- A2. `Bun.spawn` can put a child in its own process group (or the launcher can use
  `setsid`-equivalent spawning), so a deadline kill reaches `bun install` and `vite build`
  descendants. If not, kill the direct child and document that limit.
- A3. SSH can still prompt on `/dev/tty` when the launcher runs in a terminal; the fetch timeout
  bounds it.

## 1. Scope

Target: local `main` → freshly fetched `origin/main`. No automatic branch switch.

| Checkout | Result |
| --- | --- |
| `main`, upstream `origin/main` or none | Supported; UI shows the sanitized `origin` URL (forks follow their own `origin/main`) |
| `main`, upstream other than `origin/main` | `unsupported/upstream-mismatch` |
| Feature branch | `unsupported/not-main` — "Switch to `main` yourself to use in-app updates." |
| Detached HEAD | `unsupported/detached` |
| No `origin` | `unsupported/no-origin` |
| No `.git` (downloaded copy) | `unsupported/not-git` |
| No `git` executable | `unsupported/no-git` (the app still starts) |
| Shallow, linked worktree, sparse checkout, submodules | `unsupported/<reason>` |

Apply requires `bun run start` (the new launcher). Under `bun run dev` or `bun run start:server`,
Check works and an eligible result shows: "Run `git pull --ff-only && bun install`; the dev server
reloads" (dev) or "Restart with `bun run start` to update in the app" (unmanaged prod).

Exclusions: dev-mode Apply, automatic Apply, stash/rebase/merge updates, tags/releases as targets,
automatic rollback, Bun runtime upgrades, launcher self-replacement, protection against concurrent
manual Git or editor activity beyond drift detection.

## 2. Check

Order (first blocker wins; relationship is still reported when known):

1. Repo root from `import.meta.dir` (verified with `git rev-parse --show-toplevel`); unsupported
   reasons from §1.
2. `git-busy`: `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
   `BISECT_LOG`, `index.lock`, resolved via `git rev-parse --git-path`.
3. `git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main` (§4.6). Failure →
   `failed` with `auth | network | timeout | git-error`.
4. `git rev-list --left-right --count HEAD...refs/remotes/origin/main` → `equal | ahead | behind |
   diverged`.
5. `dirty`: `git status --porcelain=v2 -z --untracked-files=no` non-empty (reported for every
   relationship; blocks only `behind`).
6. `collision` (only `behind`): incoming paths from `git diff -z --name-only --diff-filter=ACRT
   HEAD <target>`, plus their parent directories, intersected with untracked and ignored paths
   (`git ls-files -z --others [--ignored] --exclude-standard`), including file/directory
   replacements. Any incoming path under `.usage-observatory/`, `node_modules/`, or equal to
   `.env.local` or the resolved DB path also blocks.
7. Re-read branch and HEAD; drift → `failed/stale-check`.

`UpdateCheck` (in `src/types.ts`):
`{ id, checkedAt, expiresAt, branch, upstream, remoteDisplay, head, target, relationship, state,
eligible, ahead, behind, blockers: string[], paths: string[] (≤10), currentVersion, targetVersion,
incomingCommits: {sha, subject}[] (≤20), dependenciesChanged, migrationsChanged, launcherChanged,
protocolCompatible }`.

`targetVersion` and `updaterProtocol` come from `git show <target>:package.json`. Only a clean,
collision-free, protocol-compatible `behind` is `eligible`.

Owner: in managed prod the launcher runs Check and keeps the latest result (memory only; invalid
after a launcher restart). Unmanaged servers run the same `server/update/git.ts` code locally and
never accept Apply. Both are single-flight.

## 3. Process model (production)

New `scripts/launcher.ts`, non-watched, used by `bun run start`:

- Spawns `[process.execPath, "server/index.ts"]` directly with `cwd` = repo root, `ipc` handler, and
  env `USAGE_OBSERVATORY_MANAGED=1` plus a per-start `bootId`. Stops only that child (and its
  group if A2 holds); SIGTERM, 10 s, then SIGKILL.
- Holds `.usage-observatory/launcher.lock` (`{pid, nonce, root}`, exclusive create). A live owner →
  refuse to start. A dead PID → report and require manual removal; no automatic stale cleanup.
- Imports all updater modules at startup; never imports updated updater code during a job.
- On an unexpected child exit outside a job: stop and exit, as today.
- During a job, after stopping the server, binds a **maintenance server** on `127.0.0.1:<PORT>`
  (`server/update/maintenance.ts`, no imports of `store.ts`, collectors, React, or `node_modules`):
  `GET /api/update/status`, `POST /api/update/retry`, `503 {error:"updating"}` JSON for other
  `/api/*`, and a self-refreshing HTML status page for other GETs. It applies the same host and
  update-origin policy. If binding fails, the job stops before Git changes and the old server is
  restarted.
- Releases the maintenance listener before spawning the new server. A port still occupied by
  another process is a job failure; never kill it.

IPC protocol (`server/update/ipc.ts`): `{ v: 1, id, type: "status" | "check" | "apply" |
"retry", body }` → `{ id, ok, status, body }`, 10 s request deadline except `check` (90 s). The
backend's `/api/update/*` handlers forward to it when `process.send` exists and the env flag is set.

`package.json`: `start` → `bun run scripts/launcher.ts`; add `start:server` →
`bun run server/index.ts`; add `"updaterProtocol": 1`. `dev` and `scripts/dev.ts` unchanged.

## 4. Job lifecycle

### 4.1 State

`validating → stopping → backing-up → applying → installing → building → starting → verifying →
complete | failed`.

`UpdateJob`: `{ id, checkId, from, target, phase, failedPhase?, gitState: "unchanged" | "target" |
"unexpected" | "unknown", installComplete, buildComplete, startupAttempted, backupPath?,
launcherRestartRequired, startedAt, updatedAt, finishedAt?, failure?: {code, message, logTail},
retryable }`.

Persisted atomically (tmp + rename, `version: 1`) to `.usage-observatory/update-job.json` before and
after each consequential step. Logs: `.usage-observatory/update-logs/<jobId>.log`, credential
redacted, last 5 kept. On launcher start, a non-terminal job becomes `failed/interrupted`; HEAD is
reconciled into `gitState`; nothing resumes automatically.

### 4.2 Steps

1. **validating** — `checkId` must name the launcher's current eligible check, unexpired. Recheck
   branch, HEAD, remote URL, ancestry (target descends from HEAD and is still reachable from the
   cached `refs/remotes/origin/main`), Git markers, tracked tree, collisions, target protocol. No
   new fetch. Persist the job, then return `202`. Same `checkId` again → same job.
2. **stopping** — stop the server child; confirm exit; bind maintenance.
3. **backing-up** — resolve the DB path via `server/db-path.ts` (absolute; honors
   `USAGE_OBSERVATORY_DB`). If the file exists: open with `bun:sqlite` (no migrations),
   `VACUUM INTO .usage-observatory/backups/pre-update-<from7>-<timestamp>.db`, run
   `PRAGMA integrity_check` on the copy, close. Keep the 3 newest `pre-update-*` files, never one
   referenced by an unresolved failed job. Failure → stop before Git; restart old server.
4. **applying** — revalidate (step 1 checks), then
   `git merge --ff-only --no-edit --no-autostash --no-overwrite-ignore <target>` (30 s). Then,
   regardless of exit status, reconcile: `HEAD == target` and tree clean → `target`;
   `HEAD == from` and clean → `unchanged` (restart old server, report); otherwise `unexpected`.
   A timeout whose reconciliation cannot run → `unknown`.
5. **installing** — `bun install --frozen-lockfile` with `process.execPath` (5 min).
6. **building** — `vite build` through `<root>/node_modules/vite/bin/vite.js` run by Bun (5 min);
   `vite.config.ts` writes `dist/build-info.json` `{ commit }` from `git rev-parse HEAD`. The old
   `dist` is replaced in place; the server is down.
7. **starting** — release maintenance; spawn a new server with a new `bootId`.
8. **verifying** — poll `GET /api/update/version` on loopback (90 s) for
   `{ commit: target, bootId, pid: child.pid, protocol }`, and `dist/build-info.json.commit ==
   target`; recheck HEAD and tree. Only then `complete`. Child exit or timeout → `failed`, re-bind
   maintenance, keep the last 40 stderr lines.

Total deadline shown to the client: 15 min.

### 4.3 Retry and recovery

- `gitState: "unchanged"` failures: the old server is already restarted; the UI offers Check again.
- `gitState: "target"`: maintenance stays up. Retry runs the earliest unfinished step
  (`installComplete` → `buildComplete` → start/verify), only if HEAD == target, tree clean, no Git
  operation, port free. No new backup.
- `unexpected | unknown`: no Retry; the UI points to the README recovery section.
- No rollback button. README documents manual recovery: stop the launcher; `git switch main`;
  `git reset --keep <from>`; `bun install --frozen-lockfile`; `bun run build`; to restore data,
  replace `data.db` with the backup and delete `data.db-wal` and `data.db-shm` while nothing runs;
  writes after the backup are lost.
- Schema guard (warn only): `runMigrations` returns `{ schemaAhead }` when `user_version` exceeds
  the highest known id; `store.ts` logs it; `/api/update/status` exposes it with the newest
  `pre-update-*` backup path; the UI shows a banner. Startup continues.

### 4.4 Browser

- Poll `status` every 1 s during a job; on network errors back off to 3 s and show
  "Restarting — reconnecting"; keep polling for the 15-minute deadline; "Lost contact" never means
  failed.
- A lost `202` is recovered from `status.job`. A tab reload mid-job resumes from `status`; the
  maintenance page uses the same contract.
- On `complete`, reload once (job id in `sessionStorage`). After load, compare `__APP_COMMIT__`
  (Vite `define`) with `running.commit`; on mismatch show "Reload to finish" without auto-looping.

### 4.5 Concurrency

One launcher per checkout (lock file), one job at a time. Check and Apply during a job → `409`.
Revalidate before merge, after merge, before build, and before completion; drift stops the job.
This is not transactional against external Git commands; that is stated in README.

### 4.6 Commands

- Fixed argv, no shell; `cwd` = repo root; request inputs are only `checkId`/`jobId`
  (UUID-validated).
- Env: inherit, set `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`,
  `LC_ALL=C`, `NO_COLOR=1`; `stdin: "ignore"`. If neither `GIT_SSH_COMMAND` nor `core.sshCommand`
  is set, set `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15"` (SSH aliases in
  `~/.ssh/config` still apply). Otherwise leave it and rely on the deadline.
- Deadlines: local Git 15 s, fetch 60 s, merge 30 s, install 5 min, build 5 min, readiness 90 s.
- `server/subprocess.ts`: add `runCommand(command, { timeoutMs, cwd, env, onOutput, maxOutput })`
  while keeping `runCommand(command, timeoutMs)`; neutral error text; bounded output.

## 5. Security

Update POSTs (`check`, `apply`, `retry`), in both backend and maintenance:

- `Content-Type: application/json`, schema-validated body, header `X-Observatory-Action: update`.
- `Origin` required and exactly one of `http://127.0.0.1:<PORT>`, `http://localhost:<PORT>`,
  `http://127.0.0.1:5173`, `http://localhost:5173`, or `https://<allowed host>`. `null`, malformed,
  and `Sec-Fetch-Site: cross-site` are rejected. No CORS headers.
- `apply`/`retry` from a non-loopback Origin → `403 remote-apply-disabled` unless
  `USAGE_OBSERVATORY_REMOTE_UPDATES=1`. README states this is browser policy inside a trusted
  tailnet, not authentication, and keeps the Funnel prohibition.
- The background check runs only from a loopback origin.

## 6. API

All responses `Cache-Control: no-store`.

- `GET /api/update/status` → `{ managed, mode: "prod" | "dev" | "unmanaged", canApply,
  blockingReason, running: { commit, version, bootId, startedAt }, check, job, schemaAhead,
  backupPath, autoCheckDue, launcherRestartRequired }`. No snapshot dependency.
- `POST /api/update/check` `{}` → `200 UpdateCheck` (failed fetch is a `200` with
  `state: "failed"`); `409 job-active`.
- `POST /api/update/apply` `{ checkId }` → `202 { job }`; `400`; `403`; `409 stale | busy`;
  `422 ineligible`; `503 unmanaged` with manual commands.
- `POST /api/update/retry` `{ jobId }` → `202 { job }`; `403`; `409 not-retryable`.
- `GET /api/update/version` → `{ commit, version, pid, bootId, protocol, startedAt }`
  (loopback Host only).

`running.commit` is read once at boot in `server/update/version.ts` (`git rev-parse HEAD`,
15 s, `null` on failure). `autoCheckDue` uses `.usage-observatory/update-check-at` (timestamp only).

## 7. UI

One sidebar button next to the version (`App.tsx:561` area), outside the brand link, with a
details popover that never starts an update:

- Label `Check for updates` → click runs Check and opens details.
- Eligible + managed → label `Update and restart` → click starts Apply (no confirmation dialog).
  With a due background check this is the only click.
- Badge on the version when `behind`.
- Detail states: checking; up to date; ahead; diverged; dirty (≤10 paths); collision (paths);
  git busy; unsupported (reason text from §1); failed check (Check again); behind but dev/unmanaged
  (manual commands); behind but remote-restricted; updating (phase, elapsed); reconnecting;
  failed job (phase, `gitState` sentence, log tail, backup path, Retry if `retryable`, README link);
  complete (one reload); `schemaAhead` banner.
- `useUpdate` hook mounts in `App.tsx` before the dashboard loading/error returns, so recovery
  works when `/api/dashboard` fails. `aria-live="polite"` for status; focus stays on the button.

## 8. Files

Add:

- `scripts/launcher.ts` — production supervisor, lock, IPC, job runner entry, maintenance binding.
- `server/update/git.ts` — checks, collisions, revalidation, reconciliation, Git env.
- `server/update/job.ts` — phases, persistence, backup, install/build/start/verify; injectable
  command runner.
- `server/update/ipc.ts` — IPC request/response and deadlines.
- `server/update/routes.ts` — `/api/update/*` handlers (forward or local check).
- `server/update/maintenance.ts` — dependency-free handlers and HTML page.
- `server/update/version.ts` — boot commit, `bootId`, protocol.
- `server/db-path.ts` — absolute DB path resolution.
- `src/hooks/use-update.ts`, `src/components/update-control.tsx`.
- `server/update/test-fixtures.ts` and the tests in §10.

Change:

- `package.json` — `start`, `start:server`, `updaterProtocol`.
- `server/app.ts` — route `/api/update/*` before snapshot-dependent routes.
- `server/request-host.ts` — `requestUpdateOriginAllowed`, `requestOriginIsRemote`.
- `server/subprocess.ts` — options overload.
- `server/store.ts` — use `db-path.ts`; log `schemaAhead`.
- `server/migrations.ts` — return `{ schemaAhead }`.
- `server/index.ts` — initialize `version.ts` boot identity.
- `vite.config.ts` — `define.__APP_COMMIT__`; plugin that writes `dist/build-info.json`.
- `src/vite-env.d.ts`, `src/types.ts`, `src/App.tsx`, `src/styles/chrome.css`.
- `scripts/test-browser.ts`, `tests/browser/runner.tsx` — mocked update scenarios.
- `README.md`, `docs/ARCHITECTURE.md` — start command change, updates, remote opt-in, recovery.

## 9. Ordered steps

1. Probe A1 and A2 with a throwaway script in `_temp/`. If IPC fails, fall back to a 0600 Unix
   socket with a per-start token; stop and report if neither works.
2. `db-path.ts`, `migrations.ts` `schemaAhead`, `subprocess.ts` options (+ tests). Existing tests
   must stay green.
3. `server/update/git.ts` + temp-repo tests.
4. `request-host.ts` update origin policy + tests.
5. `version.ts`, `job.ts` with injected runner + tests; backup tests on fixture DBs.
6. `maintenance.ts`, `ipc.ts`, `scripts/launcher.ts`.
7. `routes.ts`, `app.ts`, `index.ts`, `package.json` wiring + route tests.
8. `vite.config.ts` define and build stamp; UI hook and control; browser-runner scenarios.
9. Real-process E2E in a temporary clone (§10).
10. Docs; `bun run typecheck`, `bun test`, `bun run build`.

The user's `bun run dev` instance (5173/4318) stays running throughout. All E2E runs use a temporary
clone, a fixture DB, and a free `PORT`. Report the final local URL and that the app was preserved.

## 10. Tests and acceptance

Fixtures: bare `origin.git` + clones in `mkdtemp`; helpers for commit, push, force-push, branch,
detach, shallow, worktree, dirty, untracked/ignored files, merge-in-progress, `index.lock`.

`server/update/git.test.ts`: every state and reason in §1–§2; missing upstream allowed; mismatch
blocked; untracked and ignored collisions including directory replacement and names with spaces and
newlines; protected paths; fake `GIT_SSH_COMMAND` scripts for auth failure ("Permission denied",
exit 255), network failure, and a sleeper for timeout within the deadline.

`server/update/job.test.ts`: exact checked target applied after origin advances again; force-push
seen by a later Check makes the old `checkId` stale; HEAD/branch/tree drift between check and apply;
`index.lock` injected just before merge → `gitState: unchanged`; merge timeout reconciliation;
persistence at each step; crash after merge → `interrupted` with `gitState: target`; retry
prerequisites; noncolliding untracked files, `.env.local`, and `.usage-observatory/` survive.

`server/update/backup.test.ts`: WAL-mode fixture DB with uncheckpointed rows → backup contains them
and passes `integrity_check`; relative and absolute `USAGE_OBSERVATORY_DB`; no migration runs;
retention keeps 3 and keeps referenced backups. `server/migrations.test.ts`: higher `user_version`
→ `schemaAhead: true`, no throw.

`server/update/routes.test.ts` and `server/request-host.test.ts`: `localhost:3000` origin rejected;
missing Origin rejected for update POSTs; missing custom header rejected; ts.net origin may check,
may not apply without opt-in; `503` unmanaged; `409` during a job; idempotent apply by `checkId`.

`server/update/launcher.e2e.test.ts` (gated by `USAGE_OBSERVATORY_E2E=1`): temporary clone of this
repo's `HEAD` plus a fixture commit on a local bare origin; real launcher on a free `PORT` with a
fixture DB; real `bun install --frozen-lockfile` and `vite build`; Check → Apply → `complete`,
new PID, `version.commit == target`, `build-info.json` matches, maintenance answered `status` while
the server was down. Failure cases:

- Startup failure: the target's server exits on start while a fixture flag file exists →
  `failed` at `verifying`, `gitState: target`; delete the flag file, Retry → `complete`.
- Occupied port at `starting` → `failed`, the occupying process is untouched.
- Install failure: the target commits a `package.json` that disagrees with `bun.lock` →
  `failed/installing`, maintenance answers `status`, no completion.

A sentinel process started by the test survives every case.

Browser runner: mocked `status` sequences for every UI state, reload-once behavior, and recovery
when `/api/dashboard` fails.

Acceptance:

- Clean `main` behind `origin/main` under `bun run start`: Check → Update and restart (or one click
  after a background check) ends with the page reloaded and `running.commit == build commit ==
  checked target`.
- Every blocked state shows a specific reason and leaves HEAD unchanged.
- A job never reports `complete` after Git, install, or build alone.
- Only launcher-owned PIDs are signalled.
- `bun run typecheck`, `bun test`, `bun run build` pass.

## 11. Remaining decisions, risks, trade-offs

- `bun run start` now runs the launcher; anyone who scripted `start` gets the supervisor. Use
  `start:server` for the old behavior.
- Downtime equals backup + install + build + startup; it can exceed a minute. The maintenance page
  covers it.
- `bun install` and startup run code from the target commit; the trust level equals a manual
  `git pull && bun install`.
- The launcher cannot update itself; `launcherChanged` targets report one manual restart, and an
  incompatible `updaterProtocol` blocks Apply.
- A3: an SSH passphrase prompt may appear on the launcher's terminal until the fetch deadline.
- Backups enable manual recovery only; there is no automatic rollback.
- External Git activity during a job is detected, not prevented.
- The user's own checkout is on a feature branch and runs `bun run dev`, so they will see
  `unsupported/not-main` there; this is intended.
- Deferred: dev-mode Apply, configured-upstream targets, a permanent launcher proxy to remove the
  port handoff gap.

## Execution recommendation

1. **Best agent recommendation — single-model execution.** Anthropic: Opus 5.5, high effort.
   OpenAI: Sol 6.1, high effort. The production-only scope removes the dev restart path, so a
   top-tier frontier model (Fable 5.1, Astra) is not needed; the remaining risk is concentrated in
   coupled Git reconciliation, job persistence, and process ownership, which favor one owner over
   parallel agents. Drop to medium effort for steps 8 and 10 (UI and docs). Long phases: step 1
   probes and step 9 E2E (real install and build per case). Safe handoffs: after step 3 (Git
   fixtures green), after step 7 (routes wired, unit suites green), after step 9.
2. **Quota-sensitive recommendation.** Anthropic: Sonnet 5.5 high for steps 2–4 and 8–10, Opus 5.5
   high for steps 1, 5–7 and a final review of `job.ts`/`launcher.ts`. OpenAI: Terra high for steps
   2–4 and 8–10, Sol 6.1 high for steps 1 and 5–7. Haiku 5.5 or Luna can write the browser-runner
   mock scenarios and README text after the contracts are fixed.
