# Data & Sources Usage Introspection — Final Plan

**Status:** Final — ready to implement
**Date:** 2026-07-26
**Supersedes:** `data-sources-usage-introspection-PLAN.md` (draft)
**Baseline:** v1.4.0
**Scope:** Turn the Sources view into a local-first usage-introspection surface,
with supporting additions to Models, delivered in four independently shippable
releases.

---

## What changed from the draft

The draft is directionally right and its privacy posture is kept intact. This
version changes six things after reading the current code:

1. **Phase 1 scope is corrected against real data availability.** The draft
   assumes Phase 1 can filter by model, reasoning effort, and root/subagent
   class "where available." None of those exist in the current data path.
   `ccusage` session rows carry only agent, period, token buckets, cost, and
   model breakdowns (`server/schema.ts`); the path index adds `cwd` and tags
   (`server/path-indexer.ts`). Effort, subagent class, compaction, and tool
   counts are Phase 2 by necessity, not by preference.
2. **A blocking gap in Allowance Capture is identified and given a fix.**
   `summarizeQuotaHistory()` (`server/quota.ts`) reduces the quota-service
   snapshot table to *reach events* — it discards the `usedPercent` time series.
   Allowance Capture's utilization, pacing, and "tokens per quota point"
   components cannot be computed from what the adapter currently returns. Phase 1
   must extend the history reader before it can grade anything.
3. **A–F letter grades are dropped** in favour of a 0–100 score plus a
   three-state band. The draft simultaneously assigns school grades and insists
   the grades "are not quality judgments." The band wording removes the
   contradiction without losing scannability.
4. **All six "decisions to confirm" are resolved**, with rationale. A final plan
   should not hand the implementer an unresolved product question.
5. **Structural constraints are made explicit.** `src/App.tsx` is 5,961 lines and
   already holds every view. This feature roughly doubles the view's surface
   area; the plan now requires extraction into `src/views/` rather than leaving
   it as an implicit choice. Analysis math lives on the server only.
6. **Hard limits from the collection layer are stated up front**: a 120-day
   maximum analysis window, Claude-only five-hour blocks, and Codex's absent
   cache-creation reporting all constrain what can be graded and are surfaced as
   confidence inputs rather than silently absorbed.

---

## Objective

Help the user see whether their actual behavior matches how they *intend* to use
their AI subscriptions, and surface timely, evidence-backed actions when it does
not.

Non-negotiables:

- Grade distinct usage goals separately; never emit one universal "efficiency."
- Show the raw measurements, weights, confidence, and provenance behind every
  score.
- Compare providers only where units are genuinely comparable.
- Show whether a handful of outlier sessions changed a conclusion.
- Prefer locally derived evidence; no new external integrations before Phase 4.
- Keep prompt, response, reasoning, command, and file text out of SQLite —
  permanently, in every phase.

### Non-goals

- No quality judgment of the user's work, and no provider-recommended targets
  presented as authoritative.
- No cross-provider "who is more efficient" ranking of raw tokens.
- No live control of a running session (compact, stop, switch model).
- No network transmission of anything, in any phase, including Phase 4.
- No task/topic classification of prompt content. (README's "Not here yet" list
  stays accurate on this point; the observation index counts events, it does not
  categorize what the user was doing.)

---

## Evidence that motivated the feature

From the July 26 investigation. These are illustrative, not thresholds — every
number below must be recomputed from the selected range at runtime.

| Observed signal | Why it matters |
| --- | --- |
| Claude hit its five-hour limit 8 times from Jul 12–25 while the weekly meter peaked at ~60–62% | Quota-bound by burst shape, not weekly capacity. |
| 503M Codex tokens vs 323M Claude, but output was 2.19M vs 2.08M | Raw cross-provider totals imply a gap that composition does not support. |
| Cache reads were 93% of Codex and 96% of Claude recent tokens | Cache volume dominates headline totals and needs separate interpretation. |
| Sol produced 82% of recent Codex tokens; median Sol session 1.94M vs Terra 573K | Model mix and task allocation explain more than provider identity. |
| Codex guardian/subagent runs were 45% of sessions but 4% of tokens | Session counts must separate user work from internal support work. |
| 2 of 115 Claude sessions compacted, both automatically at ~329K and ~440K | Waiting for auto-compaction can resend a large context for many turns. |
| Claude sessions with >5 prompts were 21% of sessions but 60% of tokens | A small long-session cohort skews every aggregate. |

Note which of these Phase 1 can actually reproduce: rows 1–4 and 7 (partially —
prompt counts are Phase 2, but token-size cohorts are available now). Rows 5 and
6 require the observation index.

---

## Current system: what exists, and the exact gaps

### Available today

| Capability | Location |
| --- | --- |
| Daily/weekly/monthly/session token, cache, cost, and per-model breakdowns | `server/ccusage.ts`, `server/schema.ts` |
| Unpriced-model detection (tokens > 0 with cost === 0) | `findUnpricedModels()` |
| Session → cwd/tag/annotation join | `server/path-indexer.ts`, `server/collector.ts` |
| Provider quota snapshots, observed limit reaches, consumed Codex resets | `server/quota.ts` |
| On-demand transcript detail (prompts, tools, patches, file counts) | `server/session-detail.ts` |
| Per-model totals in the dashboard | `aggregateModels()` in `server/collector.ts` |
| Global filters: date range, agent, path tag, cache on/off | `src/App.tsx` (`days`, `agent`, `pathTag`, `showCache`) |
| 60s snapshot cache with ETag; last-good-on-failure | `getSnapshot()` / `refresh()` |

### Gaps, precisely

1. **`aggregateModels()` drops `cacheCreationTokens`.** The accumulator in
   `server/collector.ts` sums input/output/cacheRead but never cacheCreation,
   even though `modelBreakdownSchema` carries it and `modelTokens()` includes it
   in the total. `DashboardData.models` in `src/types.ts` has no such field. The
   result: cache *writes* are inside the total but invisible as a component, so
   read/write amortization cannot be shown. One-line-ish fix, high value.
2. **Quota history has no percentage series.** `summarizeQuotaHistory()` reads
   `snapshots` from quota-service's SQLite and emits only `reachedAt` timestamps,
   `reachedCount`, and `trackingSince`. Utilization-before-reset, pacing across
   windows, and tokens-per-quota-point all need `(provider, window, capturedAt,
   usedPercent, resetsAt)`. **This must be built before Allowance Capture can be
   graded.**
3. **Five-hour block data is Claude-only.** `blockScope` is the literal string
   `"Claude Code"` and `ccusage blocks --recent` backs it. Codex pacing must come
   from quota history alone, at lower confidence. Never present a Codex five-hour
   figure sourced from blocks.
4. **The analysis window is hard-capped at 120 days.** `collectCcusage()` passes
   `--since` = now − 120 days. Any range control must clamp to that and say so.
5. **Codex reports no cache-creation tokens** through the pinned `ccusage`
   integration. Read/write amplification must be `N/A` for Codex, never `∞` and
   never "perfectly efficient."
6. **No transcript-derived aggregates are indexed.** Effort, root/subagent class,
   compaction, tool counts, patch sizes, and completion events exist only inside
   the on-demand `getSessionDetail()` read, which persists nothing.
7. **No insight, advice, dismissal, snooze, or outcome tables** in
   `server/store.ts`, and **no schema migration mechanism** — tables are created
   with inline `CREATE TABLE IF NOT EXISTS` and defaults are seeded by ad-hoc
   existence checks.
8. **The README's privacy promise is explicit and currently true**: "Nothing from
   that read is written to the database." Phase 2 changes that boundary and
   cannot ship without the disclosure, controls, and default described below.
9. **`src/App.tsx` is 5,961 lines** with every view inline (`Sources` begins at
   line 4480). Adding profiles, signals, evidence drawers, and an advice feed
   inline is not viable.

---

## Resolved decisions

The draft left six decisions open. All are resolved here so implementation can
start. Each is reversible; none blocks Phase 1.

| # | Decision | Resolution | Rationale |
| --- | --- | --- | --- |
| 1 | Nav label | **Rename nav item to "Data"**; page title "Usage intelligence & provenance"; keep `?view=sources` and the existing `limits → sources` legacy redirect | The route is already stable and aliased (`src/App.tsx:206`); only the label changes. "Sources" understates a page that now grades behavior. |
| 2 | Score presentation | **0–100 score + band (`On target` / `Drifting` / `Off target`) + explicit `N/A`.** No A–F letters. | A–F reads as a quality verdict, which the feature explicitly is not issuing. Bands scan just as fast and match the "optimization lens" framing. |
| 3 | Outlier default | **All sessions is the primary result**, with a persistent "without outliers" delta shown beside every score | Hiding data by default is the failure mode this feature exists to prevent. The delta makes sensitivity a first-class, always-visible fact. |
| 4 | Observation indexing default | **Opt-in, default off**, with an in-app disclosure card explaining exactly what is stored and what is not | The README makes an unconditional promise today. Flipping it on during an upgrade would break stated behavior silently. One click to enable is a small cost for keeping the promise honest. |
| 5 | Verification categorization | **Defer to Phase 3.** Phase 2 stores completion and patch evidence only | Command-name inspection is the most privacy-sensitive parser and the least valuable without manual labels to calibrate it. |
| 6 | Custom profile weights | **Ship fixed, versioned presets in Phase 1–2**; add custom weights in Phase 3 alongside the Frontier "largest model regardless of cost" preset | A score whose weights the user can change before there is any calibration data is unfalsifiable. Version the rubric (`rubricVersion`) from day one so later changes are visible rather than retroactive. |

