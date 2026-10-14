# In-app fast-forward update — PLAN

Slug: in-app-update · Date: 2026-10-13
Author: Claude Opus 5.5 (1M context) (session default effort)

## 0. Inspected facts and assumptions

Facts from the code at `7215d40` (branch `fix/review-data-freshness`):

- F1. `scripts/dev.ts` spawns `bun run dev:server` and `bun run dev:client` through `bun run`
  wrappers. It kills both when either exits. It has no restart or IPC capability. The live
  process tree shows the wrappers: Vite runs as `node …/node_modules/.bin/vite` (PID 91982, parent
  91980), and the server as `bun --watch server/index.ts` (PID 91983, parent 91979). `process.kill()`
  on a wrapper is not guaranteed to reach the grandchild.
- F2. `bun run start` is `bun run server/index.ts` with no launcher. Nothing can restart it.
- F3. `server/index.ts` binds `127.0.0.1:${PORT ?? 4318}`. Remote access is only via
  `tailscale serve` reverse proxy plus `USAGE_OBSERVATORY_ALLOWED_HOSTS` (README lines 48–73).
- F4. `server/app.ts` serves `dist/` from `process.cwd()` per request. Routes before line 207 do not
  wait for a snapshot.
- F5. `requestOriginAllowed` accepts any loopback Origin on any port (`http://localhost:3000` is
  accepted for a POST to `:4318`). `readBody` requires `application/json`, which forces a CORS
  preflight that the server never answers, so browser CSRF from another local origin is blocked
  only indirectly.
- F6. Vite proxies `/api` with `changeOrigin: true`: the Host header becomes `127.0.0.1:4318`, the
  Origin header stays the browser's origin.
- F7. `server/store.ts` resolves the DB path at import time
  (`USAGE_OBSERVATORY_DB` or `<cwd>/.usage-observatory/data.db`) and runs migrations on import.
  `runMigrations` skips ids `<= user_version` and never detects a database newer than the code.
  The live DB is ~25 MB plus WAL. `.usage-observatory/backups/` already exists.
- F8. `.gitignore` covers `node_modules/`, `dist/`, `.usage-observatory/`, `.env.local`, `_temp/`.
- F9. `server/subprocess.ts` `runCommand` has a timeout and SIGKILL, but no `cwd`, no env control,
  no streaming, and error text says "Collection command".
- F10. `src/App.tsx:561` shows `v{appVersion}` from `package.json`, bundled at build time.
- F11. `server/session-detail.ts` uses a dynamic `import()`. A running server that sees new files on
  disk can load new code lazily.
- F12. Local `main` is 15 commits behind `origin/main`; the working checkout is on a feature branch.
  Bun 1.3.14, Git 2.54.

Assumptions (unverified, flagged for the executor):

- A1. `Bun.serve({ unix })` and `fetch(url, { unix })` work on macOS in Bun 1.3.14.
- A2. Bun's `--watch` restart keeps the environment variables of the original spawn.
- A3. A Git child spawned without a TTY still can open `/dev/tty` for an SSH passphrase prompt when
  the launcher runs in a terminal. Mitigation in §4.6 does not depend on this being false.
- A4. One launcher per checkout. Two launchers on different `PORT` values are possible but
  unsupported; a lock file rejects the second one.

## 1. Recommended scope

Policy: **update only local `main` to `origin/main`**, and only when the app runs under the managed
launcher (new `scripts/launcher.ts`, used by both `bun run dev` and `bun run start`).

Why not "follow the configured upstream": a feature branch's upstream is often rebased
(force-pushed), which turns updates into "diverged" noise; an upstream on another remote silently
changes what "update the app" means; and the release flow (`docs/RELEASING.md`) publishes on
`main`. The configured upstream adds generality nobody needs for a release updater.

How other checkouts appear (Check still runs; Update is never offered):

