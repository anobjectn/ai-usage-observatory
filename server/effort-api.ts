import type { DashboardData, EffortAggregate, EffortGroup, EffortIndexStatus, EffortSessionDigest, EffortSummary, MetricRow, Session } from "../src/types";
import { foldEffort, sortEffortBuckets, utcDate } from "../src/effort-model";
import { providerFromAgent } from "../src/provider";
import { PARSER_VERSION } from "./effort-parse";
import { effortProgress, isEffortIndexing } from "./effort-index";
import { familyOf } from "../src/model-family";
import { outlierFlags } from "./insights";
import {
  getEffortCounters,
  getEffortMeta,
  queryEffortBySession,
  queryEffortGrouped,
  type EffortGroupedRow,
  type EffortQuery,
} from "./effort-store";

export type EffortScope = {
  basis: "timeline" | "sessions";
  rangeDays: number | null;
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
  const effort = resolveEffortFacet(params.get("effort"));
  const outliers = params.get("outliers");
  return {
    basis: params.get("basis") === "sessions" ? "sessions" : "timeline",
    rangeDays: Number.isFinite(rangeDays) && rangeDays > 0 ? Math.min(3_650, Math.floor(rangeDays)) : null,
    providers: resolveProviders(params.get("providers")),
    modelFamilies: resolveModelFamilies(params.get("modelFamilies")),
    pathTag: params.get("pathTag") ?? "all",
    project: params.get("project")?.replace(/\/+$/, "") || null,
    model: params.get("model") || null,
    effort,
    outliers: outliers === "typical" || outliers === "only" ? outliers : "all",
  };
}

export function resolveEffortFacet(effort: string | null | undefined) {
  const value = effort ?? "all";
  return value === "all" || value === "mixed" || value === "unknown" || /^value:.+$/.test(value)
    ? value
    : "all";
}

function sessionDate(session: Session) {
  return utcDate(session.metadata?.lastActivity)
    ?? session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)?.slice(1).join("-")
    ?? null;
}

