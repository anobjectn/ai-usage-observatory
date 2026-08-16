import type {
  DashboardData,
  EffortAggregate,
  EffortComboBoard,
  EffortComboBoardRow,
  EffortComboBucket,
  EffortComboContrast,
  EffortComboDayRow,
  EffortComboDays,
  EffortCoverageFields,
  EffortGroup,
  EffortIndexStatus,
  EffortSessionDigest,
  EffortSummary,
  MetricRow,
  Session,
} from "../src/types";
import { LED_SESSION_FLOOR, RATED_SESSION_FLOOR } from "../src/types";
import { comboKey, comboKind, comboOf, parseComboFacet, parseComboKey, type Combo } from "../src/combo";
import { compareEffort, foldEffort, sortEffortBuckets } from "../src/effort-model";
import { dateKeyInTimeZone, systemTimeZone } from "../src/reporting-time";
import { providerFromAgent } from "../src/provider";
import { PARSER_VERSION } from "./effort-parse";
import { effortProgress, isEffortIndexing } from "./effort-index";
import { familyOf } from "../src/model-family";
import { flaggedSessionIds, outlierFlags } from "./insights";
import { shiftDateKey, validDateKey } from "../src/time-range";
import {
  getEffortCounters,
  getEffortMeta,
  queryEffortBySession,
  queryEffortCombosByDay,
  queryEffortCombosBySession,
  queryEffortGrouped,
  type EffortComboRow,
  type EffortGroupedRow,
  type EffortQuery,
} from "./effort-store";

export type EffortScope = {
  basis: "timeline" | "sessions";
  rangeDays: number | null;
  fromDate: string | null;
  toDate: string | null;
  /** Selected providers, unioned with `modelFamilies`. Empty means every provider. */
  providers: Array<"anthropic" | "codex">;
  /** Selected dominant-model families, unioned with `providers`. Empty means every model. */
  modelFamilies: string[];
  pathTag: string;
  project: string | null;
  model: string | null;
  /** Data-only facet. `value:x` selects sessions containing observed value `x`. */
  effort: string;
  outliers: "all" | "typical" | "only";
};

const groups: EffortGroup[] = ["total", "day", "project", "model", "provider"];

export function resolveEffortGroup(value: string | null): EffortGroup {
  return groups.includes(value as EffortGroup) ? (value as EffortGroup) : "total";
}

/** Comma-separated list parameter. Unknown provider names are dropped rather than rejected: a
 * stale bookmark should narrow to what still exists, not fail the request. */
export function resolveProviders(value: string | null): Array<"anthropic" | "codex"> {
  const wanted = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return [...new Set(wanted.filter((part): part is "anthropic" | "codex" => part === "anthropic" || part === "codex"))];
}

export function resolveModelFamilies(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
}

export function resolveEffortScope(params: URLSearchParams): EffortScope {
  const rangeDays = Number(params.get("rangeDays"));
  const requestedFrom = params.get("from");
  const requestedTo = params.get("to");
  const validBounds =
    (!requestedFrom || validDateKey(requestedFrom)) &&
    (!requestedTo || validDateKey(requestedTo)) &&
    (!requestedFrom || !requestedTo || requestedFrom <= requestedTo);
  const effort = resolveEffortFacet(params.get("effort"));
  const outliers = params.get("outliers");
  return {
    basis: params.get("basis") === "sessions" ? "sessions" : "timeline",
    rangeDays: Number.isFinite(rangeDays) && rangeDays > 0 ? Math.min(3_650, Math.floor(rangeDays)) : null,
    fromDate: validBounds && requestedFrom ? requestedFrom : null,
    toDate: validBounds && requestedTo ? requestedTo : null,
    providers: resolveProviders(params.get("providers")),
    modelFamilies: resolveModelFamilies(params.get("modelFamilies")),
    pathTag: params.get("pathTag") ?? "all",
    project: params.get("project")?.replace(/\/+$/, "") || null,
    model: params.get("model") || null,
    effort,
    outliers: outliers === "typical" || outliers === "only" ? outliers : "all",
  };
}

/** One facet field, extended rather than duplicated: a second scope member for combos could
 * disagree with this one. An unparseable value resolves to `all` instead of failing the request;
 * a well-formed combo nobody has recorded simply selects no sessions. */
export function resolveEffortFacet(effort: string | null | undefined) {
  const value = effort ?? "all";
  if (value === "all" || value === "mixed" || value === "unknown" || /^value:.+$/.test(value)) return value;
  return parseComboFacet(value) ? value : "all";
}

function snapshotTimeZone(snapshot: DashboardData) {
  return snapshot.timeZone || systemTimeZone();
}

function sessionDate(session: Session, timeZone: string) {
  return dateKeyInTimeZone(session.metadata?.lastActivity, timeZone)
    ?? session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)?.slice(1).join("-")
    ?? null;
}

function rangeStart(rangeDays: number | null, timeZone: string) {
  if (rangeDays === null) return null;
  const today = dateKeyInTimeZone(new Date(), timeZone);
  return today ? shiftDateKey(today, -(rangeDays - 1)) : null;
}

