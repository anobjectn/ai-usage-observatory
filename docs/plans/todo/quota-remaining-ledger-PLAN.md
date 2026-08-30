# Quota Remaining Ledger — Plan

**Status:** Executed 2026-08-29 (all slices §2–§8, including the §7 model-window follow-up).
Verified: `bun run typecheck`, `bun test` (396 pass), `bun run build`, plus a read-only live
check of the sessions view, detail panel, sort gating, reset dividers, and the de-duplicated
`/api/quota-comparisons` report against the running dev server.
**Date:** 2026-08-29
**Baseline:** `main` @ `4f47762`, clean working tree
**Verification bar:** `bun run typecheck`, `bun test`, `bun run build`, plus a read-only live check
against the already-running dev server at `http://127.0.0.1:5173` (sessions view under each sort
key, a session spanning a 5h reset, a Codex session, the detail panel, the Evidence panel links).
Do not restart or rebuild the user's running dev server or quota-service.

## Motive

The session rows' "Quota impact" column shows a summed `+N%` that reads as per-session
consumption. The number is actually a bracketed **account-level** gauge delta over the session's
activity episodes (`server/session-quota-context.ts`), summed across quota cycles. Concurrent
sessions each carry the full shared account movement, and cross-cycle sums never correspond to any
gauge state — so the column visibly "contradicts" the live 5h/weekly gauges. Verified with real
data: two overlapping sessions claimed +23pp and +20pp of a 5h window that only moved ~29pp, and
one of them summed +6pp from an already-reset window into its total.

The redesign replaces the attribution claim with observations, in bank-statement form: a balance
column ("quota remaining at session end") and directional per-cycle ranges in the detail panel.

## Decisions (locked)

1. **Balance column** ("Quota left") immediately left of the datetime column, shown **only when
   `sort.key === "activity"`** (either direction). The datetime column shows `lastActivity` and
   activity sort orders by it (src/App.tsx:5977, 6229), so the timestamp ≈ session end and rows are
   in end-time order — the ledger reading is coherent there and nowhere else.
2. **Remove the in-row "Quota impact" summary column entirely.** No compressed range in the row.
3. **Remaining orientation everywhere** (`100 − usedPercent`): balance and ranges both fall as
   quota is consumed and jump back to 100 at resets.
4. **Detail panel shows movement as per-cycle ranges in remaining terms**, split at resets, never
   summed across cycles — e.g. a session spanning a reset renders `25→0, 100→75`. Collapse a
   session's multiple episodes within one cycle to a single first-start→last-end range (idle-gap
   movement is absorbed; the account-level caveat covers it; optionally note the episode count).
5. **Wide end gaps reuse `.is-low` styling** on the balance cell: when `endGapMs` exceeds the
   medium-confidence threshold already used by `confidenceFor` (`max(5min, cadence × 3)`), the
   balance renders in the existing low-confidence orange (src/styles.css:586-593).
6. **Reset divider rows** between adjacent rendered rows whose 5h (or weekly) cycle changes, only
   under activity sort: a thin row like `5h window reset · Sat 19:10`. Derive the instant from the
   `cycleId` (`reset:<ms>`); render with `<time>` markup consistent with commit 03ab850.
7. **Balance cell layout is vertical**, a 2-row mini table, not inline text:
   ```
   5h  71%
   w   76%
   ```
   For unit-based resources, show units where the provider is unit-accurate:
   ```
   412 credits
   remaining
   ```
   Warp monthly pool → credits remaining (`limitUnits − usedUnits`). Codex sessions resolve via
   embedded `rate_limits` percentages, which carry the 5h/weekly windows but not the credit
   balance — Codex cells therefore show the two window percentages; do not fabricate a credits
   row from the live gauge (wrong point in time).
8. **Counter-decrease cycles stay blanked-with-reason** in the detail panel (a mid-cycle decrease
   signals a missed reset or provider correction, not real recovery). The **balance** for such a
   session may still render when the end bracket itself is valid.
9. **Model-window (Fable) countdown** is in scope as a follow-up slice (§7); display it in the
   balance cell only when it diverges from the generic weekly remaining (it is a stricter
   sub-limit; when equal it is redundant). Always list it in the detail panel when resolved.
10. **All copy rewritten** for the observational/remaining vocabulary (§8).

## Recommended executor

**Claude (Fable 5 or Opus 5) as one persistent agent in Claude Code, effort `xhigh`.** The
hard part of this plan is not volume but semantics: the §2 end-balance rules interact with the
existing bracket/tolerance/inconsistency policy in `session-quota-context.ts`, and the §8 cycle
de-duplication must preserve the module's documented non-additivity guarantees. That favors the
most capable available model over a faster one, and one agent over a fan-out:

- Keep a single agent responsible for all slices. `src/App.tsx` and `src/styles.css` are shared
  by §3–§6 (same reasoning as the ui-polish-batch plan), and §2's payload shape feeds every UI
  slice — parallel executors would conflict on both files and on the type contract.