| Checkout | State | UI text (summary) |
| --- | --- | --- |
| Feature branch `x` | `unsupported` / `not-main` | "On branch `x`. In-app updates follow `main` only. Switch to `main` yourself to use them." |
| `main` without `origin` remote | `unsupported` / `no-origin` | "No `origin` remote." |
| `main` whose upstream is not `origin/main` | `unsupported` / `upstream-mismatch` | Shows the configured upstream. |
| `main` with no upstream configured | allowed | Target is still `origin/main`; UI notes "no upstream configured". |
| Detached HEAD | `unsupported` / `detached` | Shows short SHA. |
| Fork | allowed | Target is the fork's `origin/main`; UI shows the sanitized `origin` URL so the user sees what it follows. |
| Downloaded ZIP (no `.git`) | `unsupported` / `not-git` | "Not a Git checkout. Download a new release." |
| Shallow clone | allowed if ancestry resolves, else `failed`. |
| Linked worktree / submodules / sparse checkout | allowed only if checks pass; no special handling. |

No automatic branch switch, ever.

Exclusions: tags/releases as targets, non-`origin` remotes, rebase or merge updates, stash-and-update,
automatic rollback, self-update of the launcher process, auto-update without a click, updating
when the server runs without the launcher (shows manual commands instead).

## 2. Eligibility states (check result)

Evaluation order; first match wins:

1. `unsupported` — reason ∈ `not-git`, `detached`, `not-main`, `no-origin`, `upstream-mismatch`.
2. `git-busy` — any of `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`,
   `REVERT_HEAD`, `BISECT_LOG`, `index.lock` exists (paths via `git rev-parse --git-path`, so linked
   worktrees work).
3. Fetch `origin +refs/heads/main:refs/remotes/origin/main` (§4.6). Failure → `failed` with reason
   `auth`, `network`, `timeout`, or `git-error` (classified from stderr), plus the stderr tail with
   URLs credential-stripped.
4. `git rev-list --left-right --count HEAD...<target>`: `equal` (0/0), `ahead` (n/0), `diverged`
   (n/m), otherwise `behind`.
5. Only for `behind`: `dirty` if `git status --porcelain=v2 --untracked-files=no` has entries
   (staged or unstaged tracked changes). Then `collision` if incoming added/renamed paths
   (`git diff --name-only --diff-filter=AR HEAD <target>`) intersect untracked files
   (`git ls-files --others --exclude-standard`) **or ignored files**
   (`git ls-files --others --ignored --exclude-standard --directory`). Git refuses to overwrite
   untracked files but silently overwrites ignored ones; both block.
6. Otherwise `behind` (fast-forwardable).

`equal`/`ahead` with a dirty tree report their state plus a `dirty` flag (informational).

Check result also carries: `head`, `target` (full SHAs), `behind`, `ahead`, up to 20 incoming
`{sha, subject}`, `targetVersion` (`git show <target>:package.json`), `dependenciesChanged`
(`package.json` or `bun.lock` in the diff), `migrationsChanged` (`server/migrations.ts` in the
diff), `launcherChanged` (`scripts/launcher.ts` or `server/update/**` in the diff), `remoteUrl`
(credentials stripped), `checkedAt`.

## 3. Process model (fundamental change)

The server cannot update itself: in dev mode `bun --watch` restarts it as soon as Git writes files
(possibly before `bun install`), and in production nothing restarts it (F1, F2). The update must run
in a long-lived parent that owns the app processes.

**New `scripts/launcher.ts`** (mode `dev` or `prod`):

- Owns its children directly, without `bun run` wrappers (fixes F1):
  - dev: `[process.execPath, "--watch", "server/index.ts"]` and
    `[<repo>/node_modules/.bin/vite]`;
  - prod: `[process.execPath, "server/index.ts"]`.
  `cwd` is always the repo root (resolved from `import.meta.dir`, verified with
  `git rev-parse --show-toplevel`). It never touches any process it did not spawn.
- Keeps today's behavior on an unexpected child exit (stop all, exit), except during an update job.
- Exposes a control API on a Unix socket `.usage-observatory/launcher.sock` (mode 0600), with a
  random per-launch token. It passes `USAGE_OBSERVATORY_LAUNCHER_SOCKET`,
  `USAGE_OBSERVATORY_LAUNCHER_TOKEN`, and `USAGE_OBSERVATORY_LAUNCH_MODE` to the server.
