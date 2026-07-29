# Effort Information — Execution Handoff

**Date:** 2026-07-29
**Plan being executed:** `effort-information-PLAN-FINAL.md` (read it first; this file only
records what changed, what is left, and where the implementation deviates)
**Baseline:** v1.5.0, branch `main`
**Reason for handoff:** executor quota exhaustion, not a blocker in the work.

**Nothing has been committed.** All changes are uncommitted in the working tree. The repository
owner has not granted commit permission; ask before running `git commit`.

## Completion update — 2026-07-29

The takeover described below is complete. All four phases in
`effort-information-PLAN-FINAL.md` now pass their exit gates; the remainder of this document
preserves the state at the original handoff for traceability.

### Completed work

- Diagnosed the historical Codex mismatch as replayed parent history in forked rollouts plus
  repeated cumulative token events. Parser version 3 ignores foreign replay spans and de-duplicates
  repeated usage records while preserving ordinary rollback context.
- Wired the Data effort facet with whole-session selection semantics. The Sessions value filter now
  uses the same "contains this observed value" meaning through a compact digest bitmask.
- Completed Projects, Models, and Data presentation, including exact scoped requests, linked-session
  badges, token/observation distributions, provenance, indexing controls, and derived-data deletion.
- Wired visible effort requests to private index-version changes without changing the dashboard
  response contract.
- Added the privacy, architecture, lifecycle, and release-note documentation required by Phase 4.

### Final verification

| Measurement | Result | Gate |
| --- | --- | --- |
| Automated tests | 150 pass, 0 fail | pass |
| Typecheck / production build | pass / pass | pass |
| Full backfill, 924 sessions / 1.13 GB | 4.06 s | recorded |
| Background parsing event-loop delay | p95 4.94 ms | ≤ 50 ms ✅ |
| API latency during backfill | p95 6.0 ms · max 21.0 ms over 1,581 requests | p95 ≤ 100 ms · max ≤ 250 ms ✅ |
| Warm project aggregate | p95 1.35 ms · max 2.65 ms over 200 requests | p95 ≤ 50 ms ✅ |
| Derived SQLite objects | 606 KiB | measured; below 10 MiB investigation threshold ✅ |
| Status / largest grouping / session digest | 289 B / 70,151 B / 37,134 B | payload budgets ✅ |
| Codex all-time reconciliation | delta 0 · 99.84% token coverage | exact ✅ |
| Claude all-time reconciliation | delta 0 · 67.99% token coverage | exact ✅ |
| Dashboard contract comparison | no effort keys; current response 12 B smaller than baseline while the active session appended | no effort fields ✅ |
| Controlled incremental append | proportional-byte test passes (1.2–2.4 ms in measured final runs) | pass |
| No-change refresh | zero-write lifecycle test passes | pass |

The 12-byte dashboard comparison difference came entirely from the live transcript changing between
the two near-simultaneous collectors; recursive inspection found no effort field in the dashboard
response.

### Browser verification added during completion

- Projects: compact mixes, exact-project daily panel, linked-session badges, and narrow open detail
  render without page overflow. Invalid project-day reconciliation remains visibly suppressed
  instead of drawing a plausible share.
- Models: desktop and narrow cards render without overflow; expanded detail includes separate token
  and observation distributions plus badged supporting sessions.
- Data: raw provider/model/project analysis, privacy controls, and all effort facet choices render.
  Selecting High narrowed the same 30-day scope from 527 to 103 sessions and updated downstream
  intelligence using complete selected sessions.
- Narrow rendering was exercised at a 615 CSS-pixel viewport. Data was also exercised at its 150%
  text setting with zero document overflow, then restored to the user's 125% setting.
- Reduced-motion behavior remains enforced by both the application media-query hook and the global
  `prefers-reduced-motion: reduce` CSS override; effort UI adds no essential motion or
  motion-dependent label.

The existing development server on `http://127.0.0.1:5173` was preserved. The production server on
`http://127.0.0.1:4318` was restarted only to load server-side changes and was left reachable.