function scopeStart(scope: EffortScope, timeZone: string) {
  return scope.fromDate ?? rangeStart(scope.rangeDays, timeZone);
}

function sessionTokens(session: Session) {
  return session.totalTokens;
}

function dominantModelOf(session: Session) {
  return [...session.modelBreakdowns].sort((a, b) => modelTokens(b) - modelTokens(a))[0]?.modelName ?? "unknown";
}

/** The Agent filter's two grains are unioned, never intersected: picking `anthropic` plus
 * `gpt-5.6-sol` asks for Claude activity *plus* that one Codex model. Requiring both would return
 * nothing, since no session is simultaneously Claude and a Codex model. */
export function matchesAgentScope(session: Session, scope: EffortScope) {
  if (scope.providers.length === 0 && scope.modelFamilies.length === 0) return true;
  const provider = providerFromAgent(session.agent);
  if (provider && scope.providers.includes(provider)) return true;
  return session.modelBreakdowns.some((model) => scope.modelFamilies.includes(familyOf(model.modelName)));
}

/** Session selection is identical for both bases; only whether the day filter reaches the derived
 * rows differs. See `effortQuery`. */
export function scopedSessions(snapshot: DashboardData, scope: EffortScope) {
  const timeZone = snapshotTimeZone(snapshot);
  const from = scopeStart(scope, timeZone);
  const base = snapshot.sessions.filter((session) => {
    if (!matchesAgentScope(session, scope)) return false;
    if (scope.pathTag !== "all" && !session.pathTags.includes(scope.pathTag)) return false;
    if (scope.project && (session.cwd ?? "").replace(/\/+$/, "") !== scope.project) return false;
    if (scope.model && !session.modelBreakdowns.some((model) => model.modelName === scope.model)) return false;
    if (from) {
      const date = sessionDate(session, timeZone);
      if (!date || date < from) return false;
    }
    if (scope.toDate) {
      const date = sessionDate(session, timeZone);
      if (!date || date > scope.toDate) return false;
    }
    return true;
  });
  if (scope.outliers === "all") return base;
  // Outlier detection runs on the whole scoped cohort; the facet only chooses what is retained
  // afterward, mirroring `buildInsights`.
  const annotated = base.map((session) => ({
    session,
    sessionId: session.sessionId,
    provider: providerFromAgent(session.agent) ?? "anthropic",
    family: familyOf(dominantModelOf(session)),
    cacheReadTokens: session.cacheReadTokens,
    processed: sessionTokens(session),
    outputTokens: session.outputTokens,
  }));
  const { flagged } = outlierFlags(annotated);
  return annotated
    .filter((row) => (scope.outliers === "only" ? flagged.has(row.sessionId) : !flagged.has(row.sessionId)))
    .map((row) => row.session);
}

/** Derived-row prefilter. It can only narrow by provider, so a scope that also names model
 * families must not push it down — the session-id allowlist already carries the union. */
function agentsFor(scope: EffortScope): Array<"claude" | "codex"> | null {
  if (scope.modelFamilies.length > 0 || scope.providers.length === 0) return null;
  return scope.providers.map((provider) => (provider === "anthropic" ? "claude" : "codex"));
}

function effortQuery(group: EffortGroup, scope: EffortScope, sessionIds: string[], timeZone: string): EffortQuery {
  return {
    group,
    sessionIds,
    // The timeline basis restricts calendar activity; the sessions basis takes whole sessions.
    fromDate: scope.basis === "timeline" ? scopeStart(scope, timeZone) : null,
    toDate: scope.basis === "timeline" ? scope.toDate : null,
    agents: agentsFor(scope),
    project: scope.project,
    model: scope.model,
  };
}

function modelTokens(model: Session["modelBreakdowns"][number]) {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
}

function dailyDenominators(snapshot: DashboardData, scope: EffortScope, sessions: Session[]) {
  const timeZone = snapshotTimeZone(snapshot);
  const from = scopeStart(scope, timeZone);
  const to = scope.toDate;
  const totals = new Map<string, number>();
  // Neither authoritative source is broken down by model family, so a family-scoped request falls
  // through to session allocation rather than reporting a provider-wide denominator.
  const providerOnly = scope.modelFamilies.length === 0;
  const wantsProvider = (provider: "anthropic" | "codex") =>
    scope.providers.length === 0 || scope.providers.includes(provider);
  if (providerOnly && scope.pathTag === "all" && scope.project && !scope.model) {
    // Project activity already carries the app's authoritative provider/day allocation. Using it
    // avoids assigning a multi-day session's whole denominator to its last-activity day.
    for (const row of snapshot.projectActivity ?? []) {
      if (row.projectId !== scope.project || (from && row.date < from) || (to && row.date > to)) continue;
      if (!wantsProvider(row.provider)) continue;
      totals.set(row.date, (totals.get(row.date) ?? 0) + row.tokens);
    }
    return totals;
  }
  const usable = providerOnly && scope.pathTag === "all" && !scope.project && !scope.model;
  if (usable) {
    // The unfiltered case reads the app's authoritative daily rows so Explorer's effort stack and
    // its token chart share one denominator.
    for (const row of snapshot.daily as MetricRow[]) {
      const date = row.period;
      if ((from && date < from) || (to && date > to)) continue;
      const tokens = scope.providers.length === 0
        ? row.totalTokens
        : (row.agents ?? [])
            .filter((agent) => {
              const provider = providerFromAgent(agent.agent);
              return provider !== null && wantsProvider(provider);
            })
            .reduce((sum, agent) => sum + agent.totalTokens, 0);
      if (tokens > 0) totals.set(date, (totals.get(date) ?? 0) + tokens);
    }
    return totals;
  }
  // Path- and project-scoped days fall back to session allocation, which is what the existing
  // path-filtered views already do.
  for (const session of sessions) {
    const date = sessionDate(session, timeZone);
    if (!date || (from && date < from) || (to && date > to)) continue;
    totals.set(date, (totals.get(date) ?? 0) + sessionTokens(session));
  }
  return totals;
}

