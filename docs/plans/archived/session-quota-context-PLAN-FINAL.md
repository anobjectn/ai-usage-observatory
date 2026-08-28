# Session quota context and provider-tier comparison plan (final)

**Status:** Implemented and archived
**Date:** 2026-08-28
**Scope:** AI Usage Observatory plus the optional local `quota-service`
**Baselines:** AI Usage Observatory `main` at `841a7f6`; quota-service `main` at `e181a4f`
**Supersedes:** Two earlier local drafts that were not retained in the repository.

This document is standalone. The implementation landed in quota-service commit `93e9873` and AI
Usage Observatory commits `3c7e639` and `2f21edf`.

The shipped table and detail views use `% of quota` for absolute allowance movement. Internal data
keeps percentage-point semantics so the calculation remains distinct from relative percent change.

## Outcome

Add session-level account quota context without claiming that one thread caused an account-level
change. When evidence supports it, a Codex or Claude session can say:

> During this active session, account usage increased by 49% of the 5-hour quota and 2% of the
> weekly quota. Up to 2 other local sessions on this provider
> overlapped.

A Warp session can use the same account-level wording for its monthly pool:

> During this active session, the Warp monthly allowance increased by 42 credits, from 70.3% to
> 73.1% used. Up to 1 other local Warp session overlapped.

The display must also say that:

- quota values are account or seat-level observations;
- provider web, mobile, cloud, another machine, or another local process may contribute;
- local concurrency is incomplete and external concurrency is unknown;
- overlapping session values are not additive;
- resets, renewals, long pauses, counter corrections, and pool limit changes are handled
  explicitly.

The first deliverable is contextual observation, not causal allocation. Later comparisons can
normalize observed work by allowance share and provider tier, but remain empirical reports. They
must not claim that Codex Plus, Claude Max 5x, or a Warp plan are equivalent.

## Decisions made by this review

### Keep account movement separate from session consumption

Use `account usage increased during this session` as the primary wording. Do not label an account
delta as `this session consumed` unless a provider later supplies thread-level attribution.

Show each provider resource separately. Display an absolute counter move from 51% to 100% as
`+49% of quota`, not as a 49% relative increase.

For Warp, show both the provider-unit count and percentage:

| Label | Example value |
| --- | --- |
| Monthly account usage | `+42 credits · +2.8% of quota` |
| Monthly pool | `1,097 / 1,500 credits used` |
| Same-provider concurrency | `Up to 1 other Warp session` |
| Evidence | `Bracketed snapshots, medium confidence` |

The current quota-service collector and Observatory UI already calculate and display Warp's
monthly percentage. The implementation must preserve that path. New work adds Warp to normalized
history and session bracketing; it does not add another current-percentage calculation.
Warp remains an opt-in quota-service provider through `QUOTA_PROVIDERS`; no Warp source warning
appears when it is intentionally disabled.

### Describe Warp units accurately

Warp's local preference key is named `num_requests_used_since_refresh`, but the current Warp billing
documentation describes the monthly allowance as credits. Credits scale with token processing and
other work, but they are not raw tokens and are not guaranteed to equal one prompt or turn.