- Execute server slices first (§2, §8 + tests), then UI (§3–§5), then copy/tests (§6), then §7.
- The session that authored this plan already verified the live data paths (comparison report
  contents, `/history` contract, `quota.db` schema); executing in that session preserves that
  context. A fresh session should re-read this plan plus `server/session-quota-context.ts`,
  `server/quota-comparisons.ts`, and the display sites listed in §3–§5 before editing.
- An independent review pass (e.g. `/code-review high`) after the full verification bar is
  worthwhile given the policy-math changes in §8.

## §1 — Decided (option B): de-duplicate `quota-comparisons` movement per cycle

### What it affects (investigated)

`buildAllowanceComparisonReport` (server/quota-comparisons.ts:63-151) groups sessions into
provider+plan+resource cohorts and **sums per-session account deltas** (`totalPp`,
`totalCredits`). Because overlapping same-provider sessions each carry the full shared account
movement, and `resolvedCycles` counts a shared cycle once per session, the cohort denominators are
inflated.

**UI surface: exactly one touchpoint.** The report is served at `GET /api/quota-comparisons`
(server/index.ts:221-222) and the only UI reference is the **"Observed tier cohorts" raw-JSON
link** in the Evidence panel (src/App.tsx:8239-8241). Nothing in the dashboard renders these
numbers as charts, cards, or insights. The blast radius is an export endpoint, not a visible
dashboard element.

**Affected fields and error direction** (denominator inflated ⇒ per-pp ratios understated):

| Field | Error |
| --- | --- |
| `metrics.observedPercentagePoints` / `observedCredits` | overstated (double-counted movement) |
| `apiEquivalentUsdPer100PercentagePoints` | understated — quota points look cheaper than they are |
| `outputTokensPer100PercentagePoints`, `activeMinutesPer100PercentagePoints` | understated |
| `warpManagedTokensPer100Credits`, `activeMinutesPer100Credits` | understated |
| `resolvedCycles`, `sessionsPerResolvedCycle` | cycle double-counting across overlapping sessions |

### Decision

**Option B — de-duplicate account movement per cycle — plus the option-D disclosure fields.**
(Alternatives considered and rejected: A excluded overlapped samples, shrinking cohorts below the
5-sample floor under this account's heavy concurrency; C merged overlapping sessions into group
samples, most code and a change of sample semantics; D alone disclosed without fixing.)
Implementation is slice §8 below.

## Implementation slices

### §2 — Server: end-of-session balance per resource

`server/session-quota-context.ts` + `src/types.ts`:

- Add per-resource fields: `endUsedPercent: number | null`, `endObservedAt: number | null`,
  `endUsedUnits: number | null`, `limitUnits: number | null` (pools), `endGapMs: number | null`.
- Populate from the last valid point of the session's last resolved cycle (the `after` bracket for
  `bracketed_account_delta`; the last inside observation for `embedded_account_observation`).
- **Keep the end fields populated in the two cases where deltas are blanked**: counter-decrease
  (`inconsistent`) cycles and sub-tolerance movement. The balance is an observation, not a delta;
  it stays valid. Unresolved brackets (no `after` within the 30-min idle tolerance) → `null`.
- Unit tests in `server/session-quota-context.test.ts`: end fields for a normal session, a
  reset-spanning session, an inconsistent-cycle session, an unresolved session, a pool session.

### §3 — UI: balance column

`src/App.tsx` + `src/styles.css`:

- New column header "Quota left" immediately left of the datetime column, rendered only when
  `sort.key === "activity"`; hide the whole column (header + cells) under other sorts.
- Cell: 2-row vertical mini table per decision 7; `--` row when a resource's end balance is null;
  empty cell (with tooltip reason) when no resource resolved. Remaining = `100 − endUsedPercent`.
- Low-confidence styling per decision 5 (`.is-low` when `endGapMs > max(5min, cadence × 3)`).
- The existing batch fetch (`POST /api/session-quota-contexts`, src/App.tsx:5994-6023) already
  loads the needed payload per page; it now feeds the balance column instead of the impact column.

### §4 — UI: remove the impact column, add reset dividers

- Remove the "Quota impact" header (src/App.tsx:6188-6193), the row cell
  (`session-row__quota`, 6300-6304), `sessionQuotaImpactItems` (4801) and
  `SessionQuotaImpactCell` (4814); prune orphaned styles.
- Reset dividers per decision 6: while rendering `pageRows` under activity sort, compare adjacent
  rows' 5h and weekly `cycleId`s (from their contexts); when they differ, insert a non-interactive
  divider row labeled with the window and localized reset time. Skip when either context is
  missing. Dividers are per rendered page; do not attempt cross-page continuity.

### §5 — Detail panel: per-cycle ranges

