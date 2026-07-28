# Data & Sources Usage Introspection — Draft Plan

**Status:** Draft for review  
**Date:** 2026-07-26  
**Scope:** Expand the current Sources view into a local-first usage-introspection
surface, with supporting additions to Models and Sessions.

## Objective

Help a user understand whether their current behavior matches the way they want
to use their AI subscriptions, and suggest timely, evidence-backed actions that
could improve that match.

The feature should:

- grade distinct usage goals separately instead of declaring one universal
  definition of “efficient”;
- show the raw measurements, weights, confidence, and provenance behind every
  grade;
- compare providers only when their units are genuinely comparable;
- identify whether a small number of outlier sessions materially changed a
  conclusion;
- prefer locally generated evidence and avoid new external integrations in the
  first release;
- turn urgent findings into timestamped, dismissible advice with a persistent
  local log;
- keep prompt and response text out of the database.

## Motivation From Observed Usage

The July 26 investigation found several patterns the current UI can display but
cannot yet interpret:

| Observed signal | Why it matters |
| --- | --- |
| Claude reached its five-hour limit eight times from July 12–25 while its weekly meter peaked around 60–62% | The user was quota-bound by burst shape, not weekly capacity. |
| Recent raw usage was 503M Codex tokens versus 323M Claude tokens, while recorded output was much closer at 2.19M versus 2.08M | Raw cross-provider token totals can imply a difference that token composition does not support. |
| Cache reads were 93% of recent Codex tokens and 96% of recent Claude tokens | Cache volume dominates the headline totals and needs its own interpretation. |
| Sol produced 82% of recent Codex tokens; the median Sol session was 1.94M tokens versus 573K for Terra | Model mix and task allocation explain more than provider identity alone. |
| Codex guardian/subagent runs were 45% of recent session count but only 4% of tokens | Session counts should distinguish user work from internal support work. |
| Only two of 115 Claude sessions compacted, both automatically at approximately 329K and 440K context | Waiting for automatic compaction may preserve a large repeated context for many turns. |
| Claude sessions with more than five prompts were 21% of sessions but 60% of tokens | A small long-session cohort materially skews aggregate conclusions. |

These are examples, not hard-coded thresholds. The feature must recompute from
the selected date range and state how much evidence supports each conclusion.

## Current Product and Data Boundaries

### Already available

- `ccusage` daily, weekly, monthly, and session reports contain input, output,
  cache-read, cache-creation, cost, model, and provider data.
- The dashboard already joins sessions to working directories and annotations.
- Quota history already records provider snapshots, observed limit reaches, and
  consumed Codex resets.
- Session detail already parses prompts, tool calls, structured patches, file
  counts, additions, and deletions on demand.
- Models already shows total tokens, output, cache reads, API-equivalent cost,
  and linked sessions.
- Global date, provider, cache, and path filters already establish most of the
  filter vocabulary this feature needs.

### Gaps

- `aggregateModels()` does not carry `cacheCreationTokens` into
  `DashboardData.models`, despite the source schema containing it.
- Sources receives the full dashboard but not an explicit analysis scope or
  outlier mode.
- Transcript-derived effort, root/subagent identity, compaction, tool, patch,
  and verification observations are not indexed for aggregate analysis.
- The local database has no insight, outcome, advice, dismissal, or snooze
  records.
- The current privacy promise says transcript detail is read only on demand and
  nothing from that read is persisted. Automatic transcript-derived metrics
  therefore require an explicit, documented boundary change.
- Task classification is currently listed as out of scope in the README.

## Information Architecture

Keep the existing `?view=sources` route. The recommended navigation label is
**Data** once the view contains more than provenance. Preserve “Sources” as a
section name and legacy conceptual label.

Recommended page title: **Usage intelligence & provenance**

Organize the page into three top-level sections:

1. **Profiles** — goal-specific grades and their evidence.
2. **Signals** — quota pacing, cache/context behavior, model/effort mix,
   outliers, and the action feed.
3. **Sources** — the current provider/local distinction, source health, quota
   evidence, and raw normalized-data links.

Do not hide provenance behind a modal. Every grade and message should link to
the source section or sessions that produced it.

## Analysis Scope and Filters

All profile grades and signals use one shared scope:

- date range;
- provider;
- project/path tag;
- model;
- reasoning effort, when known;
- root sessions, subagents, or both;
- cache included or excluded;
- outlier mode: **All**, **Typical only**, or **Outliers only**.

Defaults:

- selected global date range;
- all providers scored separately;
- root sessions included;
- internal/guardian subagents excluded from user-behavior grades but reported
  as a separate contribution;
- cache included, with direct and cache traffic shown separately;
- all sessions included, with an adjacent “without outliers” sensitivity.

Whenever a filter changes a grade, show sample count, token share, and excluded
share. Example: “12 outlier sessions are 4% of sessions and 38% of processed
tokens; grade changes from B− to C+ when included.”

## Usage Profiles and Grades

There should be no single overall grade in the first release. A user optimizing
for frontier intelligence is intentionally making a different tradeoff from a
user optimizing for maximum volume.

Each profile returns:

- numeric score from 0–100;
- letter grade for scanning;
- confidence: high, medium, low, or insufficient;
- two to four weighted components;
- comparison with the preceding equivalent period;
- the result with and without outliers;
- a plain-language explanation and links to supporting sessions.

Recommended letter mapping:

- A: 90–100
- B: 80–89
- C: 70–79
- D: 60–69
- F: below 60

Do not emit a letter when confidence is insufficient. Show **N/A** and the
missing evidence instead.

### 1. Allowance Capture

**Question:** How much included subscription capacity was converted into useful
activity without repeatedly hard-stopping?

Candidate components:

- 40% weekly allowance utilization before reset;
- 25% absence of five-hour hard-limit reaches;
- 20% pacing across available five-hour windows;
- 15% remaining allowance that was still realistically usable before reset.

Required caveats:

- Score each provider independently.
- A high weekly percentage is not automatically good when it was produced by
  repeated hard stops.
- Provider quota history is authoritative only for the current provider value;
  historical reaches are locally observed.
- Missing snapshots lower confidence rather than lowering the score.

This profile should have configurable targets. A default target band of
approximately 85–95% weekly use with no hard stops can be proposed in the UI,
but must be labeled as a user-adjustable optimization target rather than a
provider recommendation.

### 2. Inference Volume

**Question:** How much model work did the subscription produce?

Display separate measures rather than one raw token number:

- generated output tokens;
- direct input tokens;
- cached-read tokens;
- cache-creation tokens;
- total processed tokens;
- tokens per positive quota-percentage change when snapshot resolution permits;
- tokens per API-equivalent dollar as a secondary analytical comparison.

Candidate grade:

- 45% output volume per quota point;
- 25% total processed volume per quota point;
- 20% completion-adjusted volume;
- 10% stability across the selected period.

Do not combine Claude and Codex raw tokens into a provider-efficiency ranking.
Tokenizers, subscription accounting, cache treatment, and model rates differ.
When quota deltas cannot be safely paired with activity, show an ungraded
volume report and lower confidence.

### 3. Frontier Intensity

**Question:** Was usage concentrated on the largest available models and higher
reasoning efforts?

This is an intentional “maximize intelligence” profile, not a cost-efficiency
profile.

Candidate components:

- 50% share of weighted activity on explicitly cataloged frontier models;
- 30% share at medium-or-higher reasoning effort;
- 20% outcome evidence from those frontier/high-effort sessions.

Implementation requirements:

- Use an explicit, versioned local model catalog with provider, family, tier,
  and supported effort values. Do not infer tier only from a model-name regex.
- Unknown models remain visible and reduce coverage; they are not assigned a
  guessed tier.
- Show the same outcome rate for smaller-model sessions so the user can see
  whether frontier use changed results.
- Allow custom weights and a “largest model regardless of cost” preset.

### 4. Context & Cache Efficiency

**Question:** Did repeated context produce useful leverage, or did it become
context drag?

No single cache ratio is sufficient. High cache reads may indicate excellent
reuse or an oversized conversation repeatedly resent.

Core measurements:

- cache-read share of processed tokens;
- cache creation/write volume;
- read-to-write amplification when cache writes are reported;
- cached-to-direct input ratio;
- output per million cached-read tokens;
- session-token growth by turn;
- compactions per session and tokens before/after compaction when exposed;
- long-session share of total usage;
- number and share of sessions that auto-compacted;
- context outliers by model/provider/effort.

Candidate components:

- 30% cache reuse/amortization;
- 30% output or outcome per cached token;
- 25% context-drag avoidance;
- 15% appropriate compaction or fresh-thread behavior.

Provider caveat: Codex currently reports no cache-creation tokens through the
pinned `ccusage` integration. Read/write amplification must be N/A for that
provider rather than treated as infinite efficiency.

### 5. Outcome Yield (Beta)

**Question:** How often did observed usage produce a completed, changed, and
verified result?

Use evidence tiers instead of a binary automatic claim:

| Tier | Evidence | Availability |
| --- | --- | --- |
| 0 — Unknown | No trustworthy completion evidence | Automatic |
| 1 — Completed | Native task-complete/final-response event observed | Automatic |
| 2 — Changed | Structured patch or file change observed | Automatic |
| 3 — Verified | Recognized test/build/lint command completed successfully | Opt-in parser category |
| 4 — Accepted | User marks successful, partial, abandoned, or rework | Manual local annotation |
| 5 — Shipped | Commit/PR outcome correlated to the session | Future opt-in integration |

Candidate components:

- 40% verified-or-manually-accepted completion rate;
- 25% changed-result rate where a change was requested;
- 20% outcome per weighted usage unit;
- 15% low rework/abandonment rate.

Limitations:

- “Task complete” is not proof that the result was correct.
- Patch size is not quality.
- No user follow-up is not acceptance.
- Test-command recognition requires transient inspection of command names. Store
  only category, exit status, and timestamp; never store arguments or output.
- Outcome Yield remains beta until manual labels or stronger verification
  coverage are available.

## Outcome Options and Git Boundary

Do not add GitHub, remote repository, or commit-history integration in the
initial implementation.

The first release can autogenerate:

- sessions with structured changes;
- files changed and patch-line counts already present in transcript events;
- native task completion;
- optional categorized verification success;
- manual local outcome labels.

“Percent of changes committed” is deferred because a trustworthy version would
need to:

- map session patches to repository commits across worktrees;
- distinguish pre-existing/user changes from agent changes;
- read repository history outside this app’s current collection boundary;
- decide how amend, rebase, squash, and partial commits count;
- potentially connect to GitHub for PR/merge outcomes.

A future **local Git evidence** experiment may be offered behind explicit
per-project opt-in. It should store only repository-relative identifiers,
commit hashes, timestamps, and aggregate counts. Remote PR/merge evidence should
be a separate opt-in integration with its own privacy disclosure.

## Outlier Detection and Controls

Detect outliers within comparable cohorts, not across all sessions.

Recommended cohort:

`provider + model family + effort + root/subagent class`

Recommended method:

1. Apply `log1p` to session total, cache-read, output, tool-call, and patch-size
   values.
2. Use median absolute deviation (MAD) for robust distance.
3. Mark a session when at least one primary metric exceeds the configured robust
   threshold.
4. Attach one or more reason labels:
   `long-context`, `cache-heavy`, `output-heavy`, `tool-heavy`,
   `large-prompt`, `large-patch`, `compacted`, `quota-boundary`.

Controls:

- **All sessions** — default grade.
- **Typical only** — exclude detected outliers.
- **Outliers only** — investigation view.
- **Exclude internal agents** — enabled by default for behavior grades.
- Optional manual “expected outlier” annotation that preserves the row but
  removes it from anomaly counts.

Every grade must expose outlier sensitivity. Never silently winsorize or remove
sessions.

## Timely Advice and Message Log

Add an **Action feed** above the profile cards and a complete **Advice log**
under Signals.

Each message contains:

- stable rule ID and deduplication key;
- severity: notice, opportunity, or urgent;
- detected timestamp and last-seen timestamp;
- provider, model, project, or session scope;
- evidence snapshot;
- recommended action;
- deep link to the supporting session/profile;
- state: active, dismissed, snoozed, resolved, or expired.

Actions:

- Dismiss.
- Snooze until a timestamp or provider reset.
- Do not show this rule again.
- Mark helpful/not helpful.
- Reopen from the log.

Initial rules that use existing data:

- five-hour allowance crossed a configurable warning threshold while weekly
  allowance remains comparatively low;
- weekly reset is approaching with substantial usable headroom;
- repeated five-hour hard stops are occurring without weekly saturation;
- one model dominates weighted usage;
- outliers materially change a profile grade;
- unpriced models make cost-related grades incomplete;
- cache-creation volume is not being amortized by later reads.

Rules that require transcript observations:

- active/recent thread has unusually high cached context relative to output;
- context has crossed a model-aware threshold and more work is continuing;
- repeated compactions suggest a fresh thread or handoff;
- premium model/high effort is repeatedly used for small, low-tool,
  low-change tasks;
- a long autonomous turn became an outlier after only one or two user prompts.

Wording must remain probabilistic: “Consider compacting or starting a fresh
thread” rather than “Compact now.” Current session fullness is not available
from every provider and an ended session should never produce a live command.

## Models View Enhancements

Add the following to each model card:

- cache creation/write tokens;
- cache-read share;
- direct input share;
- output share;
- read/write amplification when available;
- median and p90 session size;
- median output and cache read per session;
- root versus subagent contribution;
- effort distribution;
- outlier count and token share;
- profile contribution badges;
- outcome-evidence coverage and rate when enabled.

Add sorting by:

- total tokens;
- output;
- cache read;
- cache write;
- cache share;
- API-equivalent cost;
- median session size;
- outcome yield;
- outlier contribution.

Models and Data must use the same analysis functions and filters so displayed
values cannot drift.

## Data Model

### Existing-data change

Extend the model aggregate and frontend type with:

```ts
cacheCreationTokens: number;
```

### New transcript observation index

Add a `session_observations` table containing only numeric, categorical, and
timestamp aggregates:

- `session_id`, parser version, source size, source mtime, last byte offset;
- first and last event timestamps;
- root/subagent class and subagent category;
- observed model and reasoning-effort sets;
- user-prompt count and aggregate character count;
- task-turn and tool-call counts;
- categorized verification counts and exit status;
- structured file, addition, and deletion counts;
- compaction count and numeric pre/post-context observations;
- native completion-event count;
- source coverage/truncation flags.

Do not persist:

- prompt or response text;
- reasoning text;
- tool arguments or results;
- command strings;
- file contents;
- full paths beyond the existing working-directory association.

The indexer should process append-only JSONL incrementally from the stored byte
offset. If a file shrinks, rotates, or the parser version changes, rebuild only
that session. Unchanged files must not be rescanned.

### Advice persistence

Add:

```text
usage_advice
  id, rule_id, dedupe_key, severity, scope_json, evidence_json,
  detected_at, last_seen_at, state, snoozed_until, resolved_at

usage_advice_events
  id, advice_id, event, created_at, metadata_json
```

Store numeric/categorical evidence only.

### Manual outcomes

Either extend `annotations` or create `session_outcomes` with:

- status: success, partial, abandoned, rework, or unknown;
- optional local note;
- updated timestamp.

Keep outcome notes user-authored and local.

## Server and API Shape

Create pure analysis modules rather than calculating grades in React:

- `server/session-observations.ts` — incremental transcript aggregate parser;
- `server/insights.ts` — cohorts, outliers, metrics, grades, confidence;
- `server/advice.ts` — rule evaluation and lifecycle;
- `server/model-catalog.ts` — explicit versioned model tiers and effort support.

Recommended endpoints:

```text
GET  /api/insights?range=30&provider=all&outliers=all&sessionClass=root
GET  /api/advice?state=active
GET  /api/advice/log
POST /api/advice/:id/dismiss
POST /api/advice/:id/snooze
POST /api/advice/:id/feedback
PUT  /api/sessions/:id/outcome
```

The dashboard snapshot may include a compact profile/advice summary for badge
counts, but detailed cohorts and evidence should remain on the dedicated
endpoint to avoid enlarging every dashboard refresh.

## Phased Delivery

### Phase 1 — Existing-data introspection

- Add cache-creation totals to Models.
- Add shared analysis filters and explicit root/subagent handling where
  available.
- Implement Allowance Capture and an ungraded Inference Volume report.
- Implement cache composition, per-model medians, and session-token outliers
  from existing `ccusage` session rows.
- Add All / Typical / Outliers controls and grade sensitivity.
- Add quota-, pricing-, model-mix-, and outlier-based advice.
- Preserve the current transcript privacy boundary.

### Phase 2 — Privacy-preserving observation index

- Add incremental numeric transcript observations.
- Add effort, compaction, tool, patch, completion, and internal-agent metrics.
- Implement Frontier Intensity and Context & Cache Efficiency.
- Add context/compaction/handoff advice and the persistent message log.
- Update README and Architecture documentation with the new collection
  boundary and opt-out/reset controls.

### Phase 3 — Outcome Yield beta

- Add automatic evidence tiers 1–2.
- Add opt-in verification categorization for tier 3.
- Add manual outcomes and corrections.
- Implement Outcome Yield with visible evidence coverage and confidence.
- Recalibrate weights using observed user feedback; do not silently change
  historical grade definitions.

### Phase 4 — Optional delivery evidence

- Prototype per-project local Git correlation behind explicit opt-in.
- Keep GitHub/PR integration separate and optional.
- Add shipped/merged evidence only after privacy, attribution, and worktree
  ambiguity are resolved.

## Testing and Validation

### Unit tests

- token and cache aggregation, including cache creation;
- cohort construction and provider isolation;
- MAD outlier detection and zero-variance cohorts;
- each grade component, weight, and confidence calculation;
- missing quota snapshots, resets, and stale periods;
- unsupported/unpriced models;
- advice deduplication, snooze, dismissal, resolution, and recurrence;
- parser fixtures for Claude and Codex root, subagent, compaction, patch, and
  verification events;
- incremental append, file truncation, and parser-version rebuild.

### Integration tests

- filters produce identical totals in Data and Models;
- grade changes show excluded session/token shares;
- dismissed messages remain in the log and do not reactivate until the rule’s
  recurrence contract permits it;
- no prompt, response, command, tool argument, or file content is written to
  SQLite;
- stale or partial evidence yields lower confidence rather than a failing
  grade.

### UI checks

- keyboard and screen-reader access for profile breakdowns, outlier controls,
  and advice actions;
- readable score explanations without relying on color;
- responsive layout for profile cards and evidence drawers;
- deep links open the relevant session without losing analysis filters.

### Performance checks

- establish a baseline before implementation;
- unchanged transcript files incur no full rescan;
- active JSONL processing is incremental;
- detailed insights load separately from the core dashboard;
- advice evaluation does not block the 60-second source refresh.

## Privacy and User Controls

Phase 2 must ship with:

- a clear disclosure that numeric transcript metadata is now indexed;
- a setting to disable transcript-derived insights;
- a “delete derived observations and advice history” action;
- a list of stored fields;
- parser coverage and last-indexed timestamps;
- no network transmission;
- no raw prompt/response persistence.

Disabling transcript insights should leave ccusage and quota profiles working
with reduced coverage.

## Documentation Changes Required During Implementation

- Update README Data and Privacy.
- Remove or revise “task classification” from Not here yet only if a classifier
  actually ships.
- Update Architecture collection flow and local-storage schema.
- Document every profile formula and version.
- Document which metrics are provider-reported, ccusage-derived,
  transcript-observed, user-annotated, or inferred.
- Add release notes stating that profile grades are optimization lenses, not
  quality judgments.

## Decisions to Confirm

Recommended defaults are included so implementation can proceed after review,
but these choices remain product decisions:

1. Rename the navigation item from **Sources** to **Data**, or retain Sources
   and change only the page title.
2. Show 0–100 plus letter grades, or numeric scores only.
3. Use all sessions as the primary result with a “without outliers”
   sensitivity, or make Typical only the default.
4. Enable numeric transcript observation indexing by default with disclosure,
   or require explicit opt-in.
5. Include verification-command categorization in Phase 2, or defer all
   outcome evidence beyond patch/completion to Phase 3.
6. Allow customizable profile weights in the first release, or ship fixed,
   versioned presets before adding customization.

## Recommended First Slice

Implement Phase 1 as one release-sized slice:

1. Carry cache-creation totals into Models.
2. Add a pure `insights` module with provider-separated cohorts.
3. Add robust outlier modes and sensitivity summaries.
4. Add Allowance Capture, Inference Volume, and cache-composition panels.
5. Add existing-data advice with dismissal/snooze persistence.
6. Move current provenance below the new introspection panels without changing
   its semantics.

This slice directly surfaces the utilization patterns found in the investigation
without changing the transcript privacy boundary. It also produces the UI,
filter, score-explanation, and message-log foundations needed before effort,
compaction, and outcome grading are added.