- Holds `.usage-observatory/update.lock` (O_EXCL, contains PID; stale if PID dead) for its lifetime.
- Runs the update job (§4) and owns its state.
- During the job, after stopping the server, binds a **fallback HTTP server** on the API port that
  serves only `GET /api/update/status` (job state), `POST /api/update/retry`, and a self-refreshing
  HTML status page for every other GET. It reuses `requestHostAllowed`/the update origin policy.
  This keeps progress visible while the real server is down, in both modes (Vite proxies to it).

`package.json`: `dev` → `bun run scripts/launcher.ts dev`; `start` → `bun run scripts/launcher.ts prod`;
add `start:server` → `bun run server/index.ts` (unmanaged; update shows manual commands).
`scripts/dev.ts` is deleted (or reduced to an import of the launcher in dev mode).

The launcher never replaces itself. If the update changes `scripts/launcher.ts` or `server/update/**`,
completion shows "Restart `bun run start` (or `bun run dev`) once to load the new launcher."

## 4. Update job lifecycle

### 4.1 Phases (persisted)

`validating → stopping → backing-up → applying → installing → building (prod only) → starting →
verifying → complete`, or `failed` at any phase. Job JSON is written atomically (tmp + rename) to
`.usage-observatory/update-job.json` on every transition; full step output goes to
`.usage-observatory/update-logs/<jobId>.log` (keep last 5). A launcher that starts and finds a
non-terminal job marks it `failed` with `phase` and `interrupted: true`.

Job shape:
`{ id, mode, from, target, phase, gitAdvanced, startedAt, updatedAt, finishedAt?, backupPath?,
launcherChanged, failure?: { phase, code, message, logTail }, retryable }`.

### 4.2 Steps

1. **validating** (server still up). Re-run the non-fetch part of §2 against the request's
   `expectedHead` and `target`: branch is `main`, `HEAD == expectedHead`, `target` is a descendant of
   HEAD, `target` is still an ancestor of (or equal to) `refs/remotes/origin/main` (guards against a
   force-push since the check), no Git operation in progress, clean tracked tree, no collision. No
   new fetch: the exact checked commit is applied.
2. **stopping**. SIGTERM own server child (and, in prod, nothing else); wait ≤10 s, then SIGKILL;
   wait for the port to be free; bind the fallback server. In dev, Vite keeps running until
   `starting` so the browser keeps its page and its `/api` proxy.
3. **backing-up**. `VACUUM INTO .usage-observatory/backups/pre-update-<from7>-<ts>.db` using
   `bun:sqlite` on the resolved DB path (new `server/db-path.ts`; the launcher must not import
   `server/store.ts`, which runs migrations). No writers exist now. Keep the 3 newest
   `pre-update-*` backups.
4. **applying**. Revalidate step 1 again (cheap), then `git merge --ff-only --no-edit <target>`, then
   assert `rev-parse HEAD == target`. Set `gitAdvanced: true`. Git's own `index.lock` serializes
   against external Git activity; a lock failure is reported, not retried automatically.
5. **installing**. `bun install --frozen-lockfile` (timeout 5 min). Runs always; it is a no-op when
   nothing changed and catches a stale `node_modules`.
6. **building** (prod). `vite build --outDir dist.next --emptyOutDir` (timeout 5 min), write
   `dist.next/build-info.json` `{commit}`, then rename `dist` → `dist.prev`, `dist.next` → `dist`,
   delete `dist.prev`. A failed build leaves the old `dist` intact. Add `dist.next/`, `dist.prev/`
   to `.gitignore`.
7. **starting**. Release the fallback port; spawn the server (and, in dev, restart Vite so changed
   dependencies or config load).
8. **verifying**. Poll `GET http://127.0.0.1:<port>/api/update/version` (≤90 s) until it returns
   `{ commit: target, pid: <child pid> }`, and in prod `dist/build-info.json.commit == target`.
   Only then `complete`. If the child exits or times out: `failed` at `starting`/`verifying`,
   re-bind the fallback server, keep the last 40 stderr lines.

### 4.3 Retry and recovery