function denominators(group: EffortGroup, snapshot: DashboardData, scope: EffortScope, sessions: Session[]) {
  const totals = new Map<string, number>();
  const add = (key: string, tokens: number) => totals.set(key, (totals.get(key) ?? 0) + tokens);
  if (group === "total") {
    add("", sessions.reduce((sum, session) => sum + sessionTokens(session), 0));
    return totals;
  }
  if (group === "day") return dailyDenominators(snapshot, scope, sessions);
  for (const session of sessions) {
    if (group === "project") add((session.cwd ?? "").replace(/\/+$/, ""), sessionTokens(session));
    else if (group === "provider") add(session.agent === "codex" ? "codex" : "claude", sessionTokens(session));
    else for (const model of session.modelBreakdowns) add(model.modelName, modelTokens(model));
  }
  return totals;
}

function labelFor(group: EffortGroup, key: string) {
  if (group === "provider") return key === "codex" ? "Codex" : "Claude Code";
  if (group === "project") return key === "" ? "Unassigned" : key;
  if (group === "model") return key === "" ? "Unknown model" : key;
  if (group === "day") return key === "" ? "Undated" : key;
  return "All activity";
}

function foldGroupedRows(rows: EffortGroupedRow[], eligibleFor: (key: string) => number, quality: EffortSummary["quality"]) {
  const byKey = new Map<string, EffortGroupedRow[]>();
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  return [...byKey.entries()].map(([key, keyRows]) => {
    const known = keyRows.filter((row) => row.effort !== null).map((row) => ({ effort: row.effort!, observations: row.observations, tokens: row.tokens }));
    const unknownObservations = keyRows.filter((row) => row.effort === null).reduce((sum, row) => sum + row.observations, 0);
    return { key, summary: foldEffort(sortEffortBuckets(known), { eligibleTokens: eligibleFor(key), unknownObservations, quality }) };
  });
}

export function buildEffortStatus(): EffortIndexStatus {
  const meta = getEffortMeta();
  const counters = getEffortCounters();
  const progress = meta.enabled
    ? effortProgress()
    : counters.indexedSessions > 0
      ? {
          indexedSessions: counters.indexedSessions,
          pendingSessions: 0,
          indexedBytes: counters.indexedBytes,
          pendingBytes: 0,
        }
      : null;
  const indexing = meta.enabled && (isEffortIndexing() || (progress?.pendingSessions ?? 0) > 0);
  const phase: EffortIndexStatus["phase"] = !meta.enabled ? "disabled" : meta.lastError ? "error" : indexing ? "indexing" : "ready";
  // Quality counters are reported on their own. They must not degrade the whole index: a real
  // corpus legitimately contains a handful of over-limit lines, and degrading globally would
  // suppress token shares for millions of correctly parsed observations. Share suppression is
  // reserved for a scope whose reconciliation actually failed.
  const quality: EffortIndexStatus["quality"] = meta.lastError
    ? "degraded"
    : (!meta.enabled && counters.indexedSessions > 0) || indexing
      ? "stale"
      : "ok";
  return {
    enabled: meta.enabled,
    phase,
    quality,
    parserVersion: PARSER_VERSION,
    indexVersion: meta.indexVersion,
    indexedAt: meta.indexedAt,
    error: meta.lastError,
    progress,
    parseErrors: counters.parseErrors,
    contextGaps: counters.contextGaps,
    skippedBytes: counters.skippedBytes,
  };
}

/** Retained rows from a disabled index are excluded from current analysis; the status still
 * reports them so the Data view can offer to delete them. */
function analysisAvailable(status: EffortIndexStatus) {
  return status.enabled;
}