---

## Information architecture

Keep the `?view=sources` route; label the nav item **Data**; title the page
**Usage intelligence & provenance**.

Three sections, in this order:

1. **Profiles** — goal-specific scores and their evidence.
2. **Signals** — quota pacing, cache/context behavior, model mix, outliers, and
   the advice feed + log.
3. **Sources** — the existing provider/local distinction, source health, quota
   provenance, and raw normalized-data links. Semantics unchanged; it moves
   below the new content without being rewritten.

Provenance is never behind a modal. Every score and message deep-links to the
sessions or source panel that produced it, and returning preserves the analysis
scope.

---

## Analysis scope

One scope object drives every profile, signal, and Models figure, so displayed
values cannot drift between views.

```ts
type AnalysisScope = {
  rangeDays: number;          // clamped to [1, 120] — collector's --since ceiling
  provider: "all" | "anthropic" | "codex";
  pathTag: string;            // "all" | tag
  cache: "include" | "exclude";
  outliers: "all" | "typical" | "only";
  // Phase 2+ only; absent fields mean "not yet observable", never "no filter matched"
  model?: string;
  effort?: "low" | "medium" | "high";
  sessionClass?: "root" | "subagent" | "both";
};
```

**Phase 1 supports** `rangeDays`, `provider`, `pathTag`, `cache`, `outliers`.
**Phase 2 adds** `model`, `effort`, `sessionClass`.

Defaults: current global range; every provider scored separately; cache included
with direct and cache traffic shown apart; all sessions with an adjacent
without-outliers delta; internal/subagent work excluded from behavior scores and
reported as its own contribution (Phase 2 onward — until then, say so).

Whenever a filter changes a score, show sample count, token share, and excluded
share in plain language:

> 12 outlier sessions are 4% of sessions and 38% of processed tokens. Excluding
> them moves Context & Cache from 71 to 78.

Reuse the existing global controls (`days`, `agent`, `pathTag`, `showCache`)
rather than introducing a parallel filter bar; add only `outliers` and, in Phase
2, the three new dimensions.

---

## Usage profiles

No single overall score, in any phase. A user maximizing frontier intelligence is
deliberately making a different trade than one maximizing volume; averaging them
produces a number that means nothing.

Every profile returns:

```ts
type Profile = {
  id: string;
  rubricVersion: string;          // e.g. "allowance-capture@1"
  score: number | null;           // null when confidence === "insufficient"
  band: "on-target" | "drifting" | "off-target" | null;
  confidence: "high" | "medium" | "low" | "insufficient";
  components: Array<{
    id: string; label: string; weight: number;
    value: number | null; normalized: number | null;
    evidence: Record<string, number | string>;
    unavailableReason?: string;
  }>;
  previousPeriod: { score: number | null; delta: number | null };
  withoutOutliers: { score: number | null; delta: number | null };
  explanation: string;            // plain language, no color dependency
  links: Array<{ label: string; href: string }>;
};
```

Bands: `on-target` ≥ 80, `drifting` 60–79, `off-target` < 60. Never emit a band
when confidence is `insufficient` — show `N/A` and name the missing evidence.

Confidence is derived, not authored: it degrades with missing quota snapshots,
unpriced models, sessions with no `cwd`, cohorts below minimum size, ranges
shorter than one full provider reset cycle, and (Phase 2+) observation coverage
below a threshold. **Missing evidence lowers confidence; it never lowers score.**

### 1. Allowance Capture — Phase 1

*How much included capacity became useful activity without repeatedly hard
stopping?*

| Weight | Component | Source |
| --- | --- | --- |
| 40% | Weekly allowance utilization before reset | quota percent series (new) |
| 25% | Absence of five-hour hard-limit reaches | `history.windows[].reachedAt` |
| 20% | Pacing across available five-hour windows | percent series + blocks (Claude) |
| 15% | Remaining allowance still realistically usable before reset | percent series + burn rate |

Rules:

- Score each provider independently. Never blend.
- A high weekly percentage produced by repeated hard stops is *not* a good
  result; components 1 and 2 must be reported side by side, never netted.
- Provider quota data is authoritative only for the current value. Historical
  reaches are locally observed and must be labeled as such.
- Codex pacing has no block backing — lower confidence, state the reason.
- The default 85–95% weekly target band is **user-adjustable and labeled as a
  user preference**, not a provider recommendation.

**Prerequisite:** the quota percent series (see Data model). Until it lands, this
profile reports `insufficient` and renders as an ungraded measurement panel.