## Current state

`bun test` (146 pass), `bun run typecheck`, and `bun run build` all pass. The feature has been run
end to end against the real 1.06 GiB local corpus, and Sessions, Dashboard, and Explorer have been
verified in a real browser.

| Phase | State |
| --- | --- |
| 0 — Contract and benchmark gate | Done, including the benchmark (results below) |
| 1 — Catalog, storage, indexer | Done |
| 2 — Summaries and APIs | Done except the Data facet wiring into `server/insights.ts` |
| 3 — Six-view presentation | Shared components, hook, styles, **Sessions**, **Dashboard**, and **Explorer** done; Projects, Models, Data remain |
| 4 — Documentation and verification | Not started |

### Measured against the real corpus

Indexing is enabled in the local database and the server is running on
`http://127.0.0.1:4318`.

| Measurement | Result | Plan gate |
| --- | --- | --- |
| Full backfill, 921 sessions / 1.06 GiB | 3.6 s | — |
| API latency during backfill (1,581 requests) | p50 1.5 ms · p95 6.0 ms · max 21.0 ms | p95 ≤ 100 ms, max ≤ 250 ms ✅ |
| Total-scope reconciliation | delta 0, 95.9% token coverage | exact ✅ |
| Claude-scope reconciliation | delta 0, 66.6% token coverage | exact ✅ |
| Codex-scope reconciliation, ≤ 120 days | delta 0, 98.6% coverage | exact ✅ |
| Codex-scope reconciliation, all time | **delta 26,034,269 (0.8% over)** | ❌ see Open issue #1 |
| Dashboard panel across all five ranges + provider + path-tag scopes | delta 0 in every case | exact ✅ |
| Browser checks (Sessions, Dashboard, Explorer at 2019px) | pass, details below | — |
| Quality counters | 16 parse errors, 51 context gaps, 112 MB skipped | reported, not degrading |
| Session digest | 878 rows, 6 unjoinable, 38 mixed, 89 unknown | ≤ 96 B/session ✅ |