export function buildEffortAggregate(snapshot: DashboardData, scope: EffortScope, group: EffortGroup): EffortAggregate {
  const status = buildEffortStatus();
  const quality: EffortSummary["quality"] = status.quality === "degraded" ? "degraded" : status.phase === "indexing" ? "stale" : "ok";
  const facetSessions = sessionsMatchingEffortFacet(snapshot, scope);
  const sessions = scopedSessions(snapshot, scope).filter(
    (session) => facetSessions === null || facetSessions.has(session.sessionId),
  );
  const eligible = denominators(group, snapshot, scope, sessions);
  const totalEligible = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);

  if (!analysisAvailable(status)) {
    return {
      group,
      rows: [],
      total: foldEffort([], { eligibleTokens: totalEligible, unknownObservations: 0, quality }),
      status,
    };
  }

  const sessionIds = sessions.map((session) => session.sessionId);
  const timeZone = snapshotTimeZone(snapshot);
  const rows = foldGroupedRows(queryEffortGrouped(effortQuery(group, scope, sessionIds, timeZone)), (key) => eligible.get(key) ?? 0, quality)
    .map((row) => ({ ...row, label: labelFor(group, row.key) }))
    .sort((a, b) => (group === "day" ? a.key.localeCompare(b.key) : b.summary.attributedTokens - a.summary.attributedTokens || a.key.localeCompare(b.key)));

  const totalRows = group === "total" ? rows : foldGroupedRows(queryEffortGrouped(effortQuery("total", scope, sessionIds, timeZone)), () => totalEligible, quality).map((row) => ({ ...row, label: "All activity" }));
  return {
    group,
    rows,
    total: totalRows[0]?.summary ?? foldEffort([], { eligibleTokens: totalEligible, unknownObservations: 0, quality }),
    status,
  };
}

function coverageOf(summary: EffortSummary): EffortCoverageFields {
  return {
    observedObservations: summary.observedObservations,
    unknownObservations: summary.unknownObservations,
    observationCoverage: summary.observationCoverage,
    eligibleTokens: summary.eligibleTokens,
    attributedTokens: summary.attributedTokens,
    unknownTokens: summary.unknownTokens,
    tokenCoverage: summary.tokenCoverage,
  };
}

const emptyCoverage = (eligibleTokens: number): EffortCoverageFields =>
  coverageOf(foldEffort([], { eligibleTokens, unknownObservations: 0, quality: "ok" }));

type ComboAccumulator = Combo & {
  kind: EffortComboBucket["kind"];
  observations: number;
  tokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  reasoningReportedEvents: number;
};

/** Raw model variants collapse here, not in SQL: `comboOf()` is the only family conversion, so a
 * release alias can never be one cohort in a chart and another in a filter. */
function foldComboRows(rows: EffortComboRow[]) {
  const byKey = new Map<string, ComboAccumulator>();
  for (const row of rows) {
    const combo = comboOf(row.model, row.effort ?? "");
    const key = comboKey(combo);
    const bucket = byKey.get(key) ?? {
      ...combo,
      kind: comboKind(row.model),
      observations: 0,
      tokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      reasoningReportedEvents: 0,
    };
    bucket.observations += row.observations;
    bucket.tokens += row.tokens;
    bucket.outputTokens += row.outputTokens;
    bucket.reasoningOutputTokens += row.reasoningOutputTokens;
    bucket.reasoningReportedEvents += row.reasoningReportedEvents;
    byKey.set(key, bucket);
  }
  return byKey;
}

/** A provider that reports no reasoning at all is `null`; one that reported zero reasoning tokens
 * over real events is `0`. The event count is the only thing that distinguishes them. */
function reasoningShareOf(bucket: Pick<ComboAccumulator, "reasoningReportedEvents" | "outputTokens" | "reasoningOutputTokens">) {
  return bucket.reasoningReportedEvents === 0 || bucket.outputTokens === 0
    ? null
    : bucket.reasoningOutputTokens / bucket.outputTokens;
}

function comboBucket(bucket: ComboAccumulator): EffortComboBucket {
  return { ...bucket, reasoningShare: reasoningShareOf(bucket) };
}

const compareBuckets = (a: EffortComboBucket, b: EffortComboBucket) =>
  b.tokens - a.tokens || b.observations - a.observations || a.family.localeCompare(b.family) || compareEffort(a.effort, b.effort);

/** Day-level combo stacks. Reconciliation stays per day against the existing authoritative day
 * total: there is no `(day, model)` denominator, so a multi-day session allocated to its
 * last-activity day cannot suppress otherwise-valid model cells. */