### 2. Inference Volume — Phase 1 (ungraded), Phase 2 (graded)

*How much model work did the subscription produce?*

Report measurements, never one raw total:

- generated output tokens
- direct input tokens
- cache-read tokens
- cache-creation tokens *(requires the `aggregateModels` fix)*
- total processed tokens
- tokens per positive quota-percentage point, when snapshot resolution allows
- tokens per API-equivalent dollar, as a clearly secondary analytical figure

Grading (Phase 2, once quota pairing is validated): 45% output per quota point,
25% processed volume per quota point, 20% completion-adjusted volume, 10%
stability across the period.

**Hard rule:** never combine Claude and Codex raw tokens into a provider
efficiency ranking. Tokenizers, subscription accounting, cache treatment, and
model rates differ. When quota deltas cannot be safely paired with activity —
sparse snapshots, a reset inside the bucket, unpriced models — show the ungraded
volume report and say why.

### 3. Frontier Intensity — Phase 2

*Was usage concentrated on the largest models and higher reasoning efforts?*

An intentional "maximize intelligence" lens, not a cost lens.

| Weight | Component |
| --- | --- |
| 50% | Share of weighted activity on cataloged frontier models |
| 30% | Share at medium-or-higher reasoning effort |
| 20% | Outcome evidence from those frontier/high-effort sessions |

- Use an explicit, versioned local catalog (`server/model-catalog.ts`) with
  provider, family, tier, and supported efforts. **Never infer tier from a
  name regex.**
- Unknown models stay visible and reduce coverage; they are never assigned a
  guessed tier.
- Always show the same outcome rate for smaller-model sessions, so the user can
  see whether frontier use changed anything.
- Ship the "largest model regardless of cost" preset alongside the default.

### 4. Context & Cache Efficiency — Phase 2

*Did repeated context create leverage, or become drag?*

No single cache ratio suffices: 96% cache reads can mean excellent reuse or one
oversized conversation resent forty times.

Measurements: cache-read share of processed tokens; cache-creation volume;
read-to-write amplification (where writes are reported); cached-to-direct input
ratio; output per million cache-read tokens; session token growth by turn;
compactions per session with pre/post context where exposed; long-session share
of total usage; count and share of auto-compacted sessions; context outliers by
model/provider/effort.

| Weight | Component |
| --- | --- |
| 30% | Cache reuse / amortization |
| 30% | Output or outcome per cached token |
| 25% | Context-drag avoidance |
| 15% | Appropriate compaction or fresh-thread behavior |

**Codex caveat:** no cache-creation reporting → amplification is `N/A`, coverage
is reduced, and the reason is displayed. Never treat a missing denominator as
infinite efficiency.

### 5. Outcome Yield (beta) — Phase 3

*How often did usage produce a completed, changed, verified result?*

| Tier | Evidence | Availability |
| --- | --- | --- |
| 0 — Unknown | No trustworthy completion evidence | Automatic |
| 1 — Completed | Native task-complete / final-response event | Automatic (Ph. 2 index) |
| 2 — Changed | Structured patch or file change observed | Automatic (Ph. 2 index) |
| 3 — Verified | Recognized test/build/lint command exited 0 | Opt-in parser category (Ph. 3) |
| 4 — Accepted | User marks success / partial / abandoned / rework | Manual local annotation |
| 5 — Shipped | Commit/PR correlated to the session | Phase 4, opt-in |

Weights: 40% verified-or-accepted completion rate, 25% changed-result rate where
a change was requested, 20% outcome per weighted usage unit, 15% low
rework/abandonment.

Limits, stated in the UI and not just the docs: "task complete" is not proof of
correctness; patch size is not quality; absence of user follow-up is not
acceptance. Tier 3 stores **only** category, exit status, and timestamp — never
arguments, never output. Outcome Yield stays labeled beta until manual labels or
stronger verification coverage exist.

---

## Outlier detection

Detect within comparable cohorts, never across all sessions.

**Cohort key**
- Phase 1: `provider + dominant model family + cache-mode`
- Phase 2: `provider + model family + effort + root/subagent class`

Dominant model family = the family holding the largest token share in that
session, from the versioned catalog; sessions whose dominant model is unknown
form their own `unknown` cohort and are never merged into a known one.

**Method**

1. `log1p` on session total, cache-read, output, and (Phase 2) tool-call and
   patch-size values.
2. Median absolute deviation for robust distance; modified z-score
   `0.6745·(x − median)/MAD`, threshold 3.5 (configurable, versioned).
3. **Zero-variance guard:** when MAD is 0, fall back to IQR; when IQR is also 0,
   emit no outliers for that cohort rather than flagging every non-median row.