Use `Warp credits` in product copy after a read-only check confirms the local count still matches
the credit balance shown by the installed Warp version. Lock that mapping with a fixture. Keep the
normalized contract's unit explicit. If the check fails after a Warp schema change, show `Warp
units` and mark the unit provenance unknown. Never label the pool as tokens.

Relevant Warp documentation:

- [Credits](https://docs.warp.dev/support-and-community/plans-and-billing/credits)
- [Pricing FAQs](https://docs.warp.dev/support-and-community/plans-and-billing/pricing-faqs)

### Keep quota-service optional

AI Usage Observatory retains its current analytics when quota-service is absent. Treat these as
distinct source states:

| State | UI behavior |
| --- | --- |
| Disabled | Stay quiet. Do not prompt the user to install or start anything. |
| History only | Use recognized read-only local history and say live collection is off. |
| Connected and current | Show current quota and eligible session context. |
| Connected but degraded | Preserve valid provider data and identify stale or failed providers. |
| Configured but unreachable | Show one source warning and the last successful observation. |

`History only` means the existing read-only SQLite path in `server/quota.ts`. It defaults to
`~/.quota-service/quota.db` and can be overridden with `QUOTA_DB_PATH`.

One failed endpoint or provider must not discard valid data from the others.

### Split responsibility at the evidence boundary

quota-service owns provider collection and durable observations:

- authentication and provider API quirks;
- poll limits and retry behavior;
- raw quota observations and cycle identity;
- plan identity and provenance;
- bounded normalized history;
- per-provider collection health;
- optional Claude lifecycle markers and hook helper documentation.

AI Usage Observatory owns local-session interpretation:

- canonical session IDs and active episodes;
- joining quota observations to sessions;
- local concurrency;
- coverage and confidence;
- account-level, non-additive wording;
- provider and tier cohort comparisons.

quota-service already has a `/runs` endpoint that reads Codex and Claude transcripts and uses the
same 30-minute idle threshold. It stays unchanged. The Observatory's session evidence is canonical
for this feature. Keep the thresholds equal unless a later plan documents a deliberate difference.

Do not place runtime behavior in an `AGENTS.md` file or provider prompt. Claude hooks are an opt-in
product integration.

## Evidence and constraints

### Codex

Codex transcript `token_count` events can carry account-level rate limits:

```json
"rate_limits": {
  "limit_id": "codex",
  "primary":   { "used_percent": 0.0,  "window_minutes": 300,   "resets_at": 1787940980 },
  "secondary": { "used_percent": 25.0, "window_minutes": 10080, "resets_at": 1788460725 }
}
```

Requirements:

- Classify windows by duration, not `primary` or `secondary` position. A duration of 6 hours or
  less maps to `fiveHour`; 3 days or more maps to `weekly`. Reuse quota-service's current
  `classifyFileWindows` thresholds.
- Transcript `resets_at` values are epoch seconds. quota-service history uses epoch milliseconds.
  Convert at the parse boundary and fixture-test the conversion.
- Preserve fractional `used_percent` values. Round only for display.
- Accept either window being absent.
- Ignore rate limits inside replayed parent history. The effort parser's `codexReplaying` state
  already identifies that region.

The observations remain account-level even though they appear inside one transcript.

Session detail currently reads only the first 12 MB of a transcript. Do not raise that cap or add a
second streaming reader. Extend the incremental parser in `server/effort-index.ts` and
`server/effort-parse.ts`, which already processes `token_count` lines by byte offset.

### Claude

Claude transcripts do not provide continuous account percentages. Session context requires raw
quota-service history, with optional lifecycle markers to improve boundary timing.

quota-service polls every 5 minutes by default. Anthropic's collector has a 180-second floor. A
hook can record a lifecycle marker immediately, but it must not bypass that provider call floor.

Per-model buckets such as a temporary Fable weekly bucket remain outside the first session-context
delivery. Only account `fiveHour` and `weekly` resources participate.

### Warp

quota-service already stores this pool shape:

```ts
type PoolSnapshot = {
  kind: "pool";
  pool: {
    used: number;
    limit: number;
    usedPercent: number;
    refreshesAt: number | null;
    cadence?: string;
  };
};
```

The collector currently derives `usedPercent` as `used / limit * 100`, rounded to one decimal.
The final history contract must preserve `used` and `limit`, not reconstruct counts from a rounded
percentage.

Warp has no JSONL transcript, but it is not session-blind. The Observatory already reads Warp's
local SQLite database and has:

- a provider-native conversation ID;
- prompt times from `ai_queries.start_ts`;
- task update times from `agent_tasks.last_modified_at`;
- recorded session credits and token totals from conversation metadata;
- best-effort assistant event times in task protobufs for session detail.

Build Warp activity episodes from the timestamp columns already queried by the collector. Do not
decode every task blob during dashboard collection. Blob parsing remains on demand for session
detail.

Warp pool movement can include Generate, Autofill, cloud runs, another machine, add-on credits, or
other activity absent from the local conversation database. It remains account or seat-level.
Recorded Warp session tokens are workload evidence only. They are not the pool counter.

### History depth and retention

Set and document this retention policy:

```env
QUOTA_RETENTION_DAYS=forever
```

`forever` is the product decision for this feature, not merely a default inherited from the current
code. An unset value continues to mean the existing default of no pruning, but the documented setup
uses the explicit value so intent survives future default changes.

A read-only check on 2026-08-28 found about 47 days of history in an 86.6 MiB SQLite database, plus
a small WAL. At the current write rate, indefinite raw retention projects to roughly 0.7 GB per
year. That is acceptable for this local-first feature.

Retention applies by data class:

| Data | Policy |
| --- | --- |
| Quota snapshots | Keep forever. |
| Reset-credit history | Keep forever. |
| Claude lifecycle markers | Keep forever by inheriting `QUOTA_RETENTION_DAYS`. |
| Effective-dated plan assignments | Keep forever and never prune automatically. |
| Current manual values | Keep the existing one-value-per-field behavior. |
| Minimal session evidence | Keep until the user explicitly clears derived session data. |
| Prompts, responses, and Warp task blobs | Do not copy into quota history or session evidence. |

A future finite `QUOTA_RETENTION_DAYS` remains supported for users who choose it. Pruning is
destructive once the next poll runs, always preserves the newest row per provider, and does not
restore deleted rows if the value later returns to `forever`. Do not add automatic `VACUUM`; SQLite
can reuse freed pages, and physical compaction needs a separate maintenance flow with a backup.

The history response must report `retentionDays: null`, `retentionMode: "forever"`, and the earliest
available observation for the requested provider. A finite override reports its numeric days and
mode `finite`.

The response must also return a provider-specific `historyVersion` based on the maximum snapshot
row ID included in the provider's history. `capturedAt` alone is not a safe cache version because a
later insert can backfill an older capture time.

Long retention does not justify keeping every redundant row forever without review. After the raw
history path is proven, add an optional state-interval compaction migration:

- preserve every value change, reset, renewal, provider failure, and recovery;
- combine consecutive identical normalized states into `firstObservedAt`, `lastConfirmedAt`, and
  `confirmationCount`;
- apply the same state-change rule to unchanged reset-credit payloads;
- preserve boundary confidence by treating the interval's last confirmation as real evidence;
- prove raw-versus-compacted parity for session deltas, confidence, quota reaches, and provider-tier
  reports before enabling compaction;
- run any migration on a copied database first and never compact the live database as verification.

Compaction reduces repetition without shortening the historical time range. It is a follow-up, not
a prerequisite for indefinite retention.

### Existing consumers

`summarizeQuotaHistory` in `server/quota.ts` reduces window history into 5-minute buckets for
Allowance Capture in `server/insights.ts`.

- Session bracketing consumes raw normalized observations, never the reduced `series`.
- The existing `series` and `data.quotas.history` response stay shape-compatible.
- Warp pool history is added beside existing window history. It does not enter the existing
  `windows` or window-series arrays.
- Capture compatibility fixtures before modifying `server/quota.ts`.

## Normalized contracts

Keep provider payloads inside quota-service. Add this versioned history observation independently
to both repositories:

```ts
type QuotaObservation = {
  schemaVersion: 1;
  provider: "anthropic" | "codex" | "warp";
  capturedAt: number; // epoch ms when quota-service collected the row
  observedAt: number; // epoch ms represented by the provider data
  timeSource: "provider" | "source_mtime" | "collector";
  status: "ok" | "stale";
  source: string;
  plan: {
    id: string | null;
    label: string | null;
    source: "provider" | "configured" | "unknown";
    effectiveFrom: number | null; // epoch ms for a configured assignment
  };
  quota:
    | {
        kind: "windows";
        windows: Array<{
          id: "fiveHour" | "weekly" | string;
          usedPercent: number; // 0 to 100, fractional allowed
          resetsAt: number | null; // epoch ms
          cycleId: string;
        }>;
      }
    | {
        kind: "pool";
        pool: {
          id: "monthly" | string;
          usedUnits: number;
          limitUnits: number;
          unit: "warp_credit" | "unknown";
          unitSource: "provider_docs_and_local_schema" | "local_schema" | "unknown";
          usedPercent: number; // 0 to 100, fractional allowed
          refreshesAt: number | null; // epoch ms
          cadence: string | null;
          cycleId: string;
        };
      };
};
```

Every timestamp in this contract is epoch milliseconds. `observedAt` comes from `data_as_of` when
the collector has a meaningful provider or source timestamp; otherwise it equals `capturedAt`.
Boundary selection and coverage use `observedAt`, not the database insertion time. This prevents a
fresh reread of an unchanged Warp plist from looking like fresh quota evidence.

A cycle ID uses the provider reset or refresh timestamp rounded to the minute. If no timestamp
exists, use `observed:<observedAt>`.
Sentinel cycles are never eligible for delta math. History observations always contain a usable
snapshot, so their status is `ok` or `stale`. Failure rows remain in provider health and do not
masquerade as quota observations.

Plan provenance:

- Codex surfaces the already stored `snapshot.extra.planType` as provider-reported.
- Anthropic persists the keychain payload's `subscriptionType`. If it cannot distinguish Max 5x
  from Max 20x, use an effective-dated configured assignment.
- Warp remains unknown unless the provider starts exposing a plan ID or the user creates an
  effective-dated assignment. Do not infer a plan from a 1,500-credit limit.

Configured assignments are append-only records with `effectiveFrom`. Apply one only to
observations observed at or after that instant and before the next assignment. Do not relabel older
history with today's configured tier. `manual_entries` can continue to expose the current display
value, but empirical cohorts use the effective-dated records.

Add the optional Claude marker contract:

```ts
type QuotaLifecycleMarker = {
  provider: "anthropic";
  sessionId: string;
  event: "session_start" | "session_resume" | "turn_stop" | "session_end";
  occurredAt: number; // epoch ms
  source: "claude_hook";
};
```

Do not include prompts, responses, project paths, or credentials.

AI Usage Observatory derives this view model:

```ts
type SessionQuotaContext = {
  provider: "anthropic" | "codex" | "warp";
  basis: "embedded_account_observation" | "bracketed_account_delta";
  resources: Array<{
    id: "fiveHour" | "weekly" | "monthly" | string;
    kind: "window" | "pool";
    unit: "percentage_points" | "warp_credit" | "unknown";
    deltaPercentagePoints: number | null;
    deltaUnits: number | null;
    cycleCount: number;
    episodes: Array<{
      cycleId: string;
      startUsedPercent: number;
      endUsedPercent: number;
      deltaPercentagePoints: number | null;
      startUsedUnits: number | null;
      endUsedUnits: number | null;
      deltaUnits: number | null;
    }>;
  }>;
  concurrency: {
    distinctOtherSameProviderSessions: number;
    maxOtherSameProviderSessions: number;
    distinctOtherProviderSessions: number;
    maxOtherProviderSessions: number;
    externalActivity: "unknown";
  };
  coverage: {
    startGapMs: number | null;
    endGapMs: number | null;
    activeDurationCoveredPercent: number;
    snapshotCount: number;
    historyReachesSession: boolean;
  };
  confidence: "high" | "medium" | "low" | "insufficient";
  additive: false;
};
```

Do not add an allocation estimate in the first implementation.

## Session and quota math

### Active episodes

Use event timestamps, not the whole file or database span. Split after 30 minutes without an
eligible activity event while preserving the provider-native session ID.

- Codex and Claude use timestamps collected by the existing incremental transcript parser.
- Warp uses `ai_queries.start_ts` and `agent_tasks.last_modified_at`. Query those columns without
  reading task blobs.
- Claude lifecycle markers can refine episode boundaries but are not required.

Store or return merged episode intervals. Do not infer activity from a file merely being open or
recently modified.

### Bracketing

For each active episode, select the nearest eligible `observedAt` on or before its start and the
nearest eligible `observedAt` on or after its end. Embedded Codex observations can instead bound a
covered portion inside the episode. Record start gap, end gap, coverage, and the count of distinct
observations. Repeated rows with the same provider, resource values, cycle, and `observedAt` count
once.

Use raw observations. Do not use 5-minute bucketed history.

### Resets, renewals, and counter corrections

Calculate a delta only within one real `cycleId`. If a session crosses a reset or renewal, split it
by cycle and add only independently resolved cycle segments. Report the cycle count.

Do not subtract a pre-reset value from a post-reset value. Do not count movement that occurs wholly
during a paused episode.

Usage should be monotonic inside one cycle. If an end value is lower than its start value beyond a
documented provider rounding tolerance, treat the segment as a correction or inconsistent
telemetry and mark it insufficient. Do not clamp it to zero and do not sum only positive fragments,
which can overstate net movement.

For a Warp pool:

- `deltaUnits = endUsedUnits - startUsedUnits` when the cycle ID is stable;
- calculate percentage-point movement only when both observations have the same positive limit;
- if the limit changes within a cycle, show the unit delta, omit the percentage delta, and disclose
  the limit change;
- a purchase or rollover of add-on credits stays separate from the included monthly pool.

### Sparse and rounded observations

If provider rounding means movement could be below one percentage point, show `no measurable
increase` rather than exact zero. Codex fractions, Anthropic integer rounding, and Warp one-decimal
pool values need provider-specific tolerances.

Initial confidence policy:

- high: embedded observations cover at least 90% of active duration, or both external boundary
  gaps are no more than 60 seconds;
- medium: both external gaps are no more than 5 minutes;
- low: both sides exist but either gap exceeds 5 minutes;
- insufficient: one side is missing, history does not reach the session, a cycle boundary is
  unresolved, a counter decreases unexpectedly, or required pool limits are invalid.

Keep these values in one tested policy module. They are product policy, not provider guarantees.

### Concurrency

Intersect the inspected session's episodes with other sessions' episodes. Report same-provider and
other-provider concurrency separately.

The primary disclosure uses same-provider concurrency because those sessions can share the account
allowance being displayed. Cross-provider overlap is useful workload context but is not evidence
that another session changed this provider's quota.

Count a subagent as another session only when it has a distinct provider-native session ID and
eligible activity events. Every successful result returns `additive: false` and external activity
as unknown.

## Implementation sequence

### 1. Freeze compatibility and add fixtures

Repositories: both.

- Capture existing `/usage`, `/resets`, `/status`, `summarizeQuotaHistory`, Warp quota-card, and
  Warp headroom shapes. Ignore generated timestamps in compatibility assertions.
- Add anonymized fixtures for same-cycle movement, resets, Warp renewal, long pauses, same-provider
  and cross-provider overlap, missing snapshots, rounded values, fractional Codex values, one-window
  Codex payloads, seconds-to-milliseconds conversion, replayed parent history, Warp pool limit
  changes, Warp counter decreases, and unknown Warp units.
- Add the normalized contracts independently to both repositories. Do not create a shared package.
- Add a read-only installed-schema check plus a fixture that locks the verified Warp credit mapping
  before product copy uses that label.

Exit criteria: both repositories produce the same normalized observations from fixtures without
reading a live database.

### 2. Add bounded normalized history to quota-service

Repository: `/Users/luis/htdocs/quota-service`.

- Add `GET /history?provider=<id>&from=<ms>&to=<ms>`.
- Require one provider and limit a requested time range to 31 days. Use stable keyset pagination
  instead of rejecting a valid range based on row count. Accept `limit` up to 5,000 and an opaque
  `cursor`; return `nextCursor` when more rows remain. The first page pins `historyVersion`, and
  later pages keep that version while ordering by `(observedAt, rowId)`, so concurrent inserts
  cannot reorder an in-progress read. Return `400` for invalid bounds, limits, or cursors.
- Make `/history` a pure read. It must never call a collector.
- Return chronological normalized observations, `earliestObservationAt`, active retention, and a
  provider-specific `historyVersion` based on the maximum snapshot row ID.
- Carry both `capturedAt` and the underlying `observedAt` plus its time-source provenance. Sort and
  bracket by `observedAt`; retain `capturedAt` for collector health and debugging.
- Normalize both window and pool snapshots. Preserve Warp `used`, `limit`, derived percent,
  refresh time, cadence, unit, and unit provenance.
- Recalculate Warp `usedPercent` from `used` and `limit` at normalization time and compare it with
  the stored value. Reject invalid limits or material disagreement instead of serving two
  conflicting values.
- Add per-provider last attempt, last success, last observation, freshness, and a short safe
  failure reason to `/status`.
- Persist Anthropic `subscriptionType`. Add an append-only `plan_assignments` table for configured
  Claude and Warp tiers, with `effective_from` and creation time. Keep `manual_entries` compatible
  for current display values, but never use its latest value to relabel older observations.
- Extend `POST /manual` with an optional `effectiveFrom` only for the dedicated plan-tier field.
  Writing that field atomically appends a plan assignment and updates the current manual display
  value. Existing manual fields keep their current behavior.
- Preserve compatibility for `/usage`, `/resets`, `/status`, `/runs`, `/estimate`, `/recommend`,
  `POST /manual`, and `POST /anthropic-web-import`.
- Keep provider poll floors unchanged.
- Document `QUOTA_RETENTION_DAYS=forever`, the destructive effect of switching to a finite value,
  the per-table policy above, pagination, and safe SQLite backup expectations.

Likely files: `src/server.ts`, `src/db.ts`, `src/present.ts`, `src/status.ts`,
`src/collectors/anthropic.ts`, and focused tests.

Exit criteria: legacy clients pass, all three providers have bounded fixture-tested history,
`/history` never collects, and one provider failure does not erase another provider's state.

### 3. Make the Observatory adapter partial and optional

Repository: AI Usage Observatory.

- Refactor `server/quota.ts` so `/usage`, `/resets`, `/status`, and `/history` fail independently.
- Prefer the history API. Keep recognized read-only local SQLite history as a fallback for an older
  quota-service.
- Never migrate or write to the live quota database. Unknown schemas return `history unavailable`.
- Normalize Warp pool rows in the fallback path and keep them separate from existing window series.
- Add disabled, history-only, current, degraded, and unreachable source states.
- Preserve the last valid observation for each provider after later failures.
- Keep existing history output shape-compatible for Allowance Capture.

Exit criteria: no service, an old service, a current service, one failed endpoint, and one failed
provider all retain the maximum valid data without breaking core analytics.

### 4. Collect session activity and embedded Codex observations

Repository: AI Usage Observatory.

Extend the existing incremental transcript pipeline:

- Bump `PARSER_VERSION` once.
- Extract Codex `rate_limits` beside existing token usage. Normalize durations, percentages, and
  timestamp units at parse time. Skip replayed parent history.
- Accumulate Claude and Codex activity intervals from event timestamps across chunk commits.
- Persist merged intervals and embedded Codex observations by session.
- Keep prefilter equivalence, oversized-line handling, resume hashes, and rebuild-on-rewrite tests.

For Warp, extend the existing read-only collector instead of the transcript index:

- select `agent_tasks.last_modified_at` beside conversation IDs;
- merge those times with `ai_queries.start_ts` into 30-minute episodes;
- persist the minimal Warp session ID, provider, intervals, source timestamp, and source identity in
  the same session-evidence store used by Codex and Claude;
- expose intervals with the existing Warp session objects and retain the stored evidence if Warp
  later removes the source conversation;
- do not read every `agent_tasks.task` blob.

First implementation tradeoff: Claude and Codex context requires the existing transcript index to
be enabled. Say `Local transcript indexing is disabled` when it is off. Warp context remains
available because its collector already reads the local database. A later rename can present the
index as shared session evidence rather than an effort-only feature without forking the pipeline.

Exit criteria: chunked and resumed fixtures produce stable intervals and observations; Warp
interval collection remains column-only and survives removal of its source fixture; no path reads
a whole large transcript or all Warp blobs.

### 5. Derive context on demand

Repository: AI Usage Observatory.

- Add a server module for episodes, cycle-safe bracketing, pool math, coverage, confidence, and
  concurrency. Keep this logic out of React and `parseSessionDetailJsonl`.
- Use indexed intervals and embedded observations for Codex, indexed intervals plus quota history
  for Claude, and Warp collector intervals plus pool history for Warp.
- Intersect stored or collected intervals. Do not scan every transcript at request time.
- Cache by session source identity and provider `historyVersion`. Include Warp database mtime in
  Warp cache identity.
- Add the context to session detail or use a separate on-demand endpoint if that keeps the main
  list fast. Do not calculate every historical session at startup.
- Return an explicit insufficient reason rather than manufacturing a number.

Exit criteria: all three provider fixtures produce stable results, including resets, renewals,
pauses, concurrency, limit changes, and files larger than 12 MB.

### 6. Add session-detail and source presentation

Repository: AI Usage Observatory.

- Add quota context near existing run metadata.
- Show Codex and Claude 5-hour and weekly resources separately.
- Show Warp monthly movement as count plus absolute share of quota. Keep the existing current monthly
  dial and remaining count.
- Use `% of quota` for absolute deltas and preserve fractional source data in accessible detail.
- Show same-provider concurrency in the primary copy. Put cross-provider overlap and external
  activity in disclosure text.
- Add account-level and non-additive wording in an accessible disclosure.
- Omit unavailable metrics. Do not display `0%` for missing or sub-resolution evidence.
- Distinguish disabled indexing, missing history, retention gaps, degraded providers, and an
  unreachable service. Do not nag when optional collection is disabled.
- Verify desktop, narrow layout, keyboard access, and screen-reader wording.

Exit criteria: no view can reasonably be read as exact per-thread billing or as a sum-safe metric.

### 7. Add optional Claude lifecycle markers

Repositories: quota-service first, then AI Usage Observatory.

- Add a local marker endpoint and one new marker table.
- Provide a fail-open helper for Claude `SessionStart`, `Stop`, and supported lifecycle hooks. Map
  provider hook names into the normalized marker events.
- Use a short timeout, empty standard output, and no model-visible response.
- Document opt-in install and uninstall. Never edit global Claude settings silently.
- Store markers even when collection is rate-limited. Do not use a marker to bypass poll floors.
- Apply `QUOTA_RETENTION_DAYS` to markers. With the documented `forever` setting, marker pruning is
  disabled. A future finite override prunes markers by `occurredAt` while keeping plan assignments.
- Prefer consistent markers over inferred boundaries. Fall back when markers are absent or invalid.
- Report `hooks configured but no recent markers` separately from service health.

Exit criteria: passive history still works, hook failure cannot block Claude, and no conversation
content enters the marker table.

### 8. Build empirical comparisons after enough data exists

Repository: AI Usage Observatory.

Partition cohorts whenever provider, configured or provider-reported tier, pool limit, cadence, or
plan provenance changes.

For Codex and Claude, report separately by 5-hour and weekly resource:

- API-equivalent work per 100% of observed allowance;
- output tokens per 100% of observed allowance;
- active minutes per 100% of observed allowance;
- completed sessions per resolved cycle;
- sample size, coverage, and confidence distribution.

For Warp, report provider-specific measures:

- recorded Warp-managed tokens per 100 observed Warp credits;
- active minutes per 100 observed Warp credits;
- completed local Warp sessions per monthly cycle;
- count and absolute allowance-share movement, sample size, coverage, and confidence.

Use `tokensBySource.warp`, not BYOK or custom-endpoint tokens, for Warp credit normalization. Do not
produce a cross-provider ratio for Warp because a monthly Warp credit is not the same resource as a
5-hour or weekly percentage window.

Do not compare any providers when tier is unknown, sample size is too small, cycles are unresolved,
or coverage is unacceptable. Label every result as observed on this account and workload.

Exit criteria: the report helps the user compare observed behavior without presenting a provider
guarantee or a unit conversion that the data does not support.

## Testing and verification

### quota-service

- Test history validation, the 31-day range, 5,000-row pages, stable cursors during concurrent
  inserts, chronological order by observation time, captured versus observed time, repeated
  frozen-source reads, no collection on history reads, earliest observation, row-ID history
  version, and `forever` retention reporting.
- Test that finite retention remains opt-in, preserves the latest provider row, and never prunes
  plan assignments. Test raw-versus-compacted result parity before implementing compaction.
- Test window and pool cycle IDs, Warp counts and percent validation, unit provenance,
  effective-dated plan provenance, stale status, and safe failure messages.
- Test legacy response compatibility and partial provider failure.
- Test lifecycle marker validation and provider poll-floor preservation.
- Run `bun test` and `bun run typecheck`.

### AI Usage Observatory

- Test Codex reversed windows, missing windows, fractions, epoch conversion, resets, replayed parent
  history, and transcripts larger than 12 MB.
- Test interval accumulation across chunks, resumes, rebuilds, and 30-minute gaps.
- Test Warp timestamp conversion, task-update intervals without blob reads, renewal crossings,
  changed limits, counter decreases, missing unit provenance, and retained minimal evidence after
  a source conversation disappears.
- Test Claude and Warp bracketing with sparse history, missing sides, retention gaps, and history-only
  mode.
- Test same-provider and cross-provider concurrency separately, including subagents.
- Assert `additive: false` and external activity `unknown` in every successful context.
- Assert existing reduced quota history stays shape-compatible.
- Test no service, old service, independent endpoint failures, provider failures, stale data,
  indexing disabled, and configured hooks without markers.
- Add UI tests for insufficient evidence, single and multi-cycle values, Warp count plus percent,
  concurrency copy, and source health.
- Run `bun test`, `bun run typecheck`, and `bun run build`.

### Live-state safety

- Reuse healthy services on ports 5173, 4318, and 8787. Do not restart them for fixture tests.
- Copy any quota or Warp database needed for verification to a temporary directory. Never migrate,
  prune, or insert fixtures into live databases.
- If an isolated server is necessary, use another free port and stop only its recorded PID.
- Leave the Observatory reachable and report the preserved local URL.

## Acceptance criteria

- Codex session context uses embedded observations without another transcript reader.
- Claude context works when raw optional quota history brackets its active episodes.
- Warp context shows monthly count and percentage-point movement from existing pool observations.
- Warp current percentage remains a single calculation owned by quota-service.
- Warp credits are not labeled tokens, and Warp-managed tokens remain workload evidence only.
- Every result includes basis, coverage, confidence, cycle count, same-provider concurrency, external
  activity unknown, and `additive: false`.
- Resets, renewals, pauses, counter decreases, and pool limit changes cannot create false deltas.
- Replayed Codex parent history contributes no observations or activity intervals.
- quota-service absence or failure does not break core analytics or create a nag when disabled.
- `/history` never triggers collection and reports retention reach plus row-ID history version.
- The documented configuration sets `QUOTA_RETENTION_DAYS=forever`; quota snapshots, reset-credit
  history, markers, plan assignments, and minimal session evidence remain available across the
  full observed time range unless the user explicitly deletes them.
- Provider failures remain visible per provider and preserve the last valid observations.
- Claude hooks remain optional and collect no conversation content.
- Comparisons identify plan provenance and reject unsupported provider or unit comparisons.

## Non-goals for the first implementation

- Exact causal attribution to one local thread.
- Proportional allocation among concurrent sessions.
- Combining 5-hour, weekly, and monthly resources into one score.
- Treating Warp credits as raw tokens, prompts, or a documented conversion to another provider.
- Attributing Warp add-on credit purchases or rollover to a session.
- Requiring quota-service, Claude hooks, or a live provider call for core analytics.
- Moving credentials or raw provider responses into the Observatory.
- Session context for model-scoped buckets.
- Replacing quota-service `/runs`.
- Renaming or fully separating the shared transcript index in this delivery.
- Compacting raw history before parity tests prove that state intervals preserve every result.

## Suggested change boundaries

Keep these independently reviewable where practical:

1. `feat(quota): add normalized bounded history and provider health`
2. `feat(quota): support optional Claude lifecycle markers`
3. `feat(effort): index quota observations and activity intervals`
4. `feat(warp): expose conversation activity intervals`
5. `feat(sessions): derive account quota context by active episode`
6. `feat(ui): display session quota context and source health`
7. `feat(analytics): compare observed allowance efficiency by provider tier`

These are Conventional Commit drafts, not instructions to commit during planning.

## Follow-up enhancements

- Rename the effort-only indexing control to a shared local transcript indexing control, then let
  effort analytics and session quota context subscribe independently.
- Show same-provider and cross-provider concurrency as separate visible rows if the disclosure is
  too easy to miss.
- Add model-scoped quota context only after provider semantics and stable history justify it.
- Replace configured tier names with provider-reported Warp plan identity if Warp exposes one.
- Compact repeated quota and reset-credit states into confirmation intervals after raw-versus-
  compacted parity tests pass. Keep the full historical time range.