function rangeStart(rangeDays: number | null) {
  if (rangeDays === null) return null;
  return utcDate(new Date(Date.now() - (rangeDays - 1) * 86_400_000).toISOString());
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
  const from = rangeStart(scope.rangeDays);
  const base = snapshot.sessions.filter((session) => {
    if (!matchesAgentScope(session, scope)) return false;
    if (scope.pathTag !== "all" && !session.pathTags.includes(scope.pathTag)) return false;
    if (scope.project && (session.cwd ?? "").replace(/\/+$/, "") !== scope.project) return false;
    if (scope.model && !session.modelBreakdowns.some((model) => model.modelName === scope.model)) return false;
    if (from) {
      const date = sessionDate(session);
      if (!date || date < from) return false;
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

function effortQuery(group: EffortGroup, scope: EffortScope, sessionIds: string[]): EffortQuery {
  return {
    group,
    sessionIds,
    // The timeline basis restricts calendar activity; the sessions basis takes whole sessions.
    fromDate: scope.basis === "timeline" ? rangeStart(scope.rangeDays) : null,
    agents: agentsFor(scope),
    project: scope.project,
    model: scope.model,
  };
}

function modelTokens(model: Session["modelBreakdowns"][number]) {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
}

function dailyDenominators(snapshot: DashboardData, scope: EffortScope, sessions: Session[]) {
  const from = rangeStart(scope.rangeDays);
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
      if (row.projectId !== scope.project || (from && row.date < from)) continue;
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
      if (from && date < from) continue;
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
    const date = sessionDate(session);
    if (!date) continue;
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
  const rows = foldGroupedRows(queryEffortGrouped(effortQuery(group, scope, sessionIds)), (key) => eligible.get(key) ?? 0, quality)
    .map((row) => ({ ...row, label: labelFor(group, row.key) }))
    .sort((a, b) => (group === "day" ? a.key.localeCompare(b.key) : b.summary.attributedTokens - a.summary.attributedTokens || a.key.localeCompare(b.key)));

  const totalRows = group === "total" ? rows : foldGroupedRows(queryEffortGrouped(effortQuery("total", scope, sessionIds)), () => totalEligible, quality).map((row) => ({ ...row, label: "All activity" }));
  return {
    group,
    rows,
    total: totalRows[0]?.summary ?? foldEffort([], { eligibleTokens: totalEligible, unknownObservations: 0, quality }),
    status,
  };
}

const digestFlags = { mixed: 1, unknown: 2, unjoinable: 4 };

export function buildEffortSessionDigest(snapshot: DashboardData, scope: EffortScope): EffortSessionDigest {
  const status = buildEffortStatus();
  const facetSessions = sessionsMatchingEffortFacet(snapshot, scope);
  const sessions = scopedSessions(snapshot, scope).filter(
    (session) => facetSessions === null || facetSessions.has(session.sessionId),
  );

  const bySession = new Map<string, EffortGroupedRow[]>();
  if (analysisAvailable(status)) {
    for (const row of queryEffortBySession(effortQuery("total", scope, sessions.map((session) => session.sessionId)))) {
      bySession.set(row.key, [...(bySession.get(row.key) ?? []), row]);
    }
  }

  const summaries = sessions.map((session) => {
    const found = bySession.get(session.sessionId);
    // A ccusage session with no path-index match stays in every denominator and is reported as
    // unjoinable Unknown rather than being given an invented transcript association.
    if (!found) return { session, summary: null };
    const known = found.filter((row) => row.effort !== null).map((row) => ({ effort: row.effort!, observations: row.observations, tokens: row.tokens }));
    const unknownObservations = found.filter((row) => row.effort === null).reduce((sum, row) => sum + row.observations, 0);
    const summary = foldEffort(sortEffortBuckets(known), { eligibleTokens: sessionTokens(session), unknownObservations, quality: "ok" });
    return { session, summary };
  });
  const levels = sortEffortBuckets(
    [...new Set(summaries.flatMap(({ summary }) => summary?.levels.map((level) => level.effort) ?? []))]
      .map((effort) => ({ effort, observations: 0, tokens: 0 })),
  ).map((level) => level.effort);
  const rows = summaries.map(({ session, summary }): EffortSessionDigest["rows"][number] => {
    if (!summary) return [session.sessionId, -1, digestFlags.unknown | digestFlags.unjoinable, 0, "0"];
    const flags = (summary.mixed ? digestFlags.mixed : 0)
      | ((summary.unknownTokens ?? 1) > 0 || summary.unknownObservations > 0 ? digestFlags.unknown : 0);
    const coverage = summary.tokenCoverage === null ? 0 : Math.round(summary.tokenCoverage * 1000);
    const mask = summary.levels.reduce(
      (value, level) => value | (1n << BigInt(levels.indexOf(level.effort))),
      0n,
    );
    return [
      session.sessionId,
      summary.dominant ? levels.indexOf(summary.dominant) : -1,
      flags,
      coverage,
      mask.toString(16),
    ];
  });
  return { levels, rows };
}

export function buildSessionEffortSummary(snapshot: DashboardData, sessionId: string): EffortSummary | null {
  const status = buildEffortStatus();
  if (!analysisAvailable(status)) return null;
  const session = snapshot.sessions.find((item) => item.sessionId === sessionId);
  if (!session) return null;
  const rows = queryEffortBySession({ sessionIds: [sessionId], fromDate: null, agents: null, project: null, model: null });
  if (rows.length === 0) return null;
  const known = rows.filter((row) => row.effort !== null).map((row) => ({ effort: row.effort!, observations: row.observations, tokens: row.tokens }));
  const unknownObservations = rows.filter((row) => row.effort === null).reduce((sum, row) => sum + row.observations, 0);
  return foldEffort(sortEffortBuckets(known), {
    eligibleTokens: sessionTokens(session),
    unknownObservations,
    quality: status.quality === "degraded" ? "degraded" : "ok",
  });
}

/** Session ids matching the Data-only effort facet. Selection is by session; once a session is
 * selected its other effort values are not erased from any downstream metric. */
export function sessionsMatchingEffortFacet(snapshot: DashboardData, scope: Pick<EffortScope, "effort">): Set<string> | null {
  if (scope.effort === "all" || !analysisAvailable(buildEffortStatus())) return null;
  const digest = new Map<string, { known: Set<string> }>();
  for (const row of queryEffortBySession({ sessionIds: null, fromDate: null, agents: null, project: null, model: null })) {
    const entry = digest.get(row.key) ?? { known: new Set<string>() };
    if (row.effort !== null) entry.known.add(row.effort);
    digest.set(row.key, entry);
  }
  const wanted = scope.effort.startsWith("value:") ? scope.effort.slice("value:".length) : null;
  return new Set(snapshot.sessions.filter((session) => {
    const known = digest.get(session.sessionId)?.known ?? new Set<string>();
    if (wanted !== null) return known.has(wanted);
    if (scope.effort === "mixed") return known.size >= 2;
    return known.size === 0;
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