4. **Minimum cohort size: n ≥ 8.** Below that, outlier detection is skipped and
   reported as "cohort too small," not as "no outliers."
5. Attach reason labels: `long-context`, `cache-heavy`, `output-heavy`,
   `tool-heavy`, `large-prompt`, `large-patch`, `compacted`, `quota-boundary`.

**Controls:** All sessions (default) · Typical only · Outliers only · Exclude
internal agents (Phase 2, on by default for behavior scores) · optional manual
"expected outlier" annotation that keeps the row visible but removes it from
anomaly counts.

Every score exposes its outlier delta. **Never silently winsorize or drop
sessions.**

---

## Advice and message log

An **Action feed** above the profile cards; a complete **Advice log** under
Signals.

```ts
type Advice = {
  id: number;
  ruleId: string;          // stable, versioned
  dedupeKey: string;       // rule + scope + cycle identity
  severity: "notice" | "opportunity" | "urgent";
  scope: Record<string, string>;    // provider / model / project / session
  evidence: Record<string, number | string>;  // numeric & categorical only
  detectedAt: string;
  lastSeenAt: string;
  state: "active" | "dismissed" | "snoozed" | "resolved" | "expired";
  snoozedUntil: string | null;
  resolvedAt: string | null;
};
```

Actions: dismiss · snooze until a timestamp or the next provider reset · never
show this rule again · mark helpful / not helpful · reopen from the log.

**Rule contract.** Each rule is a pure function `(insights, now) => Finding[]`.
Rules never write; the lifecycle layer reconciles findings against stored state.
Each rule declares its own **recurrence contract** — the condition under which a
dismissed message may legitimately reappear (typically: a new quota cycle, or the
underlying metric crossing back through the threshold after having cleared it).
A dismissed message must never reactivate merely because a refresh recomputed
the same condition.

**Phase 1 rules** (existing data only):

- Five-hour allowance crossed a configurable warning threshold while weekly
  allowance remains comparatively low.
- Weekly reset approaching with substantial usable headroom.
- Repeated five-hour hard stops without weekly saturation.
- One model dominates weighted usage.
- Outliers materially change a profile score.
- Unpriced models make cost-related figures incomplete.
- Cache-creation volume is not being amortized by later reads.

**Phase 2 rules** (need the observation index):

- Recent thread has unusually high cached context relative to output.
- Context crossed a model-aware threshold and work is continuing.
- Repeated compactions suggest a fresh thread or handoff.
- Premium model / high effort repeatedly used for small, low-tool, low-change
  tasks.
- A long autonomous turn became an outlier after only one or two user prompts.

**Wording is probabilistic and past-tense-safe.** "Consider compacting or
starting a fresh thread," never "Compact now." Current session fullness is not
available from every provider, and an ended session must never produce a live
command.

---

## Models view enhancements

Per model card: cache creation/write tokens · cache-read share · direct input
share · output share · read/write amplification when available · median and p90
session size · median output and cache read per session · root vs subagent
contribution (Ph. 2) · effort distribution (Ph. 2) · outlier count and token
share · profile contribution badges · outcome coverage and rate (Ph. 3).

Sorting: total tokens · output · cache read · cache write · cache share ·
API-equivalent cost · median session size · outcome yield · outlier
contribution. Preserve the existing rule that unpriced models sort to the top of
cost-ordered lists rather than reading as free (`aggregateModels()` comment).

Models and Data consume the **same server-computed analysis output** under the
same scope. No parallel math in React.

---

## Data model

### 0. Migrations (prerequisite, Phase 1)

`server/store.ts` has no schema versioning. Before adding tables, introduce a
minimal, ordered migration runner:

```ts
// server/migrations.ts
export const migrations: Array<{ id: number; up: (db: Database) => void }> = [...];
// user_version pragma drives application; each migration runs once, in order.
```

Fold the existing inline `CREATE TABLE IF NOT EXISTS` statements in as
migration 1 (idempotent against existing databases), and keep the current
"seed defaults only into a brand-new database" behavior — a user deleting a
seeded rule must still stick.

### 1. Cache-creation carry-through (Phase 1)

`server/collector.ts` — add to the `aggregateModels()` accumulator and the
returned shape:

```ts
cacheCreationTokens: number;
```

and to `DashboardData["models"]` in `src/types.ts`. Verify against
`unified.totals.cacheCreationTokens` in a test: the sum across models must equal
the report total for the same rows.

### 2. Quota percent series (Phase 1 — unblocks Allowance Capture)

Extend `collectQuotaHistory()` / `summarizeQuotaHistory()` in `server/quota.ts`
to additionally emit a downsampled series:

```ts
type QuotaSeriesPoint = {
  provider: "anthropic" | "codex";
  window: "fiveHour" | "weekly";
  capturedAt: number;
  usedPercent: number;
  resetsAt: number | null;
  cycleId: string;   // resetsAt-derived, matching existing reach-cycle keying
};
```

Constraints:
- Read-only against quota-service's SQLite, exactly as today; keep the existing
  localhost/`QUOTA_DB_PATH` guard and the "malformed rows are ignored" behavior.
- Downsample to at most one point per 5 minutes per (provider, window) to keep
  the payload bounded over a 120-day range.
- Reuse the existing cycle identity so utilization and reach counts cannot
  disagree.
- Absent database → `available: false` and `insufficient` confidence, never a
  zero-filled series.

Keep the series **out of `/api/dashboard`**; serve it from `/api/insights`.

### 3. Session observation index (Phase 2)

New table `session_observations`, numeric/categorical/timestamp only:

- `session_id`, `parser_version`, `source_size`, `source_mtime`, `last_offset`
- first/last event timestamps
- root/subagent class, subagent category
- observed model set, observed effort set
- user-prompt count, aggregate prompt character count
- task-turn count, tool-call count
- structured file / addition / deletion counts
- compaction count, numeric pre/post-context observations
- native completion-event count
- coverage and truncation flags

**Never persisted, in any phase:** prompt or response text · reasoning text ·
tool arguments or results · command strings · file contents · paths beyond the
existing working-directory association.

Indexing is incremental over append-only JSONL from `last_offset`. If the file
shrinks, rotates, or `parser_version` changes, rebuild that session only.
Unchanged files are never rescanned. This mirrors the mtime-guard pattern already
used by `indexGlob()` and `getSessionDetail()`'s cache, and must run on the
collector's refresh path, not inside a request handler.

### 4. Advice persistence (Phase 1)

```text
usage_advice
  id, rule_id, dedupe_key, severity, scope_json, evidence_json,
  detected_at, last_seen_at, state, snoozed_until, resolved_at
  UNIQUE(rule_id, dedupe_key)

usage_advice_events
  id, advice_id, event, created_at, metadata_json
```

Evidence is numeric and categorical only — enforced by a test that scans written
rows for free text.

### 5. Manual outcomes (Phase 3)

New `session_outcomes` table (not an `annotations` extension — annotations are
user-authored notes and tags; outcomes are a typed label with different
lifecycle and different UI):

```text
session_outcomes
  session_id PRIMARY KEY, status, note, updated_at
  status IN ('success','partial','abandoned','rework','unknown')
```

---

## Server and API

Pure analysis modules; **no grading math in React**:

| Module | Responsibility |
| --- | --- |
| `server/insights.ts` | Scope resolution, cohorts, outliers, metrics, scores, confidence |
| `server/model-catalog.ts` | Versioned model tier / family / effort catalog |
| `server/advice.ts` | Pure rules + lifecycle reconciliation |
| `server/session-observations.ts` | Incremental transcript aggregate parser (Ph. 2) |
| `server/migrations.ts` | Ordered schema migrations |

### Endpoints

```text
GET  /api/insights?range=30&provider=all&pathTag=all&cache=include&outliers=all
GET  /api/advice?state=active
GET  /api/advice/log
POST /api/advice/:id/dismiss
POST /api/advice/:id/snooze
POST /api/advice/:id/feedback
PUT  /api/sessions/:id/outcome        # Phase 3
```

Follow existing conventions in `server/index.ts`: `Cache-Control: no-store` on
mutations, loopback-host guard, `errorResponse()` shape, regex path matching with
`decodeURIComponent` on session IDs.

### Caching and performance

- `/api/insights` results are memoized by `${snapshot.collectedAt}|${scopeKey}`,
  with a small LRU (≤ 16 entries). A scope repeat within one snapshot generation
  must not recompute.
- Serve an ETag derived from that same key, matching the `/api/dashboard`
  pattern.
- `/api/dashboard` may carry a **compact** summary — per-profile score, band,
  confidence, and active advice count — for nav badges. Cohorts, series, and
  evidence stay on `/api/insights` so the 60-second refresh payload does not
  grow materially.
- Advice evaluation runs on the collector refresh path and must not block the
  60-second cycle: evaluate after the snapshot is published, and if evaluation
  throws, keep the prior advice state and surface it in source health — the same
  last-good-on-failure posture `refresh()` already uses.

### Frontend structure (required, Phase 1)

`src/App.tsx` is 5,961 lines. Do not add this feature inline.

- Extract the current `Sources` component into `src/views/data/` as
  `index.tsx` (page shell), `profiles.tsx`, `signals.tsx`, `advice.tsx`,
  `provenance.tsx` (the existing panels, semantics unchanged).
- New components consume server-computed values; they format and lay out, they
  do not aggregate.
- `src/views/chrome.tsx` already establishes the pattern for extracted view
  modules — follow it.
- Extraction is a mechanical, reviewable first commit, separate from the feature
  commits.

---

## Phased delivery

Each phase is independently shippable and independently valuable.

### Phase 1 — Existing-data introspection → v1.5.0

1. Migration runner; existing tables folded in.
2. `cacheCreationTokens` carried into `aggregateModels()`, `DashboardData`, and
   the Models cards.
3. Quota percent series in `server/quota.ts`.
4. `server/insights.ts` with provider-separated cohorts, MAD outliers (with
   zero-variance and small-cohort guards), and confidence derivation.
5. `AnalysisScope` wired to the existing global filters plus the new outlier
   control; sensitivity deltas on every score.
6. Allowance Capture (graded) and Inference Volume (ungraded report).
7. Cache composition and per-model medians from existing session rows.
8. `server/advice.ts` with the seven existing-data rules, plus dismiss/snooze
   persistence and the log.
9. Data view extracted to `src/views/data/`; provenance moved below, unchanged.
10. Transcript privacy boundary **unchanged**; README needs no privacy edit.

*Exit criteria:* Allowance Capture reproduces the Jul 12–25 pattern (repeated
five-hour reaches against a ~60% weekly peak) from real local data; Models shows
cache writes; dismissing a message keeps it in the log and it does not
reactivate within the same quota cycle.

### Phase 2 — Privacy-preserving observation index → v1.6.0

1. `session-observations.ts` incremental parser + table, **opt-in, default off**.
2. Effort, compaction, tool, patch, completion, and internal-agent metrics.
3. Frontier Intensity and Context & Cache Efficiency; Inference Volume becomes
   graded once quota pairing is validated against real data.
4. Context / compaction / handoff advice rules.
5. `model-catalog.ts` with versioned tiers and effort support.
6. Privacy disclosure card, enable/disable setting, field list, coverage and
   last-indexed timestamps, and a "delete derived observations and advice
   history" action.
7. README and `docs/ARCHITECTURE.md` updated with the new collection boundary.

*Exit criteria:* with indexing off, the app behaves exactly as v1.5.0 with
reduced coverage clearly labeled; with it on, no prompt, response, command, tool
argument, or file content appears anywhere in SQLite (asserted by test); a
second refresh over unchanged files performs no re-parse.

### Phase 3 — Outcome Yield beta → v1.7.0

1. Automatic tiers 1–2 from the observation index.
2. Opt-in verification categorization for tier 3 (category, exit status,
   timestamp only).
3. `session_outcomes` + manual labeling and correction UI.
4. Outcome Yield with visible evidence coverage and confidence, labeled beta.
5. Custom profile weights, with `rubricVersion` recorded on every stored score.
6. Recalibrate weights from observed feedback — **never silently restate
   historical scores**; a rubric change bumps the version and is shown as such.

### Phase 4 — Optional delivery evidence (exploratory)

Local Git correlation behind explicit per-project opt-in, storing only
repository-relative identifiers, commit hashes, timestamps, and aggregate counts.
GitHub/PR integration stays a separate opt-in with its own disclosure.

**"Percent of changes committed" remains deferred** until these are answered:
mapping session patches to commits across worktrees; distinguishing pre-existing
and user changes from agent changes; reading history outside the current
collection boundary; how amend/rebase/squash/partial commits count. Note that
`git-aware worktree canonicalization` is currently on the README's "Not here yet"
list — Phase 4 is precisely the work of removing it, and should not begin until
Phases 1–3 have shipped.

---

## Testing and validation

Follow the existing `bun test` conventions (`server/*.test.ts`,
`src/*.test.ts`), including the current practice of testing exported pure
functions against synthetic fixtures.

### Unit

- Token and cache aggregation including cache creation; per-model sums reconcile
  to `unified.totals`.
- Cohort construction; provider isolation (a Claude row can never enter a Codex
  cohort).
- MAD outliers: normal case, zero-MAD fallback to IQR, zero-IQR no-op, cohort
  below n = 8.
- Each score component, weight, and confidence path.
- Quota series: missing database, sparse snapshots, a reset inside a bucket,
  malformed rows, downsampling boundaries.
- Unsupported and unpriced models.
- Advice dedupe, snooze, dismissal, resolution, and recurrence contracts.
- Parser fixtures (Phase 2) for Claude and Codex root, subagent, compaction,
  patch, and completion events — extend the fixtures already exercised by
  `server/session-detail.ts`'s Codex `apply_patch` and Claude `structuredPatch`
  paths.
- Incremental append, file truncation, and parser-version rebuild.
- Migration runner: fresh database, existing v1.4.0 database, re-run idempotence.

### Integration

- Identical scope produces identical totals in Data and Models.
- A score change reports excluded session and token shares.
- Dismissed messages persist in the log and do not reactivate until the rule's
  recurrence contract permits.
- **No prompt, response, command, tool argument, or file content is written to
  SQLite** — scan every table for free text after a full index run.
- Stale or partial evidence lowers confidence rather than producing a low score.
- `/api/insights` memoization: repeated scope within one snapshot generation
  performs no recomputation.

### UI

- Keyboard and screen-reader access for score breakdowns, outlier controls, and
  advice actions.
- Score explanations readable without color; bands carry text labels.
- Responsive layout for profile cards and evidence drawers.
- Deep links open the target session without losing analysis scope.

### Performance

- Baseline captured before implementation (snapshot build time, dashboard
  payload size, refresh duration).
- Unchanged transcript files trigger no rescan.
- Active JSONL processing is incremental.
- Insights load independently of the core dashboard.
- Advice evaluation does not block the 60-second refresh.
- `/api/dashboard` payload growth from the compact summary stays under a stated
  budget (target: < 5 KB added).

---

## Privacy and user controls

Phases 1, 3, and 4 keep or extend the existing boundary. **Phase 2 changes it**
and must ship with all of the following, in the same release:

- A clear in-app disclosure that numeric transcript metadata will be indexed,
  shown before indexing is ever enabled.
- **Default off.** Indexing begins only after explicit opt-in.
- A setting to disable transcript-derived insights at any time.
- A "delete derived observations and advice history" action that actually drops
  the rows.
- A visible list of stored fields and an explicit list of what is never stored.
- Parser coverage and last-indexed timestamps in source health.
- No network transmission. No raw prompt/response persistence. Ever.

Disabling transcript insights must leave `ccusage` and quota-based profiles
working, with coverage reductions labeled rather than silently degraded.

---

## Documentation changes

- **README "Data and privacy"** — Phase 2 only. The current sentence "Nothing
  from that read is written to the database" must become an accurate description
  of the opt-in derived index, retaining the unconditional promise about prompt,
  response, command, and file text.
- **README "Not here yet"** — remove `touched-file indexing` only if the
  observation index genuinely ships; remove `task classification` **only if a
  classifier actually ships**, which this plan does not propose; revisit
  `git-aware worktree canonicalization` only in Phase 4.
- **`docs/ARCHITECTURE.md`** — extend "Collection flow" with observation
  indexing and advice evaluation, and "Local storage" with the new tables and the
  migration mechanism.
- Document every profile formula with its `rubricVersion`.
- Document, per metric, whether it is provider-reported, `ccusage`-derived,
  transcript-observed, user-annotated, or inferred.
- Release notes must state that profile scores are optimization lenses, not
  quality judgments.

Use the `release-ai-usage-observatory` skill for each phase's release.

---

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Quota snapshot resolution too coarse to pair with activity | Allowance Capture and volume-per-quota-point ungradeable | Validate against the real quota-service DB **before** building the grade; fall back to the ungraded report with a stated reason |
| quota-service absent or its schema changes | Allowance Capture unavailable | Already-tolerated failure mode; degrade to `insufficient`, keep every other profile working |
| Users read scores as a verdict on their work | Trust damage | Bands instead of letters; per-profile framing; explicit release-note language |
| Observation index cost on large transcript sets | Slow refresh | Incremental byte-offset reads, mtime guard, opt-in default, off the request path |
| Phase 2 privacy change perceived as a silent boundary shift | Trust damage | Default off, explicit disclosure, delete action, README updated in the same release |
| `App.tsx` growth makes the feature unmaintainable | Delivery drag | View extraction as a separate first commit in Phase 1 |
| Rubric changes silently restate history | Misleading trends | `rubricVersion` on every stored score; version changes shown, never applied retroactively |

---

## Recommended first slice (Phase 1, one release)

In dependency order:

1. Migration runner + existing tables folded in.
2. Extract the Data view into `src/views/data/` with no behavior change.
3. Carry `cacheCreationTokens` into `aggregateModels()`, `DashboardData`, and
   Models.
4. Add the quota percent series to `server/quota.ts`.
5. Add `server/insights.ts`: provider-separated cohorts, MAD outliers with
   guards, confidence derivation.
6. Wire `AnalysisScope` to the existing global filters + the new outlier control;
   render Allowance Capture, the ungraded Inference Volume report, and cache
   composition panels with sensitivity deltas.
7. Add `server/advice.ts` with the seven existing-data rules and
   dismiss/snooze/log persistence.
8. Move existing provenance below the new panels, semantics untouched.

This surfaces the burst-shape and cache-composition findings that motivated the
feature **without touching the transcript privacy boundary**, and it builds the
scope, scoring, evidence, and message-log foundations that Phases 2 and 3 need.