Rework `SessionQuotaContextPanel` (src/App.tsx:4848):

- Per resource, render per-cycle ranges in remaining terms, oldest→newest, comma-joined:
  `25→0, 100→75` (`%` remaining; pools in units: `510→412 credits`). One range per cycle
  (episodes collapsed); small text keeps cycle count, episode count, and confidence.
- Keep blank-with-reason rendering for inconsistent cycles (decision 8), the concurrency line,
  the evidence/cadence line, and the confidence chip.
- End with the balance line: "Ended at 71% remaining (5h) · 76% (w)".

### §6 — Copy rewrite (decision 10)

All `+N`-era copy is replaced with observational/remaining vocabulary:

- Column header tooltip (was src/App.tsx:6188-6193): e.g. "Account quota remaining when this
  session ended. The account is shared — other sessions, devices, and surfaces move the same
  counter."
- Cell tooltip (was 4836) and empty-state reasons.
- "How to read this" (4906-4913): drop the `+10%` explanation; explain ranges ("`25→0, 100→75`
  means the account counter fell from 25% to 0% remaining, the window reset, then fell from 100%
  to 75% while this session was active"), non-additivity across overlapping sessions, and the
  balance semantics.
- `README.md:337-348`, `docs/ARCHITECTURE.md:105`.
- Update wording assertions in `src/App.test.ts:456, 499, 551`; add tests for: column gated on
  activity sort, vertical cell layout, divider insertion between cycle-crossing rows, per-cycle
  range rendering including a reset-spanning session, blanked-cycle rendering, `.is-low` on wide
  end gap.

### §7 — Follow-up: model-window (Fable) resource

Feasibility (verified 2026-08-29):

- Local `~/.quota-service/quota.db` stores full snapshots including
  `modelWindows: { Fable: { usedPercent, resetsAt } }` — 17,415 anthropic rows back to mid-July.
- The quota-service HTTP `/history` normalization **drops model windows** (observations carry only
  `fiveHour`/`weekly` ids — verified against the live endpoint), and the HTTP path takes
  precedence over the local-db fallback in `collectRawQuotaHistory`.

Plan: make this repo generic, then close the HTTP gap:

- `normalizeLocalObservation` (server/quota.ts:185-192): also emit `snapshot.modelWindows`
  entries as window points with id `model:<name>` and the same cycle rounding.
  `pointsFromHistory` (server/session-quota-context.ts:40) is already id-generic; resources flow
  through automatically. Add labels in `quotaResourceLabel`; reuse the anthropic window tolerance.
- Connected-path gap, two options: **(i)** extend quota-service's `/history` normalization to
  include model windows (companion-repo change, cleanest); **(ii)** in-repo supplement — after a
  successful HTTP fetch, read only model-window points for the same range from the local db and
  merge. Recommend (ii) now (keeps the feature self-contained; the db is already read as a
  fallback) and (i) as the durable fix.
- Display per decision 9: detail panel always when resolved; balance cell only when the model
  remaining diverges from weekly remaining.

### §8 — Comparisons: per-cycle de-duplication (decision §1 = B + D disclosure)

`server/quota-comparisons.ts`:

- In `buildAllowanceComparisonReport`, replace the per-sample summing of
  `deltaPercentagePoints`/`deltaUnits` with per-cycle accounting: within each cohort, collect all
  accepted members' `resources[].episodes[]`, group by `cycleId`, and count movement **once per
  cycle** as `max(endUsedPercent) − min(startUsedPercent)` (units analog for pools:
  `max(endUsedUnits) − min(startUsedUnits)` when both ends are present). Valid because episode
  endpoints are monotone readings of one account counter within a cycle.
- Workload numerators (cost, output tokens, active minutes, Warp-managed tokens) stay summed per
  session, unchanged. `resolvedCycles` = count of **distinct** cycles;
  `sessionsPerResolvedCycle` follows from it.
- Skip synthetic `observed:` cycle ids in the union (they cannot be matched across sessions);
  treat each as its own cycle keyed by session+id, as today.
- D disclosure: add per-cohort `overlappedSamples` (members with
  `concurrency.maxOtherSameProviderSessions > 0`) and extend the report `note`: movement is
  de-duplicated per account quota cycle; workload totals are per-session; session cost is
  whole-session while cycle membership can be partial.
- Unit tests: two overlapping sessions in one cycle must yield cycle movement equal to the union
  (not the sum); a session alone in its cycle is unchanged; mixed multi-cycle cohorts;
  `overlappedSamples` counting; Warp units path. Assert against the previously inflated totals
  (e.g. two members claiming 23pp and 20pp of one cycle whose counter moved 0→28 must contribute
  28, not 43).

## Explicit non-goals (unchanged from session-quota-context-PLAN-FINAL)

- Exact causal attribution of account movement to one local thread.
- Proportional allocation among concurrent sessions.
- Attributing external (web/mobile/other-machine) activity.