- Before `applying`: failure leaves everything unchanged; restart the server; UI offers Check again.
- After `applying` (`gitAdvanced: true`): the launcher keeps the fallback server up and shows
  "Git is at `<target>`, but the app is not running it". `POST /api/update/retry` resumes from the
  failed phase (`installing`, `building`, `starting`) if `HEAD == target` and the tracked tree is
  clean. No backup is retaken.
- Manual revert (shown as copyable text, not a button): `git reset --keep <from>`, `bun install
  --frozen-lockfile`, and, if the new server started and `migrationsChanged`, restore the named
  backup while the app is stopped. No automatic rollback in this scope.
- Add a downgrade guard to `runMigrations`: if `user_version` > highest known id, log and expose
  `schemaAhead: true` in `/api/update/status` so a reverted build says "database is newer than this
  code; restore `<backup>`". It does not refuse to start.

### 4.4 Browser reconnection

The client polls `/api/update/status` every 1 s during a job (fallback or real server answer the
same shape). Network errors show "Restarting… reconnecting" with backoff to 3 s, for up to 3 min,
then "Lost contact" with the job id and log path. On `complete`, it reloads the page once. After
load, `__APP_COMMIT__` (Vite `define`, from `git rev-parse HEAD` in `vite.config.ts`) is compared to
`running.commit`; a mismatch shows "Reload to finish the update".

### 4.5 Concurrency

- One job at a time (launcher memory + lock file). `apply` during a job → 409 with the job.
- `check` during a job → 409. Server-side single flight for `check`; a second caller gets the same
  promise.
- Request carries `expectedHead`/`target`; any drift → 409 `stale-check` with a fresh hint to Check.

### 4.6 Git command policy

- Fixed argv only; no shell. The only request inputs are `expectedHead` and `target`, validated as
  `/^[0-9a-f]{40}$|^[0-9a-f]{64}$/` and then resolved with `git rev-parse --verify <sha>^{commit}`.
- `cwd` is the fixed repo root; `git -C <root>` is not needed.
- Environment: inherit, then set `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
  `SSH_ASKPASS_REQUIRE=never`, `LC_ALL=C` (stable stderr for classification); `stdin: "ignore"`. If
  neither `GIT_SSH_COMMAND` nor `core.sshCommand` is set, set
  `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15"`. If one is set, leave it and rely on
  the timeout (A3).
- Timeouts: fetch 60 s, local Git commands 15 s, merge 30 s.
- Extend `server/subprocess.ts` with `runCommand(command, { timeoutMs, cwd, env, onOutput })`; keep
  the existing call shape working and make the error text neutral.

## 5. Security policy

- Update routes require the existing host check plus a stricter origin rule
  (`requestUpdateOriginAllowed`): an `Origin` header is required for POSTs from browsers; it must be
  one of `http://127.0.0.1:<apiPort>`, `http://localhost:<apiPort>`, `http://127.0.0.1:5173`,
  `http://localhost:5173`, or `https://<allowed host>`; requests without `Origin` are accepted only
  with a loopback Host (CLI). Also require header `X-Observatory-Action: update` (forces preflight).
  This closes F5 for these routes; the general fix for other routes is out of scope (note it).
- Remote policy: requests whose `Origin` hostname is not loopback (Tailscale) may read status and
  run Check, but `apply`/`retry` return 403 `remote-apply-disabled` unless
  `USAGE_OBSERVATORY_REMOTE_UPDATES=1` is set. Rationale: an update restarts the app and runs
  `bun install` lifecycle scripts; doing that from a phone should be an explicit opt-in. The socket
  peer is always loopback behind Tailscale Serve, so the Origin header is the only signal (F6).
- The launcher control socket is 0600 and token-authenticated; it accepts only `apply`, `retry`,
  `status`.

## 6. API contracts

Types live in `src/types.ts` (`UpdateCheck`, `UpdateJob`, `UpdateStatus`).

- `GET /api/update/status` →
  `{ managed: boolean, mode: "dev"|"prod"|null, remoteApply: boolean, requestIsRemote: boolean,
  running: { commit, version, startedAt }, schemaAhead: boolean, check: UpdateCheck|null,
  job: UpdateJob|null, autoCheckDue: boolean }`. No snapshot dependency.