export function buildEffortComboDays(snapshot: DashboardData, scope: EffortScope): EffortComboDays {
  const status = buildEffortStatus();
  const facetSessions = sessionsMatchingEffortFacet(snapshot, scope);
  const sessions = scopedSessions(snapshot, scope).filter(
    (session) => facetSessions === null || facetSessions.has(session.sessionId),
  );
  const eligible = dailyDenominators(snapshot, scope, sessions);
  const totalEligible = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);

  if (!analysisAvailable(status)) {
    return { rows: [], total: emptyCoverage(totalEligible), coverageState: "unavailable", status };
  }

  const timeZone = snapshotTimeZone(snapshot);
  const { group: _group, ...query } = effortQuery("total", scope, sessions.map((session) => session.sessionId), timeZone);
  const rows = queryEffortCombosByDay(query);
  const byDay = new Map<string, EffortComboRow[]>();
  for (const row of rows) byDay.set(row.key, [...(byDay.get(row.key) ?? []), row]);

  // A day the denominator knows about but the index has no rows for is all-unknown coverage, not
  // a missing bar. Taking the union of both sides is what keeps it representable.
  const dates = [...new Set([...byDay.keys(), ...eligible.keys()])].sort((a, b) => a.localeCompare(b));

  const dayRows = dates.map((date): EffortComboDayRow => {
    const buckets = [...foldComboRows(byDay.get(date) ?? []).values()];
    // Coverage is folded through the one function that owns effort arithmetic, so a combo day and
    // an effort-only day reconcile against exactly the same authoritative total.
    const summary = foldEffort(
      buckets.filter((bucket) => bucket.effort !== "").map((bucket) => ({ effort: bucket.effort, observations: bucket.observations, tokens: bucket.tokens })),
      {
        eligibleTokens: eligible.get(date) ?? 0,
        unknownObservations: buckets.filter((bucket) => bucket.effort === "").reduce((sum, bucket) => sum + bucket.observations, 0),
        quality: "ok",
      },
    );
    return {
      key: date,
      buckets: buckets.map(comboBucket).sort(compareBuckets),
      coverage: coverageOf(summary),
      suppressed: summary.reconciliationDeltaTokens > 0,
    };
  });

  const totalBuckets = [...foldComboRows(rows).values()];
  const total = foldEffort(
    totalBuckets.filter((bucket) => bucket.effort !== "").map((bucket) => ({ effort: bucket.effort, observations: bucket.observations, tokens: bucket.tokens })),
    {
      eligibleTokens: totalEligible,
      unknownObservations: totalBuckets.filter((bucket) => bucket.effort === "").reduce((sum, bucket) => sum + bucket.observations, 0),
      quality: "ok",
    },
  );
  return { rows: dayRows, total: coverageOf(total), coverageState: total.coverageState, status };
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A session is led by the single combo with strictly more attributed tokens than every other.
 * A tie is not broken alphabetically: it enters no outcome cohort at all. When nothing was
 * attributed, observations are the only remaining evidence, and only a unique observation leader
 * counts. */
function leadingCombo(buckets: ComboAccumulator[]): string | null {
  const recorded = buckets.filter((bucket) => bucket.effort !== "");
  if (recorded.length === 0) return null;
  if (recorded.length === 1) return comboKey(recorded[0]);
  const uniqueMaxBy = (pick: (bucket: ComboAccumulator) => number) => {
    const best = Math.max(...recorded.map(pick));
    if (best <= 0) return undefined;
    const leaders = recorded.filter((bucket) => pick(bucket) === best);
    return leaders.length === 1 ? comboKey(leaders[0]) : null;
  };
  return uniqueMaxBy((bucket) => bucket.tokens) ?? uniqueMaxBy((bucket) => bucket.observations) ?? null;
}

type BoardAccumulator = ComboAccumulator & {
  sessionsAppeared: number;
  tiesExcluded: number;
  ledTokens: number[];
  ledCosts: number[];
  ledFlagged: number;
  verdicts: { good: number; mixed: number; bad: number };
  projects: Map<string, number>;
};

/** Comparative outcome metrics describe a cohort of whole sessions, so they need a cohort. Below
 * the floor the row still reports its volume — it just declines to compare. */
const comparable = (row: BoardAccumulator) => row.kind === "interactive" && row.ledTokens.length >= LED_SESSION_FLOOR;

type ProjectCohort = {
  costs: number[];
  flagged: number;
  combos: Map<string, { costs: number[]; flagged: number }>;
};

/** Observational deviations of a project × combo cohort from that project's own baseline.
 *
 * Cost uses a log ratio so "twice as much" and "half as much" are equally strong. Flag rate uses
 * an absolute percentage-point delta, because a project with a zero baseline flag rate is normal
 * and dividing by it would manufacture an infinity. */
function buildContrasts(byProject: Map<string, ProjectCohort>): EffortComboContrast[] {
  const contrasts: Array<EffortComboContrast & { strength: number }> = [];
  for (const [projectId, cohort] of byProject) {
    if (cohort.costs.length < LED_SESSION_FLOOR) continue;
    const baselineCost = median(cohort.costs)!;
    const baselineFlagRate = cohort.flagged / cohort.costs.length;
    for (const [key, combo] of cohort.combos) {
      if (combo.costs.length < LED_SESSION_FLOOR) continue;
      const parsed = parseComboKey(key);
      if (!parsed) continue;
      const shared = { projectId, ...parsed, cohortSessions: combo.costs.length, baselineSessions: cohort.costs.length };
      const cohortCost = median(combo.costs)!;
      if (cohortCost > 0 && baselineCost > 0) {
        contrasts.push({
          ...shared,
          metric: "cost",
          value: cohortCost / baselineCost,
          cohortValue: cohortCost,
          baselineValue: baselineCost,
          strength: Math.abs(Math.log(cohortCost / baselineCost)),
        });
      }
      const cohortFlagRate = combo.flagged / combo.costs.length;
      contrasts.push({
        ...shared,
        metric: "flagRate",
        value: cohortFlagRate - baselineFlagRate,
        cohortValue: cohortFlagRate,
        baselineValue: baselineFlagRate,
        strength: Math.abs(cohortFlagRate - baselineFlagRate),
      });
    }
  }
  return contrasts
    .sort((a, b) => b.strength - a.strength || a.projectId.localeCompare(b.projectId))
    .slice(0, 3)
    .map(({ strength: _strength, ...contrast }) => contrast);
}