Not yet measured: event-loop delay p95 during backfill (the plan's ≤ 50 ms gate), warm aggregate
p95 over 100+ requests, derived database size, and `/api/dashboard` byte-for-byte comparison.
Given a 3.6 s backfill and a 21 ms worst-case request, none of these look at risk, but they are
unmeasured.

## Open issues, most important first

### 1. Codex over-attributes tokens by ~0.8%, so Codex-scoped charts show no shares

`group=provider` reports Codex `attributed 3,255,197,102` against `eligible 3,229,162,833`.
`foldEffort` correctly refuses to compute shares for that scope and reports the exact delta, so an
unscoped provider-split view renders "Token shares are suppressed" for Codex while Claude and the
combined total reconcile exactly. This is the plan working as designed — it is not clamping a bad
number — but the underlying disagreement is real and unexplained.

**It is confined to history older than 120 days.** Bracketing the timeline basis:

| Codex range | delta |
| --- | ---: |
| 30 days | 0 |
| 120 days | 0 |
| 365 days / all time | 26,034,269 |

So the default view and every range the range picker offers up to 120 days reconcile exactly; only
All time is affected. That points at an older transcript shape rather than a systematic mapping
error, and it is why the Dashboard panel reconciles at every range it can be set to.

The equivalent Claude problem **was** found and fixed (see Deviation #1); this one has not been
diagnosed. Do not add a tolerance. Worth checking first:

- Resumed/forked Codex `rollout` files that replay earlier `token_count` events into a second
  transcript, so two `session_paths` rows legitimately cover the same billable activity.
- ccusage's own Codex session attribution vs. the `session_paths` join (`sessionReportKeys` in
  `server/path-indexer.ts` builds several candidate keys per Codex file).
- Compaction events that emit a `last_token_usage` for work already billed under the prior turn.

Reproduce with the server running:

```sh
curl -s "localhost:4318/api/effort?group=provider" | jq '.rows[] | {key, e:.summary.eligibleTokens, a:.summary.attributedTokens, d:.summary.reconciliationDeltaTokens}'
```

### 2. Phase 2, step 5 — the Data facet is built but unwired

`server/effort-api.ts` exports `sessionsMatchingEffortFacet(snapshot, scope)`, and it is tested,
but nothing consumes it. Still to do:

- Add `effort: string` to `AnalysisScope` in `server/insights.ts` and to `resolveScope()`
  (`"all" | "mixed" | "unknown" | value:<x>`, same validation as `resolveEffortScope`).
- Filter the insight session list by the returned id set. Once a session is selected, every
  existing Data metric uses the **complete** session — the facet must not erase its other values.
- **Only then** add the index version to the `/api/insights` ETag (currently
  `"${collectedAt}:${JSON.stringify(scope)}"` in `server/index.ts`). Adding it earlier would churn
  the ETag for a response that does not depend on the index.

### 3. Three views remain

Projects, Models, Data. Sessions (table/filter/sort/detail), Dashboard (panel + badges), and
Explorer (daily stack + basis toggle + tooltip) are done and are the worked examples.

- **Projects** needs a compact mix per card using project-specific denominators, project detail via
  `group=day&project=<exact normalized path>`, and badges on linked session rows.
- **Models** needs dominant effort + coverage per card, token/observation distribution in expanded
  detail, and badges on linked session rows. Use the model recorded on the provider event; a
  missing event model belongs to Unknown model coverage, not a named model.
- **Data** carries open issue #2 plus the raw analysis section and the provenance/privacy controls.
  `EffortIndexSummary` already renders the counters, and `setEffortIndexing` /
  `deleteEffortDerivedObservations` are the two actions.

Also: `useEffortRefreshOnIndexChange` exists in the hook module but no view calls it yet; wire it
so a completed backfill refreshes the visible group and digest.

### 4. Sessions filter semantics need a decision

The Sessions effort filter currently selects by **dominant** value: choosing "X-high" returns the 11
sessions where X-high dominated, some of which are badged "Mixed". The plan defines `value:x` for
the **Data** facet as "sessions *containing* observed value x". Those two readings differ, and the
session digest only carries the dominant level, so "contains" is not expressible client-side today.

Making them consistent is a contained change: add a level bitmask as a fifth element of the digest
tuple, decode it in `decodeEffortDigest`, and switch `matchesSessionEffortFilter` to test it. Decide
before Data ships, so the same word does not mean two things in two views.

## Files

### Added

| File | Contents |
| --- | --- |
| `server/effort-parse.ts` | `PARSER_VERSION`, per-line Claude/Codex attribution, repeat dedupe, prefilter, gap recording |
| `server/effort-fixtures.ts` | Sanitized transcript builders with `SENSITIVE_SENTINEL` traps |
| `server/effort-store.ts` | Meta/state accessors, atomic span commit, rebuild, delete, grouped SQL |
| `server/effort-index.ts` | Byte-accurate chunked parser, resume hashing, backlog, single-flight scheduler |
| `server/effort-api.ts` | Scope validation, denominators, summaries, digest, facet, ETag, memoization |
| `server/test-setup.ts` + `bunfig.toml` | Pins the test database to a temp path (Deviation #8) |
| `src/effort-model.ts` | `normalizeEffort`, `foldEffort`, ordering, `capEffortLevels`, shared `localDate` |
| `src/provider.ts` | The single `providerFromAgent()` |
| `src/hooks/use-effort.ts` | Status/aggregate/digest hooks, tuple decoder, Sessions filter/sort/search helpers, enable/disable/delete calls |
| `src/components/effort/index.tsx` | `EffortBadge`, `EffortStack`, `EffortCoverage`, `EffortState`, `EffortIndexSummary` |
| Tests | `server/effort-parse.test.ts`, `server/effort-index.test.ts`, `server/effort-api.test.ts`, `src/effort-ui.test.ts` |

### Changed

- `server/migrations.ts` — migration 3; `runMigrations(db, applied?)` gained a second argument so
  a test can stop at migration 2.
- `server/path-indexer.ts` — `indexSessionPaths()` returns `{ catalog, changed, removedSessionIds,
  indexed }`, persists `source_size` and device/inode identity, and prunes rows under the two
  managed roots only after both globs complete.
- `server/collector.ts` — feeds the catalog to the indexer, schedules indexing in a
  `queueMicrotask` after a successful snapshot, uses the shared `localDate` / `providerFromAgent`.
- `server/insights.ts` — uses the shared `providerFromAgent`.
- `server/index.ts` — the five effort routes; session detail returns `effort`.
- `src/types.ts` — the effort contracts; `SessionDetail.effort`.
- `src/App.tsx` — `globalEffortScope()`, the Sessions view, `SessionDetailPanel`, `Overview`,
  `EffortByDay`, and `EffortDayTooltip`.
- `src/styles.css` — effort styles, the ninth-column widths for the Sessions table, the Dashboard
  panel / Latest-sessions badge column, and a `min-width:1181px` block that widens two
  `dashboard-grid` panels (see below).

### What the Sessions view does now

- Effort column with a per-session badge, sortable by canonical order (`low, medium, high, xhigh`,
  other values alphabetically, Unknown always last). Mixed sessions read "Mixed" with the full
  distribution in the tooltip.
- All / each observed value / Mixed / Unknown filter, disabled when indexing is off.
- Effort joins the search haystack, so "mixed" and "unknown" are findable as words.
- Expanded detail gains an EFFORT section: stacked distribution, every known value with tokens and
  observations, the Unknown row, coverage, dominant basis, and parser-version provenance.
- `colSpan` 8 → 9, keyboard label includes the effort value, and the empty state names the active
  effort filter.
- The digest is requested **unscoped** (`useEffortSessions({})`): it describes every dashboard
  session, and the view already receives the range/provider/path-filtered subset it renders.

### What the Dashboard does now

- An **Effort mix** panel in `dashboard-grid`: stacked distribution including Unknown, a coverage
  caption, and the help text spelling out "provider-recorded reasoning effort". Headline token and
  cost cards are untouched, as the plan requires.
- A badge on every **Latest sessions** row, hidden below 620px alongside the path tags rather than
  crushing the row — the value is still on the Sessions table and in session detail.
- Both follow the global range, Agent, and path-tag controls through
  `globalEffortScope(agent, metricRange, pathTag)`, which Explorer should reuse verbatim. `Overview`
  gained a `pathTag` prop for this.
- The panel reads `effort.status` from the aggregate response rather than calling `useEffortStatus`
  separately, so the view costs one status request fewer.
- **Layout change requested by the repo owner, 2026-07-29.** At the three-column desktop grid
  (`1fr 1fr 330px`), Effort mix occupied only column 2 and Latest sessions only columns 1–2, leaving
  the 330px third column empty on both rows. They now span through it:

  ```css
  @media (min-width:1181px){
    .dashboard-grid .effort-panel{grid-column:span 2}
    .dashboard-grid .recent-panel{grid-column:1/-1}
  }
  ```

  Measured after the change: Effort mix 678 → 1020px (columns 2–3), Latest sessions 1367 → 1709px
  (full grid width), nothing overflowing, and the effort stack bar 636 → 978px.

  **The `min-width` gate is load-bearing — do not flatten these into the base rules.**
  `.dashboard-grid .recent-panel` has specificity (0,2,0) and would outrank the existing narrow
  overrides `.recent-panel{grid-column:auto}` at ≤900px and `.panel-wide,.agent-panel{grid-column:
  auto}` at ≤1180px, silently changing the two-column and single-column layouts. Gating on
  `min-width:1181px` keeps every narrow rule working untouched; that was verified through the CSSOM.
  This also let a now-redundant `@media (max-width:1180px){.effort-panel{grid-column:auto}}` rule be
  removed, since `.effort-panel` never carried `panel-wide`'s `span 2` to counteract.

### What Explorer does now

- An **Effort by day** panel between the provider timeline and the split grid, so Model signals and
  Token composition are untouched. Stacked bars, one series per kept value plus Unknown.
- Tokens / Observations toggle, defaulting to Tokens.
- Tooltip shows the day, the provider scope, that day's coverage, and each value with its swatch,
  amount, and day share.
- `buildEffortDaySeries` in `src/effort-model.ts` chooses the kept values **once across the range**
  rather than per day, so a value cannot change colour or vanish between adjacent bars; the
  remainder collapses into `Other` and day totals are preserved. A day whose reconciliation failed
  draws nothing and is counted in a caption instead of showing a zero stack.
- `sharePercent` renders a present-but-tiny slice as `<1%` rather than `0%`, which read as "nothing"
  for rows that were plainly listed in the tooltip.

### Browser verification performed

At 2019×1262, against the real indexed corpus:

- **Dashboard** — panel 678×215, no overflow; stack segments sum exactly to the stack width
  (636 = 636, no rounding gap); five distinct colours with Unknown neutral; `role="img"` with a full
  accessible name; the screen-reader summary is correctly visually hidden; legend carries text
  labels; five Latest-sessions badges with titles and no row overflow.
- **Sessions** — 9 headers and 9 body cells (colSpan alignment correct); Effort column at index 6,
  sortable, `aria-sort` present; filter options in canonical order (`all, low, medium, high, xhigh,
  mixed, unknown`) with accessible name "EFFORT"; filtering gives Mixed 32, Unknown 86, X-high 11
  sessions; ascending sort puts Low first and Unknown last; row `aria-label` reads "…, effort high";
  expanded detail has `colspan=9`, a fifth EFFORT section with both levels, coverage, and parser
  provenance; no cell overflow.
- **Explorer** — five stacked series (Low, Medium, High, X-high, Unknown) with the expected fills;
  toggle defaults to Tokens and re-renders on Observations; axis ticks format correctly; tooltip
  shows day, "All providers · 100% of tokens attributed", and per-value amounts and shares; Model
  signals and Token composition intact.

**Narrow-width rendering was not verified.** The preview tool's viewport resize timed out
repeatedly, so only the CSS rules were confirmed present and correctly ordered via the CSSOM
(`.session-effort` hides with `.path-tags` at ≤620px; `.session-detail__grid` collapses 5 → 3 → 2
columns at 1180px and 900px, with the appended rules winning the cascade as intended). Actual
narrow rendering, 150% Data text, and reduced motion still need a human pass.

## Deviations from the plan, and why

1. **Claude repeated responses are de-duplicated; this is a parser contract addition.** The plan's
   Claude contract says one supported assistant event increments observations once, and says
   nothing about repeats. Real transcripts write one logical response as several *contiguous*
   assistant events sharing a `requestId`/`message.id` and carrying the same cumulative usage —
   in one sampled file, 31 events for 11 responses, a 165% over-count. ccusage counts such a
   response once. `EffortParserState.lastUsageKey` now carries the last key across chunks and
   spans, and a contiguous repeat is skipped entirely. A 41-file survey found 685 repeated keys
   and **zero** non-contiguous ones, which is why a single carried key is exact rather than a
   per-session seen-set. `PARSER_VERSION` is 2; `session_effort_state.last_usage_key` persists it.
   If a non-contiguous repeat is ever observed, this becomes wrong and needs the seen-set.
2. **Quality counters no longer degrade the whole index.** `buildEffortStatus` originally set
   `quality: "degraded"` whenever any parse error, context gap, or skipped byte existed. On the
   real corpus that is always true, and `EffortStack` blanks its chart on `degraded` — so every
   chart would have rendered empty. Status quality is now `degraded` only for a real
   `lastError`; counters are reported on their own, and share suppression is keyed on
   `reconciliationDeltaTokens > 0`, which is exactly the case `foldEffort` refused to compute.
3. **Enabling now awaits a snapshot before scheduling.** The backlog joins the path catalog
   against parser state, and the catalog is only populated by a successful collection. Enabling
   before the first refresh found nothing to do and reported "ready" with zero sessions. The
   `PUT /api/effort/settings` handler now awaits `getSnapshot()` — never the parsing it schedules.
4. **An over-limit line is never decoded.** The plan says a malformed or over-limit line
   *containing a provider marker* creates a gap. Recovering the marker from a >4 MiB line would
   mean buffering exactly the bytes the limit refuses, so any line over the limit is a gap and
   clears Codex attribution. Real data hits this: one Codex transcript contains ten lines between
   4.9 MB and 13.1 MB, and 112 MB is skipped corpus-wide across 16 gaps. Note the carried buffer
   can reach ~2× `MAX_LINE_BYTES` before the limit trips, and `parseErrors` under-counts gaps when
   several oversized lines appear in one file (`skipped_bytes` is the accurate signal).
5. **Resume-boundary verification for skipped files is once per process.** Invariant 2 requires the
   boundary hash to agree before a file is skipped; checking it every 60 s would re-read 4 KiB for
   ~920 transcripts a minute forever. `verifiedBoundaries` verifies each session once per process
   and relies on size+mtime afterwards. Append resumes are always verified, every time.
6. **`group=day` denominators have two sources.** With no path/project/model scope they come from
   `snapshot.daily`, so Explorer's effort stack and its token chart share one denominator. With a
   path, project, or model scope they fall back to allocating each session's tokens to its
   last-activity day, as the existing path-filtered views do. A session straddling midnight can
   over-attribute a day; that surfaces as an exact delta and suppressed shares, not a clamp.
7. **The provider mapper changed collector behaviour.** `server/collector.ts` previously did not
   recognise `openai`-flavoured agent labels as Codex; `server/insights.ts` did. They now share
   `src/provider.ts`. Covered by a regression test; **still needs a CHANGELOG entry.**
8. **Test database isolation was added.** Bun runs every test file in one process, so whichever
   file imported `server/store.ts` first decided the database path for all of them — a suite that
   truncates tables could truncate the developer's real `.usage-observatory/data.db`. This was hit
   during execution. `bunfig.toml` preloads `server/test-setup.ts`, which pins
   `USAGE_OBSERVATORY_DB` to a temp directory before any test module loads. Do not remove it, and
   do not set that env var inside an individual test file.
9. **Session selection is identical for both bases.** Only whether the day filter reaches the
   derived rows differs (`effortQuery()` passes `fromDate` for `timeline`, `null` for `sessions`).
10. **No `Worker` was added**, per the plan's instruction to wait for a measured problem. The
    measured backfill does not suggest one is needed.
11. **`session_paths.source_size`** is added by an `ALTER TABLE` guarded by `PRAGMA table_info`,
    and back-filled lazily by `indexGlob` when an unchanged file's recorded size is stale.

## Things worth knowing before you touch the indexer

- `session_effort_usage` rows are keyed `(session_id, occurred_on, model, effort)` with `''`
  sentinels for missing values. `server/effort-store.ts` is the only place those become `null`.
- Every upsert is additive. A span commit must be the only thing that advances `last_offset`, or a
  crash between the two will double-count.
- `buildBacklog()` is recomputed from catalog + state every pass; there is no queue to keep in
  sync. A session that can make no progress (its only new bytes are an unterminated final line) is
  parked for the current drain via the `stalled` set and retried on the next refresh.
- Bumping `PARSER_VERSION` rebuilds every session from byte zero. Adding a column to
  `session_effort_state` needs a **new** migration once migration 3 has shipped; while it is still
  uncommitted, editing migration 3 in place is fine (drop the three effort tables and reset
  `PRAGMA user_version = 2` to re-run it locally).
- `foldEffort` in `src/effort-model.ts` is the only place effort arithmetic happens. If a view
  needs a number that is not on `EffortSummary`, add it there rather than computing it locally.

## Verification

```sh
bun test
bun run typecheck
bun run build
```

The app is running at `http://127.0.0.1:4318` with indexing enabled and the corpus fully indexed.