- `GET /api/update/version` → `{ commit, pid, version }` (launcher health probe).
- `POST /api/update/check` `{}` → `200 UpdateCheck`; `409` job active.
- `POST /api/update/apply` `{ expectedHead, target }` → `202 { job }`; `400` bad SHA; `403`
  remote; `409` stale or busy; `422` not eligible; `503` unmanaged (body has manual commands).
- `POST /api/update/retry` `{ jobId }` → `202 { job }`; `409` not retryable.

The last check is cached in memory and in `.usage-observatory/update-check.json` so a reload shows
it. `autoCheckDue` is true when the last check is older than 24 h.

## 7. UI states and click flow

Place an "Updates" control in the sidebar status block next to the version (`App.tsx:561` area); it
opens a small panel (new `src/components/update-panel.tsx`).

- On load, if `autoCheckDue` and the panel is not remote-restricted, run Check in the background
  (one request per 24 h). A badge appears on the version when `behind`.
- Flow: background check → badge "Update available" → open panel → **Update and restart** (1 click
  after opening). Without a background result: **Check for updates** → **Update and restart**.
- States: `unknown` (Check button), `checking`, `equal` ("Up to date · checked …"), `behind`
  (version `vX → vY`, commit count, up to 20 subjects, notes "dependencies change" / "database
  migrations change" / "launcher changes need one manual restart", Update button),
  `behind`+unmanaged (manual commands), `behind`+remote (disabled button with reason), `dirty`
  (up to 10 paths), `collision` (paths), `ahead`, `diverged`, `git-busy`, `unsupported` (reason
  text from §1), `failed` (message, Try again), `updating` (phase stepper + "The app restarts; this
  page reconnects."), `reconnecting`, `complete` (auto-reload), `job-failed` (phase,
  `gitAdvanced` sentence, log tail, Retry if retryable, revert commands, backup path).

## 8. Files

Add:

- `scripts/launcher.ts` — child ownership, control socket, lock, fallback server, job runner entry.
- `server/update/git.ts` — repo root, check (§2), revalidation, fixed Git commands, stderr
  classification, URL sanitizing.
- `server/update/job.ts` — phase machine, persistence, backup, install/build/start/verify steps;
  steps injectable for tests.
- `server/update/launcher-client.ts` — server → launcher socket client.
- `server/update/routes.ts` — the `/api/update/*` handlers and origin policy wiring.
- `server/db-path.ts` — single DB path resolution shared by store and launcher.
- `src/components/update-panel.tsx` — panel UI and polling hook.
- Tests listed in §10.

Change:

- `server/app.ts` — route `/api/update/*` before the snapshot fallthrough.
- `server/request-host.ts` — `requestUpdateOriginAllowed`, `requestIsRemote`.
- `server/subprocess.ts` — options object (cwd, env, streaming), neutral error text.
- `server/store.ts` — use `db-path.ts`.
- `server/migrations.ts` — `schemaAhead` detection.
- `server/index.ts` — record boot commit and start time.
- `vite.config.ts` — `define: { __APP_COMMIT__ }`.
- `src/vite-env.d.ts`, `src/types.ts`, `src/App.tsx`, `src/styles/*` — panel wiring and styles.
- `package.json` — `dev`, `start`, `start:server` scripts.
- `scripts/dev.ts` — remove (or one-line delegate).
- `.gitignore` — `dist.next/`, `dist.prev/`.
- `README.md`, `docs/ARCHITECTURE.md` — update section, launcher, remote opt-in, manual revert.

## 9. Ordered implementation steps

1. `server/db-path.ts`, `subprocess.ts` options, `migrations.ts` guard (+ tests). Stop if existing
   tests fail.
2. `server/update/git.ts` with temp-repo tests for every §2 state.
3. `request-host.ts` update origin policy (+ tests).
4. `server/update/job.ts` with injected steps; temp-repo tests for apply, revalidation, retry,
   interruption.
5. `scripts/launcher.ts` (children, socket, lock, fallback server); verify A1/A2 first with a
   20-line spike and stop to report if either is false.
6. `routes.ts`, `launcher-client.ts`, `app.ts`, `index.ts` wiring (+ handler tests).
7. `package.json` script switch; confirm `bun run dev` still yields the same ports and HMR.
8. UI panel, `vite.config.ts` define, App wiring; browser-test runner scenario with mocked API.
9. Docs.
10. End-to-end test (§10 E2E) on separate ports.

Live-app rule: the user's dev server (PIDs under `bun run dev`) must keep running during all work.
Step 7 changes how `bun run dev` launches; do not restart the user's instance to test it — use a
separate checkout and `PORT`.

## 10. Tests and acceptance criteria

Fixtures: `server/update/fixtures.ts` builds a bare `origin.git` and a clone in `mkdtemp`, with
helpers to commit, push, branch, detach, dirty, add untracked/ignored files, and start a merge.

Unit / temp-repo (`bun test`):

- Every §2 state and reason, including: feature branch, detached, no origin, upstream mismatch,
  no upstream (allowed), merge in progress, `index.lock`, dirty staged, dirty unstaged, untracked
  collision, ignored collision (e.g. upstream adds a tracked `.env.local`-like path that is ignored
  locally), ahead, diverged, equal, behind.
- Fetch failure with a bad remote URL → `failed/network`; with `ssh://` to a host requiring auth via
  a fake `GIT_SSH_COMMAND` script that exits 255 with "Permission denied" → `failed/auth`; a fake
  that sleeps → `failed/timeout` within the bound.
- Apply: exact target applied even after `origin/main` advanced again; rejected after force-push
  removes target; rejected if HEAD moved, branch changed, or tree became dirty after check;
  `index.lock` created between validation and merge → failure reported, HEAD unchanged.
- Local untracked and ignored files, `.env.local`, and `.usage-observatory/` contents survive apply.
- Job: persistence on every phase; interrupted job marked on restart; retry only after
  `gitAdvanced` and only with `HEAD == target`; failed build keeps old `dist`.
- Backup: `VACUUM INTO` copy of a fixture DB at an older `user_version` opens and matches row
  counts; retention keeps 3.
- Migrations: DB with `user_version` above the max → `schemaAhead`.
- Origin policy: localhost:3000 origin rejected; 5173 and 4318 loopback accepted; ts.net origin
  accepted for check, rejected for apply unless opted in; missing custom header rejected.
- Routes: 503 when unmanaged; 409 on concurrent apply; 400 on non-hex SHA.

E2E (`server/update/launcher.e2e.test.ts`, opt-in via env flag because it spawns processes): a temp
repo containing a 30-line fixture app (server answering `/api/update/version` with its boot commit),
the real launcher in `prod` mode on a free port with a stub install/build step list; push a commit
to the fixture origin; call check then apply; assert the job reaches `complete`, the new PID differs,
`version.commit == target`, and the fallback server answered `status` during the restart. A second
case makes the new server exit on start and asserts `failed` at `verifying` with `gitAdvanced: true`
and a working `retry` after fixing the fixture.

Acceptance:

- From a clean `main` behind `origin/main` under `bun run start`, Check then Update ends with the
  page reloaded on the new version and `running.commit == origin/main`.
- Under `bun run dev`, the same flow ends with the API and Vite both serving the new commit.
- Every blocked state shows a specific reason and never changes HEAD.
- No process other than the launcher's own children is signalled (verify by PID in E2E).
- `bun run typecheck`, `bun test`, `bun run build` pass.

## 11. Open decisions, risks, trade-offs

- D1. Dev-mode updates: included (small delta), or check-only in dev? Recommended: included.
- D2. Background check every 24 h on page load (runs `git fetch`): recommended on, no setting.
- D3. Remote apply opt-in via env var: recommended.
- D4. `bun run start` now runs the launcher: a behavior change for anyone scripting `start`.
- R1. Downtime during an update ≈ install + build + startup (expected < 1 min); the fallback page
  covers it.
- R2. `bun install` runs dependency lifecycle scripts from the new lockfile; that is the same trust
  as a manual `git pull && bun install`.
- R3. A3 may leave an SSH passphrase prompt on the launcher's terminal; the 60 s timeout bounds it.
- R4. The launcher cannot update itself; a launcher bug shipped in an update needs one manual restart.
- R5. The live user's checkout is on a feature branch, so they will see `unsupported/not-main`
  until they run `main`.