/** "What works where": one row per combo, with combo-attributable volume separated from
 * whole-session outcomes over the cohort each combo uniquely led. */
export function buildEffortComboBoard(snapshot: DashboardData, scope: EffortScope): EffortComboBoard {
  const status = buildEffortStatus();
  const facetSessions = sessionsMatchingEffortFacet(snapshot, scope);
  const sessions = scopedSessions(snapshot, scope).filter(
    (session) => facetSessions === null || facetSessions.has(session.sessionId),
  );
  const totalEligible = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);
  const emptyBoard: EffortComboBoard = {
    rows: [],
    contrasts: [],
    sessionsScoped: sessions.length,
    tiedSessions: 0,
    coverage: emptyCoverage(totalEligible),
    coverageState: "unavailable",
    status,
  };
  if (!analysisAvailable(status)) return emptyBoard;

  const timeZone = snapshotTimeZone(snapshot);
  const { group: _group, ...query } = effortQuery("total", scope, sessions.map((session) => session.sessionId), timeZone);
  const rows = queryEffortCombosBySession(query);
  if (rows.length === 0) return emptyBoard;

  const bySession = new Map<string, EffortComboRow[]>();
  for (const row of rows) bySession.set(row.key, [...(bySession.get(row.key) ?? []), row]);
  // One untruncated pass over the scoped cohort; each session counts once however many rules it
  // trips. Deriving this from the public findings array would silently under-count at 80.
  const flagged = flaggedSessionIds(sessions, timeZone);

  const board = new Map<string, BoardAccumulator>();
  // Per-project led cohorts, for the observational contrast strip. Only interactive combos enter
  // it: an automated reviewer's sessions are not the user's work.
  const byProject = new Map<string, ProjectCohort>();
  let tiedSessions = 0;
  for (const session of sessions) {
    const found = bySession.get(session.sessionId);
    if (!found) continue;
    const buckets = [...foldComboRows(found).values()];
    const project = (session.cwd ?? "").replace(/\/+$/, "");
    const leader = leadingCombo(buckets);
    const tied = leader === null && buckets.some((bucket) => bucket.effort !== "");
    if (tied) tiedSessions += 1;
    for (const bucket of buckets) {
      const key = comboKey(bucket);
      const entry = board.get(key) ?? {
        ...bucket,
        observations: 0,
        tokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        reasoningReportedEvents: 0,
        sessionsAppeared: 0,
        tiesExcluded: 0,
        ledTokens: [],
        ledCosts: [],
        ledFlagged: 0,
        verdicts: { good: 0, mixed: 0, bad: 0 },
        projects: new Map<string, number>(),
      };
      entry.observations += bucket.observations;
      entry.tokens += bucket.tokens;
      entry.outputTokens += bucket.outputTokens;
      entry.reasoningOutputTokens += bucket.reasoningOutputTokens;
      entry.reasoningReportedEvents += bucket.reasoningReportedEvents;
      entry.sessionsAppeared += 1;
      if (tied) entry.tiesExcluded += 1;
      if (project && bucket.effort !== "") entry.projects.set(project, (entry.projects.get(project) ?? 0) + bucket.tokens);
      if (key === leader) {
        entry.ledTokens.push(session.totalTokens);
        entry.ledCosts.push(session.totalCost);
        if (flagged.has(session.sessionId)) entry.ledFlagged += 1;
        if (project && bucket.kind === "interactive") {
          const cohort: ProjectCohort = byProject.get(project) ?? { costs: [], flagged: 0, combos: new Map() };
          cohort.costs.push(session.totalCost);
          if (flagged.has(session.sessionId)) cohort.flagged += 1;
          const combo = cohort.combos.get(key) ?? { costs: [], flagged: 0 };
          combo.costs.push(session.totalCost);
          if (flagged.has(session.sessionId)) combo.flagged += 1;
          cohort.combos.set(key, combo);
          byProject.set(project, cohort);
        }
        const verdict = session.annotation?.verdict;
        if (verdict) entry.verdicts[verdict] += 1;
      }
      board.set(key, entry);
    }
  }

  const boardRows = [...board.values()].map((entry): EffortComboBoardRow => {
    const rated = entry.verdicts.good + entry.verdicts.mixed + entry.verdicts.bad;
    const led = entry.ledTokens.length;
    return {
      family: entry.family,
      effort: entry.effort,
      kind: entry.kind,
      tokens: entry.tokens,
      observations: entry.observations,
      sessionsAppeared: entry.sessionsAppeared,
      sessionsLed: led,
      tiesExcluded: entry.tiesExcluded,
      reasoningShare: reasoningShareOf(entry),
      medianTokensPerLedSession: comparable(entry) ? median(entry.ledTokens) : null,
      medianCostPerLedSession: comparable(entry) ? median(entry.ledCosts) : null,
      flagRate: comparable(entry) ? entry.ledFlagged / led : null,
      verdict: {
        ...entry.verdicts,
        rated,
        // A separate floor from the led one: five led sessions do not make one rating credible.
        goodRate: entry.kind === "interactive" && rated >= RATED_SESSION_FLOOR ? entry.verdicts.good / rated : null,
      },
      projects: [...entry.projects.entries()]
        .map(([projectId, tokens]) => ({ projectId, tokens }))
        .sort((a, b) => b.tokens - a.tokens || a.projectId.localeCompare(b.projectId))
        .slice(0, 3),
    };
  }).sort((a, b) => b.tokens - a.tokens || b.observations - a.observations || a.family.localeCompare(b.family) || compareEffort(a.effort, b.effort));

  const totalBuckets = [...foldComboRows(rows).values()];
  const coverage = foldEffort(
    totalBuckets.filter((bucket) => bucket.effort !== "").map((bucket) => ({ effort: bucket.effort, observations: bucket.observations, tokens: bucket.tokens })),
    {
      eligibleTokens: totalEligible,
      unknownObservations: totalBuckets.filter((bucket) => bucket.effort === "").reduce((sum, bucket) => sum + bucket.observations, 0),
      quality: "ok",
    },
  );
  return {
    rows: boardRows,
    contrasts: buildContrasts(byProject),
    sessionsScoped: sessions.length,
    tiedSessions,
    coverage: coverageOf(coverage),
    coverageState: coverage.coverageState,
    status,
  };
}

const digestFlags = { mixed: 1, unknown: 2, unjoinable: 4, multipleCombos: 8 };

/** Display-dominant combo: tokens, then observations, then a stable combo-key tie-break.
 *
 * This is a *display* choice, not an outcome one. A session whose largest combo was picked by
 * this tie-break is still a tie for `leadingCombo()` and enters no outcome cohort. */
function dominantComboOf(buckets: ComboAccumulator[]) {
  const recorded = buckets.filter((bucket) => bucket.effort !== "");
  if (recorded.length === 0) return null;
  return [...recorded].sort((a, b) =>
    b.tokens - a.tokens || b.observations - a.observations || comboKey(a).localeCompare(comboKey(b)))[0];
}

export function buildEffortSessionDigest(snapshot: DashboardData, scope: EffortScope): EffortSessionDigest {
  const status = buildEffortStatus();
  const facetSessions = sessionsMatchingEffortFacet(snapshot, scope);
  const sessions = scopedSessions(snapshot, scope).filter(
    (session) => facetSessions === null || facetSessions.has(session.sessionId),
  );

  const bySession = new Map<string, EffortComboRow[]>();
  if (analysisAvailable(status)) {
    const { group: _group, ...query } = effortQuery("total", scope, sessions.map((session) => session.sessionId), snapshotTimeZone(snapshot));
    for (const row of queryEffortCombosBySession(query)) {
      bySession.set(row.key, [...(bySession.get(row.key) ?? []), row]);
    }
  }

  const folded = sessions.map((session) => {
    const found = bySession.get(session.sessionId);
    // A ccusage session with no path-index match stays in every denominator and is reported as
    // unjoinable Unknown rather than being given an invented transcript association.
    if (!found) return { session, buckets: null, summary: null };
    const buckets = [...foldComboRows(found).values()];
    const summary = foldEffort(
      sortEffortBuckets(buckets.filter((bucket) => bucket.effort !== "").map((bucket) => ({ effort: bucket.effort, observations: bucket.observations, tokens: bucket.tokens }))),
      {
        eligibleTokens: sessionTokens(session),
        unknownObservations: buckets.filter((bucket) => bucket.effort === "").reduce((sum, bucket) => sum + bucket.observations, 0),
        quality: "ok",
      },
    );
    return { session, buckets, summary };
  });

  const present = new Map<string, ComboAccumulator>();
  for (const { buckets } of folded) {
    for (const bucket of buckets ?? []) if (bucket.effort !== "") present.set(comboKey(bucket), bucket);
  }
  const families = [...new Set([...present.values()].map((bucket) => bucket.family))].sort();
  const efforts = sortEffortBuckets([...new Set([...present.values()].map((bucket) => bucket.effort))].map((effort) => ({ effort })))
    .map((bucket) => bucket.effort);
  const ordered = [...present.values()].sort((a, b) => a.family.localeCompare(b.family) || compareEffort(a.effort, b.effort));
  const comboIndex = new Map(ordered.map((bucket, index) => [comboKey(bucket), index]));
  const combos = ordered.map((bucket): EffortSessionDigest["combos"][number] =>
    [families.indexOf(bucket.family), efforts.indexOf(bucket.effort), bucket.kind]);

  const rows = folded.map(({ session, buckets, summary }): EffortSessionDigest["rows"][number] => {
    if (!buckets || !summary) return [session.sessionId, -1, digestFlags.unknown | digestFlags.unjoinable, 0, "0"];
    const recorded = buckets.filter((bucket) => bucket.effort !== "");
    const distinctEfforts = new Set(recorded.map((bucket) => bucket.effort)).size;
    const flags = (distinctEfforts >= 2 ? digestFlags.mixed : 0)
      | ((summary.unknownTokens ?? 1) > 0 || summary.unknownObservations > 0 ? digestFlags.unknown : 0)
      | (recorded.length >= 2 ? digestFlags.multipleCombos : 0);
    const coverage = summary.tokenCoverage === null ? 0 : Math.round(summary.tokenCoverage * 1000);
    const mask = recorded.reduce((value, bucket) => value | (1n << BigInt(comboIndex.get(comboKey(bucket))!)), 0n);
    const dominant = dominantComboOf(buckets);
    return [
      session.sessionId,
      dominant ? comboIndex.get(comboKey(dominant))! : -1,
      flags,
      coverage,
      mask.toString(16),
    ];
  });
  return { version: 2, families, efforts, combos, rows };
}

export function buildSessionEffortSummary(snapshot: DashboardData, sessionId: string): EffortSummary | null {
  const status = buildEffortStatus();
  if (!analysisAvailable(status)) return null;
  const session = snapshot.sessions.find((item) => item.sessionId === sessionId);
  if (!session) return null;
  const rows = queryEffortBySession({ sessionIds: [sessionId], fromDate: null, toDate: null, agents: null, project: null, model: null });
  if (rows.length === 0) return null;
  const known = rows.filter((row) => row.effort !== null).map((row) => ({ effort: row.effort!, observations: row.observations, tokens: row.tokens }));
  const unknownObservations = rows.filter((row) => row.effort === null).reduce((sum, row) => sum + row.observations, 0);
  return foldEffort(sortEffortBuckets(known), {
    eligibleTokens: sessionTokens(session),
    unknownObservations,
    quality: status.quality === "degraded" ? "degraded" : "ok",
  });
}

/** Session ids matching the Data-only effort facet. Selection is by session: a combo selection
 * chooses the sessions containing that family × effort, and every other combo in those sessions
 * is retained downstream. Pushing a model/effort predicate into the SQL instead would silently
 * erase the rest of each selected session. */
export function sessionsMatchingEffortFacet(snapshot: DashboardData, scope: Pick<EffortScope, "effort">): Set<string> | null {
  if (scope.effort === "all" || !analysisAvailable(buildEffortStatus())) return null;
  const digest = new Map<string, { efforts: Set<string>; combos: Set<string> }>();
  for (const row of queryEffortCombosBySession({ sessionIds: null, fromDate: null, toDate: null, agents: null, project: null, model: null })) {
    const entry = digest.get(row.key) ?? { efforts: new Set<string>(), combos: new Set<string>() };
    if (row.effort !== null) {
      entry.efforts.add(row.effort);
      entry.combos.add(comboKey(comboOf(row.model, row.effort)));
    }
    digest.set(row.key, entry);
  }
  const combo = parseComboFacet(scope.effort);
  const wanted = scope.effort.startsWith("value:") ? scope.effort.slice("value:".length) : null;
  return new Set(snapshot.sessions.filter((session) => {
    const entry = digest.get(session.sessionId);
    const efforts = entry?.efforts ?? new Set<string>();
    if (combo) return Boolean(entry?.combos.has(comboKey(combo)));
    if (wanted !== null) return efforts.has(wanted);
    if (scope.effort === "mixed") return efforts.size >= 2;
    return efforts.size === 0;
  }).map((session) => session.sessionId));
}

/** A canonical key hashed into an HTTP-safe ETag: no JSON scope text ever reaches the header. */
export function effortEtag(parts: Array<string | number | null>) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(parts.map((part) => String(part ?? "")).join("\0"));
  return `"${hasher.digest("hex").slice(0, 32)}"`;
}

export function scopeKey(scope: EffortScope) {
  return [
    scope.basis,
    scope.rangeDays,
    scope.fromDate,
    scope.toDate,
    [...scope.providers].sort().join("+"),
    [...scope.modelFamilies].sort().join("+"),
    scope.pathTag,
    scope.project,
    scope.model,
    scope.effort,
    scope.outliers,
  ].map((part) => String(part ?? "")).join("|");
}

const memo = new Map<string, string>();
const MEMO_LIMIT = 16;

export function memoizedBody(etag: string, build: () => unknown) {
  const cached = memo.get(etag);
  if (cached !== undefined) {
    // Refresh recency so the 16 most recently used responses survive.
    memo.delete(etag);
    memo.set(etag, cached);
    return cached;
  }
  const body = JSON.stringify(build());
  memo.set(etag, body);
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  return body;
}

export function clearEffortMemo() {
  memo.clear();
}
