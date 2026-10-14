# In-app fast-forward update — REVISED

Slug: in-app-update · Date: 2026-10-13
Reviewer: Sol 6.1 (high) via Codex CLI (`codex exec -m gpt-6.1-sol`, read-only sandbox); reviewer chosen by user override
Based on: in-app-update-PLAN.md

---

# Revised in-app update plan

The original plan needs revision before execution. A supervisor is justified, but the Unix socket is optional. The main defects are the live Vite process during updates, incomplete concurrency guarantees, unsafe downgrade guidance, and tests that do not prove the real installation, build, and dev restart paths.

## 0. Verified facts and corrections

Reviewed the full plan and the code at `7215d40527d8f46055ffa6515462c430c9e5599f`.

| Original claim | Finding |
| --- | --- |
| F1: dev uses wrappers and lacks restart control | Confirmed in `scripts/dev.ts` and `package.json`. The cited process IDs were not verified; process inspection is restricted here. |
| F2: production has no launcher | Confirmed. “Nothing can restart it” is too broad: an external supervisor could, but none is provided by this repository. |
| F3: localhost binding and Tailscale access | Binding confirmed in `server/index.ts`. Tailscale is the documented remote path, not the only possible reverse proxy or tunnel. |
| F4: static files come from current `dist`; early routes avoid snapshots | Confirmed in `server/app.ts`. However, its static imports initialize the database before any route can answer. Merely placing update routes first does not survive migration failure. |
| F5: permissive loopback origins; JSON prevents CSRF | Partly wrong. `requestOriginAllowed` allows arbitrary loopback ports, but also rejects `Sec-Fetch-Site: cross-site`. Several mutations, including `/api/refresh`, do not call `readBody`; JSON preflight is not a general protection. |
| F6: Vite changes Host and preserves Origin | The proxy configuration supports this expectation. Preserve and test these headers explicitly. |
| F7: DB resolution and migrations happen on import | Confirmed in `server/store.ts`. Migrations skip IDs at or below `user_version` and do not reject newer schemas. The DB is approximately 24 MiB plus WAL; the backup directory exists. |
| F8: ignored local files | Confirmed in `.gitignore`. Ignoring a path does not protect it from an incoming tracked file. |
| F9: subprocess limitations | Confirmed in `server/subprocess.ts`: no caller-supplied cwd/env or streaming. It already overrides `NO_COLOR`. Killing the immediate child does not establish descendant cleanup. |
| F10: displayed package version | Confirmed at `src/App.tsx:561`. This identifies package version, not the running commit. |
| F11: lazy backend imports | Confirmed in `server/session-detail.ts`. Updating files beneath a running server can mix code revisions. |
| F12: checkout and tools | Confirmed: feature branch `fix/review-data-freshness`; cached `main...origin/main` is `0 15`; Bun `1.3.14`; Git `2.54.0`. No fetch was performed, so this is not a current remote eligibility result. |

Additional facts:

- `vite.config.ts` fixes the frontend port at `5173` and proxy target at `4318`. Setting backend `PORT` alone does not isolate dev tests.
- Vite does not enable `strictPort`; it can silently choose another port. [Vite server options](https://vite.dev/config/server-options)
- `src/App.tsx` returns a loading or error screen before rendering the sidebar. Update recovery must work without dashboard data.
- `bunfig.toml` and `server/test-setup.ts` already isolate ordinary tests from the live DB.
- Bun documents native parent/child IPC and preservation of CLI arguments/environment across watch restarts. This does not prove IPC behavior on installed Bun `1.3.14`; test that version first. [Bun subprocesses](https://bun.sh/docs/runtime/child-process), [Bun watch mode](https://bun.sh/docs/runtime/watch-mode)

Critical corrections:

1. Stop **both** backend watch and Vite before changing Git files or dependencies.
2. Bind Apply to a server-owned check record; accepting arbitrary descendant SHAs does not prove “apply the checked commit.”
3. Git’s `index.lock` does not provide an exclusive lease over the entire validation/install/build/start lifecycle.
4. Revalidation against cached `origin/main` cannot detect an unobserved remote force-push.
5. A merge timeout or crash can leave ambiguous results. Inspect actual HEAD and tree before reporting Git completion.
6. Reject a database newer than the running code before application writes. A warning alone is insufficient.
7. Remove executable rollback guidance until DB restoration, WAL handling, and dependency/build recovery have a concrete procedure.
8. Three-minute client abandonment conflicts with two five-minute command deadlines.
9. Opening a panel is an additional click. The primary sidebar action must itself perform Check or Update.

No files were edited and no processes were signalled. Local URLs were not reachable from this restricted reviewer environment; that does not establish whether the user’s app is stopped.

## 1. Recommended scope

Implement explicit Check → Update for managed development and production sessions.

**Target policy:** local `main` → freshly fetched `origin/main`.

- Never switch branches.
- Missing upstream is allowed; show the explicit target.
- An upstream other than `origin/main` blocks Apply.
- Forks follow their own `origin/main`; show the sanitized remote.
- Feature branches, detached HEAD, missing origin, and downloaded copies receive specific unsupported reasons.
- Initially block shallow clones, linked worktrees, sparse checkouts, and repositories with submodules. Supporting them correctly expands eligibility and preservation rules.
- Missing Git blocks updates, not ordinary app startup.

Apply requires the new launcher. Unmanaged sessions can Check and show instructions for restarting under the launcher. Do not promise an in-app restart of an unmanaged process.

Exclude automatic Apply, stash/rebase/merge updates, automatic rollback, runtime upgrades, release/tag selection, and automatic launcher replacement.

Start with manual checking. A background check can be added later without changing Apply semantics.

## 2. Eligibility states

Represent repository relationship separately from blockers:

```ts
relationship: "unknown" | "equal" | "ahead" | "behind" | "diverged"
state: "unsupported" | "git-busy" | "checking" | "equal" |
       "ahead" | "diverged" | "dirty" | "collision" | "behind" | "failed"
eligible: boolean
```

Check sequence:

1. Resolve the canonical repository root from the script location, not request input or arbitrary cwd.
2. Validate supported checkout, branch, remote, upstream, and runtime.
3. Detect Git operation markers and locks using `git rev-parse --git-path`.
4. Fetch the explicit main ref:

   ```text
   git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
   ```

5. Capture branch, HEAD, target, and remote identity. Calculate ancestry and ahead/behind counts.
6. Inspect staged and unstaged tracked changes. Report dirtiness even when equal or ahead.
7. Detect incoming collisions with untracked and ignored files, directories, symlinks, and file/directory replacements. Parse Git path output with NUL separators.
8. Reject incoming tracked content under updater-owned/data directories and collisions with local configuration or the resolved DB path.
9. Re-read repository identity after inspection. Drift produces `failed/stale-check`.

Only a clean, collision-free `behind` result is eligible.

Check result:

```ts
{
  id, checkedAt, expiresAt,
  branch, upstream, remoteDisplay,
  head, target, relationship, state, eligible,
  ahead, behind, blockers, paths,
  currentVersion, targetVersion,
  incomingCommits, // maximum 20
  dependenciesChanged, migrationsChanged,
  launcherChanged, protocolCompatible
}
```

Use a ten-minute Apply lifetime. Preserve the result in launcher memory; persisted job state is sufficient. Cached checks are invalid after launcher restart.

Version differences are informational. A commit update can retain the same package version.

## 3. Process model

Use `scripts/launcher.ts` as a non-watched supervisor for both modes.

### Recommended IPC

Use Bun’s inherited IPC channel:

- `Bun.spawn(..., { ipc })` in the launcher.
- `process.send` / `process.on("message")` in the backend.
- Bounded RPC requests with IDs and a protocol version.
- The launcher owns Check, Apply, Retry, and job state.

This removes socket paths, permissions, tokens, stale socket cleanup, and HTTP-over-Unix dependencies. Verify watch-mode IPC on Bun `1.3.14` before implementation proceeds. [Bun IPC](https://bun.sh/docs/runtime/child-process)

A permanent launcher-owned public proxy is a valid alternative, but adds internal-port management and proxy correctness work. It is unnecessary if brief listener handoffs are acceptable.

### Ownership and maintenance

- Spawn backend and Vite directly, without `bun run` wrappers.
- Backend: `process.execPath`, with `--watch` only in dev.
- Vite: resolved Node executable plus `<root>/node_modules/vite/bin/vite.js`.
- Use owned process groups on supported POSIX platforms so shutdown and command deadlines include descendants.
- Signal only groups created by this launcher.
- Load updater modules eagerly at launcher startup; never import newly updated updater code midway through a job.
- Hold an exclusive checkout ownership file containing PID, nonce, and root. Never remove an uncertain stale owner automatically.
- Refuse occupied ports; do not stop their owners.

After stopping children, the launcher serves maintenance endpoints:

- API port in both modes.
- Frontend port in dev, after Vite exits.
- `status`, `retry`, and a small standalone recovery page.
- Other API requests return structured `503 updating`; they never receive HTML.
- Recovery handlers must not import `store.ts`, collectors, React, or newly installed dependencies.

Release maintenance listeners before spawning replacement children. Port handoff failures become explicit job failures; never reclaim a port by killing another process.

Normal unexpected child exits retain the existing stop-all behavior. During update recovery, keep maintenance available.

Scripts:

```text
dev          bun run scripts/launcher.ts dev
start        bun run scripts/launcher.ts prod
start:server bun run server/index.ts
```

Keep `scripts/dev.ts` as a thin delegate if compatibility warrants it.

## 4. Update job lifecycle

### 4.1 State and durability

```text
validating → stopping → backing-up → applying → installing
→ building [prod] → starting → verifying → complete
```

Failure records both the failed phase and actual observed state.

```ts
{
  id, checkId, mode, from, target,
  phase, failedPhase?,
  gitState: "unchanged" | "target" | "unexpected" | "unknown",
  installComplete, buildComplete,
  startedAt, updatedAt, finishedAt?,
  backupPath?, startupAttempted,
  launcherRestartRequired,
  failure?, retryable
}
```

Persist versioned JSON atomically before and after consequential operations. Use bounded, sanitized logs and retain five jobs. Never delete a backup referenced by an unresolved job.

On launcher startup, interrupted jobs become `failed/interrupted`. Reconcile HEAD before deciding recovery eligibility. Do not resume mutations automatically or adopt unknown surviving processes.

### 4.2 Apply steps

1. **Validate.** Resolve `checkId` to the launcher-owned eligible result. Recheck expiry, branch, HEAD, remote identity, target ancestry, Git markers, tree, collisions, and target updater protocol. Do not fetch again or substitute a newer target.
2. **Accept.** Persist the job before returning `202`. Repeated Apply for the same check returns that job. If the response disappears during shutdown, status polling recovers it.
3. **Stop.** Stop both owned dev children, or the production backend. Wait ten seconds, then kill only their owned groups. Confirm exit before continuing.
4. **Maintenance.** Bind recovery listeners. Failure to establish required recovery listeners stops the update before Git changes.
5. **Backup.** Resolve the same absolute DB path used by the backend. Open an existing DB without application imports or migrations. `VACUUM INTO` a uniquely named backup, verify integrity/schema, and close handles. A nonexistent DB needs no backup. Permission, space, or busy failures block Apply.
6. **Revalidate and apply.** Repeat repository checks immediately before:

   ```text
   git merge --ff-only --no-edit --no-autostash --no-overwrite-ignore <checked-target>
   ```

   Explicit `--no-overwrite-ignore` supplies Git’s own ignored-file protection; retain collision checks for explanations. [Git merge options](https://git-scm.com/docs/git-merge)

7. **Reconcile.** Inspect branch, HEAD, and tree regardless of merge exit status. Do not infer Git state from the command result alone.
8. **Install.** Run the installed Bun executable with `install --frozen-lockfile`, including build dependencies. Verify committed `bun.lock` exists and no tracked dependency files changed. No runtime upgrade or `bunx` download. Frozen installation fails on manifest/lock disagreement. [Bun install](https://bun.sh/docs/pm/cli/install)
9. **Build, production only.** Run the project-local Vite CLI with fixed root and `dist` output. Emit commit metadata through the build plugin. A failed build leaves maintenance active. Direct rebuilding is sufficient because the app is stopped and automatic rollback is excluded; staging/swap directories are unnecessary initially.
10. **Start.** Release maintenance listeners and start fresh children with a new startup nonce and preserved resolved configuration.
11. **Verify.** Require backend readiness for the target commit and correct owned startup instance. In production, verify the served build stamp. In dev, verify Vite readiness and its startup commit stamp. Recheck HEAD/tree. Only then mark `complete`.

`gitAdvanced` alone must never produce completion.

### 4.3 Retry and recovery

- Before Git changes: restart the original app only if branch, HEAD, and tree still match the original state.
- After Git changes: keep maintenance available. Retry starts at the earliest unfinished prerequisite, not blindly at the displayed failed phase.
- Retry requires the target HEAD, clean tracked tree, unchanged repository identity, no Git operation, and available owned ports.
- `unexpected` or `unknown` Git state requires manual inspection.
- Startup or migration failure retains the backup and logs; never start old code automatically.
- Remove `git reset --keep` from the UI. Link to a documented manual recovery procedure instead.

Migration guard:

- Compare `user_version` with the highest supported migration before application writes.
- Throw a typed schema-ahead error.
- The launcher exposes that failure through maintenance status.
- Restore instructions must stop every writer and handle DB/WAL/SHM files. Restoration loses writes made after the backup; state that explicitly.

### 4.4 Browser reconnection

- Poll status every second during jobs; back off to three seconds on network errors.
- Continue through the declared maximum job duration. “Lost contact” must not imply job failure.
- Recovery works after tab reload, lost `202`, backend restart, and dashboard failure.
- Maintenance HTML uses the same status/retry contracts.
- Reload once per completed job; remember the job ID in session storage.
- Compare frontend build commit with backend boot commit after reload. Show a mismatch without creating a reload loop.

### 4.5 Concurrency and external activity

- One launcher and one mutating job per supported checkout.
- Check is single-flight in the launcher; Check during a job returns `409`.
- Apply is idempotent by check ID.
- Revalidate before merge, after merge, before build/start, and before completion.
- Do not delete Git locks, stash edits, or repair unexpected repository state.

**Limit:** this is not transactional against arbitrary external Git commands or editors. Git locks protect individual Git operations, not the complete update. Concurrent manual mutation is unsupported; detected drift stops progress. If protection against uncooperative writers is required, use an isolated deployment checkout rather than claim stronger guarantees here.

### 4.6 Commands and deadlines

- Fixed executables, argv, cwd, and controlled environment; no request-supplied command, URL, path, or SHA.
- Ignore stdin; disable Git credential prompts and use SSH batch mode.
- Custom SSH commands that cannot be made noninteractive produce a specific blocked reason.
- Preserve normal SSH host aliases/configuration.
- Deadlines: local Git 15 seconds; fetch 60 seconds; merge 30 seconds; install/build five minutes each; readiness 90 seconds.
- Terminate owned command descendants on deadline and bound output collection.
- Classify timeout explicitly. Use conservative auth/network classifications; unknown stderr remains `git-error`.
- Redact credentials from persisted logs, remote display, and API errors.

## 5. Security policy

Existing host/origin checks are useful but insufficient for privileged update routes.

For every update POST:

- Require `application/json`, strict payload validation, and `X-Observatory-Action: update`.
- Require a valid Origin; do not retain an originless-write exception.
- Accept only exact configured frontend/API origins, including their actual ports.
- Reject cross-site fetch metadata and malformed/null origins.
- Do not enable cross-origin browser access through permissive CORS.
- Apply the identical policy in backend and maintenance handlers.

Tailscale:

- Status and Check follow the existing allowed-host configuration.
- Apply/Retry from approved remote browser origins require `USAGE_OBSERVATORY_REMOTE_UPDATES=1`.
- Preserve Origin through Vite and maintenance paths.
- Document that Origin is a browser request-policy signal, not authentication. The tailnet and allowed proxy clients remain trusted.
- Do not claim this distinguishes arbitrary native remote callers when a reverse proxy conceals their source. A stronger requirement needs authenticated proxy identity or a separate update credential.

Explain that updates execute trusted remote code through installation and startup. Retain the documented prohibition on Tailscale Funnel.

## 6. API contracts

Shared update types belong in `server/update/types.ts`; frontend imports them as types.

| Route | Contract |
| --- | --- |
| `GET /api/update/status` | `{ managed, mode, canApply, blockingReason, running, check, job, launcherRestartRequired }` |
| `POST /api/update/check` `{}` | `200 UpdateCheck`; `409 job-active`; failed fetch returns a structured failed check |
| `POST /api/update/apply` `{checkId}` | `202 {job}`; `400` malformed; `403` policy; `409` stale/busy; `422` ineligible; `503` unmanaged |
| `POST /api/update/retry` `{jobId}` | `202 {job}`; `403` policy; `409` unsafe/not retryable |
| `GET /api/update/version` | Launcher-authenticated readiness response: `{commit, version, pid, bootId, protocol, startedAt}` |

All responses use `Cache-Control: no-store` and bounded errors.

The launcher owns managed route state. Backend routes forward through IPC. Unmanaged mode uses the same checker but refuses Apply.

Add a committed updater protocol number to `package.json`. Missing/incompatible target protocols require a manual update. Launcher changes with a compatible protocol may update the app successfully while reporting a later manual launcher restart.

## 7. UI states and click flow

Add an Updates action near the sidebar version, outside the brand link.

- Initial primary action: **Check for updates**. Clicking opens the panel and starts Check.
- Eligible result: replace the primary action with **Update and restart**.
- Two clicks total; no required panel-opening click or confirmation modal.
- An optional details action does not initiate updates.

Show:

- Unknown/checking.
- Up to date, ahead, diverged.
- Behind and eligible: target remote, versions/commits, incoming count, dependency/migration notes.
- Dirty/collision: bounded paths and specific action required.
- Git busy/unsupported: exact reason.
- Failed check: error and Check again.
- Unmanaged/remote-restricted: specific blocking reason.
- Updating: actual phase and elapsed time.
- Reconnecting: retained job identity.
- Failed job: Git state, failed phase, sanitized output, backup, Retry when safe.
- Completed: one reload and running/build commit verification.

Mount update recovery before `App.tsx`’s dashboard loading/error returns. Preserve keyboard focus and accessible status announcements.

## 8. Exact files

Add:

- `scripts/launcher.ts` — ownership, children, maintenance, signal handling.
- `server/update/types.ts` — API/job/IPC types.
- `server/update/git.ts` — check, target identity, collisions, revalidation.
- `server/update/job.ts` — durable lifecycle and recovery.
- `server/update/ipc.ts` — bounded request/response channel.
- `server/update/routes.ts` — shared update HTTP handlers.
- `server/update/maintenance.ts` — dependency-free recovery page/handlers.
- `server/update/version.ts` — boot/build provenance and protocol checks.
- `server/db-path.ts` — shared absolute DB resolution.
- `src/components/update-panel.tsx`.
- `src/hooks/use-update.ts`.
- Tests listed below.

Change:

- `package.json` — launcher scripts and updater protocol.
- `scripts/dev.ts` — delegate.
- `server/index.ts` — capture boot identity before importing the application; readiness wiring.
- `server/app.ts` — update adapter before snapshot-dependent routes.
- `server/request-host.ts` — exact update origin policy.
- `server/subprocess.ts` — compatible options overload, streaming, bounded errors, owned descendant cleanup.
- `server/store.ts`, `server/migrations.ts` — shared path and fail-closed schema guard.
- `vite.config.ts` — configurable dev port/proxy, `strictPort`, commit define, dev/build stamp.
- `src/vite-env.d.ts`, `src/App.tsx`, `src/styles/chrome.css`.
- `scripts/test-browser.ts`, `tests/browser/runner.tsx` — isolated update scenarios.
- `README.md`, `docs/ARCHITECTURE.md` — operation, trust, restart, and recovery limits.

No staging build directories or additional ignore rules are needed.

## 9. Ordered implementation

1. Probe installed Bun IPC through watch restart, PID behavior, direct child/group shutdown, and Vite restart on separate ports. Resolve failures before selecting the IPC implementation.
2. Define update types, protocol, target policy, and strict origins.
3. Implement Git checks and temp-repo tests.
4. Extract DB path; add migration guard and fixture backup tests.
5. Extend subprocess support without changing collection callers.
6. Implement durable jobs and failure reconciliation with injectable operations.
7. Implement launcher, native IPC, and maintenance on both dev ports.
8. Wire routes, boot identity, Vite configuration/stamps, and scripts.
9. Implement UI and recovery independent of dashboard loading.
10. Add browser and real-process E2E coverage.
11. Document the manual bootstrap/recovery procedure and run required checks.

Use temporary checkouts and DBs throughout. Never restart the user’s dev instance to verify the script switch. Identify and report the preserved local URL when execution finishes.

## 10. Acceptance criteria and tests

Add:

- `server/update/git.test.ts`
- `server/update/job.test.ts`
- `server/update/routes.test.ts`
- `server/update/ipc.test.ts`
- `server/update/backup.test.ts`
- `server/update/launcher.e2e.test.ts`
- `server/update/test-fixtures.ts`

### Git fixtures

Bare origin plus independent clones in temporary directories:

- Every supported relationship and blocked reason.
- Missing upstream allowed; mismatched upstream blocked.
- Staged/unstaged edits, operation markers, locks.
- Untracked/ignored collisions, directory replacements, spaces/newlines, case collisions on applicable filesystems.
- Local configuration, DB, and updater-state path protection.
- Auth/network/timeout failures through local fake transports.
- Exact checked target applied when origin later advances.
- Observed force-push removal, changed remote, branch/HEAD/tree drift, expired check, arbitrary check ID.
- Lock/race injection immediately before merge.
- Merge timeout reconciliation.
- Noncolliding local files survive unchanged.

Do not describe an unobserved remote force-push as detectable without another fetch.

### Jobs and DB fixtures

- Persistence before/after each consequential step.
- Crash after merge but before success persistence.
- Correct retry prerequisites and interruption reporting.
- Backup integrity with WAL-backed fixture data.
- Custom absolute/relative DB paths.
- No migration during backup.
- Higher schema version refuses application writes.
- Migration failure remains recoverable through maintenance.
- Install/build timeout cleans owned descendants.
- Startup failure does not report completion or trigger rollback.

### Real process and browser tests

Stubbed steps are useful unit tests, not sufficient E2E.

Run separate temporary dev and production applications with fixture DBs and free ports:

- Real launcher, frozen install, production build, and restarted backend.
- Real Vite stop/restart and backend watch behavior.
- Dependency/configuration changes.
- Status accessible while children are stopped.
- Lost Apply response, browser reload mid-job, reconnection, and one completion reload.
- Frontend/backend commit mismatch.
- Startup crash, occupied port, install/build failure, safe retry.
- Unrelated sentinel process remains alive.
- Origin policy through Vite and maintenance, including missing Origin and remote opt-in.

Required checks:

```text
bun run typecheck
bun test
bun run build
```

Run build and mutation-oriented E2E in the temporary checkout.

**Success:** Check → Update ends with the backend and relevant frontend serving the checked commit. Every blocked state leaves HEAD unchanged. A job cannot complete at Git, install, or build alone.

## 11. Questions, risks, and tradeoffs

Questions that can change the design:

1. Is `main → origin/main` acceptable, including forks, or must configured upstreams be supported?
2. Is dev Apply required initially? Production-only Apply removes Vite shutdown and frontend maintenance handling.
3. Must remote restrictions resist native callers, or only enforce browser policy within a trusted tailnet?
4. Must updates tolerate concurrent manual Git/editor activity? That requirement favors an isolated deployment checkout.
5. Which OS/runtime versions must be supported? The proposed process ownership design initially targets macOS/Linux.
6. Are shallow clones, worktrees, sparse checkout, submodules, custom SSH commands, or multiple instances required?
7. Can another process write the same configured DB?
8. Is manual recovery acceptable after launcher death or incompatible updater protocol?
9. Should background fetch be enabled, and is its network/auth behavior acceptable?

Remaining risks:

- Installation and startup execute new code; no updater can preserve arbitrary files against malicious trusted code.
- Downtime can last several minutes, not reliably less than one minute.
- Backup creation does not provide automatic rollback.
- An old launcher remains loaded after a compatible app update; protocol checks must prevent incompatible handoffs.
- Native IPC/watch behavior requires verification on the installed runtime.
- Port handoffs have short gaps and can fail; a permanent proxy is the next option if those gaps prove unacceptable.
- Supporting arbitrary external Git activity is outside this minimal design.

## Execution recommendation

1. **Best arrangement: one executing agent.** Use **Anthropic Opus 5.5, high effort**, or **OpenAI Astra, high effort**. Keep one owner for Git validation, process ownership, durable recovery, and schema handling; these contracts are tightly coupled. Use medium effort for UI/docs, then high effort for failure-path review. IPC/watch verification and real dev/prod E2E will likely run longest. Safe handoffs are after passing Git fixtures, after a passing launcher/job integration, and after complete E2E evidence. Use Fable 5.1 only if Opus stalls on the lifecycle/race design. These are task-specific recommendations informed by the providers’ model guidance. [Anthropic models](https://platform.claude.com/docs/en/models/overview), [OpenAI models](https://developers.openai.com/api/docs/models)

2. **Quota-sensitive arrangement:** use **Sonnet 5.5, high effort** for Anthropic implementation, with an **Opus 5.5 high-effort review** of Git, process cleanup, retries, and migrations. Use **Sol 6.1, high effort** for OpenAI execution, dropping to medium for UI/docs; reserve Astra for unresolved lifecycle failures. Haiku 5.5 or Luna can handle bounded documentation or fixture additions after contracts are fixed. Keep Terra away from the recovery core; Sol 6.1 is the better-supported cost/quality choice here. [Anthropic model comparison](https://platform.claude.com/docs/en/models/overview), [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection)