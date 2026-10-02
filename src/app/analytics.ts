import { dateKeyInTimeZone, systemTimeZone } from "../reporting-time";
import { providerFromAgent, type ActivityProvider } from "../provider";
import { type ModelRowInput } from "../token-types";
import { quotaProviderNotice, type QuotaNotice } from "../quota-notice";
import type {
  DashboardData,
  EffortIndexStatus,
  EffortSummary,
  MetricRow,
  ModelBreakdown,
  ProjectActivity,
  ProjectTrendRow,
  Session,
  SessionQuotaContext,
  QuotaHistory,
  QuotaReach,
  QuotaProvider,
} from "../types";
import { aggregateModels } from "../model-aggregation";
import { type Metric, type ProjectSummary } from "./preferences";
import { providerKey, formatCompact, providerSeries, formatDuration, formatWarpCredits } from "./format";

const fiveHoursMs = 5 * 60 * 60 * 1_000;

type CurrentFiveHourWindow = {
  provider: "anthropic" | "codex";
  startAt: number;
  endAt: number;
};


/** Each provider's reported reset marks the end of its independently timed five-hour window. */
export function currentFiveHourWindows(
  quotas: DashboardData["quotas"],
  now = Date.now(),
): CurrentFiveHourWindow[] {
  return (quotas.usage?.providers ?? []).flatMap((provider) => {
    if (provider.provider !== "anthropic" && provider.provider !== "codex")
      return [];
    const resetAt =
      provider.snapshot?.kind === "window"
        ? provider.snapshot.fiveHour?.resetsAt
        : null;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= now)
      return [];
    return [{ provider: provider.provider, startAt: resetAt - fiveHoursMs, endAt: resetAt }];
  });
}

const weekMs = 7 * 24 * 60 * 60 * 1_000;


/** Each provider's weekly window, ending at the reset it reports and running the seven days
 * before it. Both providers count a fixed seven-day week, so the opening follows from the reset.
 */
export function currentWeeklyWindows(
  quotas: DashboardData["quotas"],
  now = Date.now(),
): Array<{ provider: "anthropic" | "codex"; startAt: number; endAt: number }> {
  return (quotas.usage?.providers ?? []).flatMap((provider) => {
    if (provider.provider !== "anthropic" && provider.provider !== "codex")
      return [];
    const resetAt =
      provider.snapshot?.kind === "window"
        ? provider.snapshot.weekly?.resetsAt
        : null;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= now)
      return [];
    return [{ provider: provider.provider, startAt: resetAt - weekMs, endAt: resetAt }];
  });
}

export type RecentSessionFloor = {
  at: number;
  /** `weekly` is an open cycle a provider is reporting; `sessions` is the fallback below. */
  basis: "weekly" | "sessions";
};


/** How many sessions each main provider is guaranteed when neither reports a weekly reset. */
const recentSessionFallback = 10;

const sessionActivityAt = (session: Session) =>
  Date.parse(String(session.metadata?.lastActivity ?? ""));


/** How far back the recent list runs.
 *
 * Normally the earlier of the two providers' weekly openings: each provider is then always shown
 * its whole current week, and whichever resets later is shown the few extra days that carries.
 *
 * With no weekly reset reported there is no cycle to cut at, so the floor instead reaches back far
 * enough to hold the last ten sessions of each main provider — again the earlier of the two, so
 * neither is cut short by the other being busier. Null only when neither has a session to measure,
 * and then nothing is cut.
 */
export function recentSessionFloor(
  quotas: DashboardData["quotas"],
  sessions: Session[],
  now = Date.now(),
): RecentSessionFloor | null {
  const openings = currentWeeklyWindows(quotas, now).map((window) => window.startAt);
  if (openings.length) return { at: Math.min(...openings), basis: "weekly" };
  const nth = (["anthropic", "codex"] as const).flatMap((provider) => {
    const times = sessions
      .filter((session) => providerKey(session.agent) === provider)
      .map(sessionActivityAt)
      .filter((at) => Number.isFinite(at))
      .sort((left, right) => right - left);
    // A provider with fewer than ten sessions contributes its oldest, which is all it has.
    return times.length
      ? [times[Math.min(recentSessionFallback, times.length) - 1]!]
      : [];
  });
  return nth.length ? { at: Math.min(...nth), basis: "sessions" } : null;
}


/** Everything the recent list shows: one span, applied to every provider alike. Warp used to be
 * held to the five-hour windows while Claude and Codex ran on past them; the floor is now the
 * single answer to how far back the card reaches. */
export function currentWindowSessions(
  sessions: Session[],
  quotas: DashboardData["quotas"],
  now = Date.now(),
) {
  const floor = recentSessionFloor(quotas, sessions, now);
  return sessions
    .filter((session) => {
      const provider = providerKey(session.agent);
      if (provider !== "anthropic" && provider !== "codex" && provider !== "warp")
        return false;
      if (floor === null) return true;
      const at = sessionActivityAt(session);
      // A session with no readable activity time is kept: nothing about it says it is old.
      return !Number.isFinite(at) || at >= floor.at;
    })
    .sort(
      (left, right) =>
        Date.parse(String(right.metadata?.lastActivity ?? "")) -
        Date.parse(String(left.metadata?.lastActivity ?? "")),
    );
}

export type RecentTerminus = {
  provider: "anthropic" | "codex";
  key: string;
  window: "fiveHour" | "weekly";
  /** `observed` is a boundary the account's own readings recorded, rather than one the provider
   * is reporting live. Only a live one can be named current or previous. */
  scope: "current" | "previous" | "observed";
  /** The instant one window ended and the next opened. */
  at: number;
};


/** Boundaries the providers report right now: each one's current and previous five-hour window,
 * and the opening of the week it is counting. The two providers are timed independently, so each
 * contributes its own. */
export function reportedTermini(
  quotas: DashboardData["quotas"],
  now = Date.now(),
): RecentTerminus[] {
  const fiveHour = currentFiveHourWindows(quotas, now).flatMap((window) =>
    ([
      ["current", window.startAt],
      ["previous", window.startAt - fiveHoursMs],
    ] as const).map(([scope, at]) => ({
      provider: window.provider,
      key: `${window.provider}-fiveHour-${scope}`,
      window: "fiveHour" as const,
      scope,
      at,
    })),
  );
  const weekly = currentWeeklyWindows(quotas, now).map((window) => ({
    provider: window.provider,
    key: `${window.provider}-weekly-current`,
    window: "weekly" as const,
    scope: "current" as const,
    at: window.startAt,
  }));
  return [...fiveHour, ...weekly].sort((left, right) => right.at - left.at);
}


/** Boundaries the account's own readings recorded: two adjacent sessions of one provider that
 * closed in different cycles were separated by that cycle's reset. A provider reports only the
 * windows it is counting now, so this is what keeps the bars going further down the list.
 *
 * Providers are tracked separately because the list interleaves them: Claude's boundary can sit
 * many Codex rows away from the Claude rows it divides.
 */
export function observedTermini(
  sessions: Session[],
  contexts: Record<string, SessionQuotaContext | null | undefined>,
): RecentTerminus[] {
  const previous = new Map<string, { context: SessionQuotaContext; at: number }>();
  const termini = new Map<string, RecentTerminus>();
  for (const session of sessions) {
    const context = contexts[session.sessionId];
    if (!context) continue;
    const at = Date.parse(String(session.metadata?.lastActivity ?? ""));
    if (!Number.isFinite(at)) continue;
    const seen = previous.get(context.provider);
    previous.set(context.provider, { context, at });
    if (!seen) continue;
    for (const boundary of quotaResetBoundaries(seen.context, context)) {
      if (boundary.id !== "fiveHour" && boundary.id !== "weekly") continue;
      if (boundary.provider !== "anthropic" && boundary.provider !== "codex") continue;
      // A cycle id can change without a reset having happened: Codex re-anchors its weekly
      // reset instant as the week runs. Only an instant that falls in the gap between these two
      // sessions is a boundary they observed; anything else is the provider moving the goalposts.
      if (boundary.at < at || boundary.at > seen.at) continue;
      const key = `${boundary.provider}-${boundary.id}-${boundary.at}`;
      termini.set(key, {
        provider: boundary.provider,
        key,
        window: boundary.id,
        scope: "observed",
        at: boundary.at,
      });
    }
  }
  return [...termini.values()];
}


/** Every boundary the recent list can draw: the ones the providers report live, plus the ones
 * their own closing readings recorded further down. A recorded boundary that restates a live one
 * is dropped, since the two readings need not agree to the second. */
export function recentTermini(
  quotas: DashboardData["quotas"],
  sessions: Session[],
  contexts: Record<string, SessionQuotaContext | null | undefined>,
  now = Date.now(),
): RecentTerminus[] {
  const live = reportedTermini(quotas, now);
  return [
    ...live,
    ...observedTermini(sessions, contexts).filter(
      (terminus) =>
        !live.some(
          (other) =>
            other.provider === terminus.provider &&
            other.window === terminus.window &&
            Math.abs(other.at - terminus.at) < 60_000,
        ),
    ),
  ].sort((left, right) => right.at - left.at);
}

export type RecentSessionRow =
  | { kind: "session"; session: Session }
  | { kind: "terminus"; terminus: RecentTerminus };


/** Sessions newest first, with each window opening drawn where the list crosses it. The card
 * keeps showing older sessions, so the bars are what say which of them the heading covers. */
export function recentSessionRows(
  sessions: Session[],
  termini: RecentTerminus[],
): RecentSessionRow[] {
  const pending = [...termini].sort((left, right) => right.at - left.at);
  const rows: RecentSessionRow[] = [];
  for (const session of sessions) {
    const at = Date.parse(String(session.metadata?.lastActivity ?? ""));
    // A session with no readable activity time cannot place a boundary; it sits where the
    // caller's own ordering put it and the pending termini wait for a row that can.
    while (Number.isFinite(at) && pending.length && pending[0]!.at > at) {
      rows.push({ kind: "terminus", terminus: pending.shift()! });
    }
    rows.push({ kind: "session", session });
  }
  return [
    ...rows,
    ...pending.map((terminus) => ({ kind: "terminus" as const, terminus })),
  ];
}


/** Returns `next` with object identity preserved for every subtree deep-equal to `prev`, so a
 * poll that only moved a few numbers leaves the rest of the tree `===` the previous data and
 * slice memos bail instead of recomputing over identical values. */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const prevItems = prev as unknown[];
    let allShared = prevItems.length === next.length;
    const merged = next.map((item, index) => {
      const shared = shareStructure(prevItems[index], item);
      if (!Object.is(shared, prevItems[index])) allShared = false;
      return shared;
    });
    return (allShared ? prev : merged) as T;
  }
  if (
    prev && next && typeof prev === "object" && typeof next === "object" &&
    !Array.isArray(prev) && !Array.isArray(next)
  ) {
    const prevRecord = prev as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const nextKeys = Object.keys(nextRecord);
    let allShared = Object.keys(prevRecord).length === nextKeys.length;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const shared = shareStructure(prevRecord[key], nextRecord[key]);
      merged[key] = shared;
      if (!Object.is(shared, prevRecord[key])) allShared = false;
    }
    return (allShared ? prev : merged) as T;
  }
  return next;
}

export type MetricCardAverage = {
  label: string;
  value: string;
  trend?: number;
};


/** Why a model has no effort levels to break down. The bar is real usage either way, so the
 * tooltip states the reason instead of dropping the section and leaving only a token count. */
export function effortAbsenceReason(
  summary: EffortSummary | null,
  status: EffortIndexStatus | null,
) {
  if (status && !status.enabled) return "Effort indexing is off; enable it in Data.";
  if (status?.phase === "error") return "Effort indexing reported an error.";
  if (!summary) {
    return status?.phase === "indexing"
      ? "No indexed transcripts yet; indexing is still running."
      : "No indexed transcripts for this model in this scope.";
  }
  if (summary.unknownObservations > 0) {
    return `${formatCompact(summary.unknownObservations)} observations, none recording an effort value.`;
  }
  return status?.phase === "indexing"
    ? "No effort recorded yet; indexing is still running."
    : "No effort metadata recorded for this model.";
}

export function sessionDate(session: Session, timeZone = systemTimeZone()) {
  const activityDate = dateKeyInTimeZone(session.metadata?.lastActivity, timeZone);
  if (activityDate) return activityDate;
  const match = session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function withoutCacheBreakdown(model: ModelBreakdown): ModelBreakdown {
  return { ...model, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function withoutCacheMetricRow<T extends MetricRow>(row: T): T {
  return {
    ...row,
    totalTokens: row.inputTokens + row.outputTokens,
    modelBreakdowns: row.modelBreakdowns.map(withoutCacheBreakdown),
    agents: row.agents?.map((agent) => withoutCacheMetricRow(agent)),
  };
}

function withoutCacheProjectTrend(row: ProjectTrendRow): ProjectTrendRow {
  return {
    ...row,
    totalTokens: row.inputTokens + row.outputTokens,
    modelBreakdowns: row.modelBreakdowns.map(withoutCacheBreakdown),
  };
}

function withoutCacheProjectActivity(
  activity: ProjectActivity[],
  sessions: Session[],
  timeZone: string,
) {
  const totals = new Map<
    string,
    { tokens: number; models: Map<string, { tokens: number; cost: number }> }
  >();
  sessions.forEach((session) => {
    const date = sessionDate(session, timeZone);
    const provider = providerKey(session.agent);
    const projectId = session.cwd?.replace(/\/+$/, "");
    if (
      !date ||
      !projectId ||
      !provider
    )
      return;
    const key = `${date}\0${provider}\0${projectId}`;
    const current = totals.get(key) ?? { tokens: 0, models: new Map() };
    current.tokens += session.inputTokens + session.outputTokens;
    session.modelBreakdowns.forEach((model) => {
      const modelTotal = current.models.get(model.modelName) ?? {
        tokens: 0,
        cost: 0,
      };
      modelTotal.tokens += model.inputTokens + model.outputTokens;
      modelTotal.cost += model.cost;
      current.models.set(model.modelName, modelTotal);
    });
    totals.set(key, current);
  });
  return activity.map((item) => {
    const total = totals.get(
      `${item.date}\0${item.provider}\0${item.projectId}`,
    );
    return {
      ...item,
      tokens: total?.tokens ?? 0,
      models: total
        ? [...total.models.entries()]
            .map(([model, values]) => ({ model, ...values }))
            .sort((left, right) => right.tokens - left.tokens)
        : [],
    };
  });
}

export function withoutCacheDashboardData(data: DashboardData): DashboardData {
  const sessions = data.sessions.map(withoutCacheMetricRow);
  const projects = data.projects.map((project) => {
    const trend = project.trend.map(withoutCacheProjectTrend);
    return {
      ...project,
      trend,
      tokens: trend.reduce((sum, row) => sum + row.totalTokens, 0),
    };
  });
  return {
    ...data,
    daily: data.daily.map(withoutCacheMetricRow),
    weekly: data.weekly.map(withoutCacheMetricRow),
    monthly: data.monthly.map(withoutCacheMetricRow),
    totals: {
      ...data.totals,
      totalTokens: data.totals.inputTokens + data.totals.outputTokens,
    },
    sessions,
    projectActivity: withoutCacheProjectActivity(data.projectActivity, sessions, data.timeZone),
    projects,
    models: data.models.map((model) => ({
      ...model,
      tokens: model.inputTokens + model.outputTokens,
      // Scale the priced share; the payload has no per-type split of priced traffic.
      pricedTokens:
        model.tokens > 0
          ? (model.inputTokens + model.outputTokens) * (model.pricedTokens / model.tokens)
          : 0,
    })),
  };
}

function metricRowTraffic(row: MetricRow) {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheReadTokens +
    row.cacheCreationTokens
  );
}

export function metricRowCacheShare(row: MetricRow) {
  const traffic = metricRowTraffic(row);
  return traffic > 0 ? (row.cacheReadTokens / traffic) * 100 : null;
}

export function metricTotals(rows: MetricRow[]) {
  return rows.reduce(
    (sum, row) => ({
      tokens: sum.tokens + row.totalTokens,
      cost: sum.cost + row.totalCost,
      input: sum.input + row.inputTokens,
      output: sum.output + row.outputTokens,
      cache: sum.cache + row.cacheReadTokens,
      cacheWrite: sum.cacheWrite + row.cacheCreationTokens,
      traffic: sum.traffic + metricRowTraffic(row),
    }),
    { tokens: 0, cost: 0, input: 0, output: 0, cache: 0, cacheWrite: 0, traffic: 0 },
  );
}

type MetricAverageSlice = "day" | "weekday" | "weekend";

export type MetricAverageSlices = Record<MetricAverageSlice, number | null>;

type MetricChange = (current: number, previous: number) => number | undefined;

export function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function metricAverageSlice(period: string): Exclude<MetricAverageSlice, "day"> {
  const day = new Date(`${period}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? "weekend" : "weekday";
}


/** Averages over rows with activity. The dashboard's daily rows are sparse, so this keeps
 * the denominator consistent with the existing active-day count shown on the cards. */
export function averageMetricSlices(
  rows: MetricRow[],
  select: (row: MetricRow) => number | null,
): MetricAverageSlices {
  const values: Record<MetricAverageSlice, number[]> = {
    day: [],
    weekday: [],
    weekend: [],
  };
  rows.forEach((row) => {
    const value = select(row);
    if (value === null || !Number.isFinite(value)) return;
    values.day.push(value);
    values[metricAverageSlice(row.period)].push(value);
  });
  return {
    day: average(values.day),
    weekday: average(values.weekday),
    weekend: average(values.weekend),
  };
}

const metricAverageSliceLabels: Array<{ key: MetricAverageSlice; label: string }> = [
  { key: "day", label: "DAY" },
  { key: "weekday", label: "WEEKDAY" },
  { key: "weekend", label: "WEEKEND" },
];

export function metricAverageCardItems(
  current: MetricAverageSlices,
  previous: MetricAverageSlices,
  format: (value: number) => string,
  calculateTrend: MetricChange = percentChange,
): MetricCardAverage[] {
  return metricAverageSliceLabels.map(({ key, label }) => {
    const value = current[key];
    const previousValue = previous[key];
    return {
      label,
      value: value === null ? "—" : format(value),
      trend:
        value !== null && previousValue !== null
          ? calculateTrend(value, previousValue)
          : undefined,
    };
  });
}

export function modelDistribution(rows: MetricRow[], metric: Metric) {
  const models = new Map<
    string,
    {
      name: string;
      provider: ReturnType<typeof providerKey>;
      tokens: number;
      cost: number;
      outputTokens: number;
    }
  >();
  rows.forEach((row) => {
    const sources = row.agents?.length ? row.agents : [row];
    sources.forEach((source) => {
      const provider = providerKey(source.agent);
      source.modelBreakdowns.forEach((model) => {
        const modelKey = `${provider ?? "unknown"}:${model.modelName}`;
        const current = models.get(modelKey) ?? {
          name: model.modelName,
          provider,
          tokens: 0,
          cost: 0,
          outputTokens: 0,
        };
        current.tokens +=
          model.inputTokens +
          model.outputTokens +
          model.cacheReadTokens +
          model.cacheCreationTokens;
        current.cost += model.cost;
        current.outputTokens += model.outputTokens;
        models.set(modelKey, current);
      });
    });
  });
  const key =
    metric === "totalCost"
      ? "cost"
      : metric === "outputTokens"
        ? "outputTokens"
        : "tokens";
  return [...models.values()]
    .map((values) => ({
      rawName: values.name,
      name: values.name.replace(/^claude-|^gpt-/, ""),
      value: values[key],
      tokens: values.tokens,
      cost: values.cost,
      output: values.outputTokens,
      provider: values.provider,
      color:
        providerSeries.find((series) => series.key === values.provider)?.color ??
        "var(--aqua)",
    }))
    .sort((a, b) => b.value - a.value);
}

function combineMetricRows(
  rows: MetricRow[],
  agent: string,
  period: string,
): MetricRow {
  const models = new Map<string, ModelBreakdown>();
  const totals = rows.reduce(
    (total, row) => {
      row.modelBreakdowns.forEach((model) => {
        const current = models.get(model.modelName) ?? {
          modelName: model.modelName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: 0,
        };
        current.inputTokens += model.inputTokens;
        current.outputTokens += model.outputTokens;
        current.cacheReadTokens += model.cacheReadTokens;
        current.cacheCreationTokens += model.cacheCreationTokens;
        current.cost += model.cost;
        models.set(model.modelName, current);
      });
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.cacheReadTokens += row.cacheReadTokens;
      total.cacheCreationTokens += row.cacheCreationTokens;
      total.totalTokens += row.totalTokens;
      total.totalCost += row.totalCost;
      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  );
  return {
    agent,
    period,
    ...totals,
    modelsUsed: [...models.keys()],
    modelBreakdowns: [...models.values()],
  };
}

export function pathFilteredRows(sessions: Session[], periods: Set<string>, timeZone = systemTimeZone()) {
  const sessionsByPeriod = new Map<string, Session[]>();
  sessions.forEach((session) => {
    const date = sessionDate(session, timeZone);
    if (date === null || !periods.has(date)) return;
    sessionsByPeriod.set(date, [
      ...(sessionsByPeriod.get(date) ?? []),
      session,
    ]);
  });
  return [...sessionsByPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, daySessions]) => {
      const agents = [
        ...new Set(daySessions.map((session) => session.agent)),
      ].map((agent) =>
        combineMetricRows(
          daySessions.filter((session) => session.agent === agent),
          agent,
          period,
        ),
      );
      return { ...combineMetricRows(daySessions, "all", period), agents };
    });
}

export function percentChange(current: number, previous: number) {
  return previous > 0
    ? Math.round(((current - previous) / previous) * 100)
    : undefined;
}

export function percentagePointChange(current: number, previous: number) {
  return Math.round(current - previous);
}

type QuotaState = "ok" | "stale" | "suspended" | "unavailable" | "expired";

type QuotaBucket = {
  id: string;
  windowLabel: string;
  usedPercent: number | null;
  resetAt: number | null;
  resetVerb: "resets" | "renews";
  state: QuotaState;
  detail: string;
  historyWindow?: "fiveHour" | "weekly";
  reachedCount?: number;
  reachedAt?: number[];
  reaches?: QuotaReach[];
};

type QuotaCard = {
  provider: "anthropic" | "codex" | "warp";
  providerLabel: string;
  state: QuotaState;
  buckets: QuotaBucket[];
  bankedResets: Array<{ id: string; title: string; expiresAt: string | null }>;
  usedResetCount: number;
  usedResets: Array<{ id: string; title: string; usedAt: number }>;
  /** Why the provider is not fully reported and what to do about it. */
  notice: QuotaNotice | null;
  /** Head label: "current", "unavailable", or a stale state with the age of
   * the reading still on screen ("stale · 18m"). */
  stateLabel: string;
};

function quotaBucket(
  id: string,
  windowLabel: string,
  usedPercent: number | null,
  resetAt: number | null,
  resetVerb: "resets" | "renews",
  reportStatus: string | undefined,
  detail?: string,
  suspended = false,
  historyWindow?: "fiveHour" | "weekly",
  reachedCount?: number,
  reachedAt?: number[],
  reaches?: QuotaReach[],
): QuotaBucket {
  const hasValue = usedPercent !== null && Number.isFinite(usedPercent);
  const expired = hasValue && resetAt !== null && resetAt <= Date.now();
  const state = suspended
    ? "suspended"
    : reportStatus === "unavailable" || reportStatus === "unknown" || !hasValue
      ? "unavailable"
      : expired
        ? "expired"
        : reportStatus === "stale"
          ? "stale"
          : "ok";
  return {
    id,
    windowLabel,
    usedPercent,
    resetAt,
    resetVerb,
    state,
    detail:
      detail ??
      (hasValue
        ? `${Math.max(0, Math.min(100, 100 - usedPercent)).toFixed(0)}% left`
        : suspended
          ? "temporarily suspended"
          : "not currently reported"),
    historyWindow,
    reachedCount,
    reachedAt,
    reaches,
  };
}

function quotaCardState(report: QuotaProvider | undefined): QuotaState {
  return report?.status === "ok"
    ? "ok"
    : report?.status === "stale"
      ? "stale"
      : "unavailable";
}


/** A stale card names how old its values are, so an old reading is never
 * mistaken for a current one. */
function quotaCardStateLabel(report: QuotaProvider | undefined): string {
  const state = quotaCardState(report);
  if (state === "ok") return "current";
  const age = report?.dataAgeMs;
  if (state === "stale" && report?.snapshot && typeof age === "number" && Number.isFinite(age)) {
    return `stale · ${formatDuration(age)}`;
  }
  return state;
}

export function quotaCards(quotas: DashboardData["quotas"]): QuotaCard[] {
  const reports = new Map(
    quotas.usage?.providers.map((provider) => [provider.provider, provider]) ??
      [],
  );
  const reachHistory = (
    provider: "codex" | "anthropic",
    window: "fiveHour" | "weekly",
  ) =>
    quotas.history?.windows.find(
      (item) => item.provider === provider && item.window === window,
    );
  const anthropic = reports.get("anthropic");
  const anthropicSnapshot =
    anthropic?.snapshot?.kind === "window" ? anthropic.snapshot : null;
  const anthropicBuckets = [
    quotaBucket(
      "anthropic-five-hour",
      "5-hour",
      anthropicSnapshot?.fiveHour?.usedPercent ?? null,
      anthropicSnapshot?.fiveHour?.resetsAt ?? null,
      "resets",
      anthropic?.status,
      anthropic?.error,
      false,
      "fiveHour",
      reachHistory("anthropic", "fiveHour")?.reachedCount,
      reachHistory("anthropic", "fiveHour")?.reachedAt,
      reachHistory("anthropic", "fiveHour")?.reaches,
    ),
    quotaBucket(
      "anthropic-weekly",
      "Weekly",
      anthropicSnapshot?.weekly?.usedPercent ?? null,
      anthropicSnapshot?.weekly?.resetsAt ?? null,
      "resets",
      anthropic?.status,
      anthropic?.error,
      false,
      "weekly",
      reachHistory("anthropic", "weekly")?.reachedCount,
      reachHistory("anthropic", "weekly")?.reachedAt,
      reachHistory("anthropic", "weekly")?.reaches,
    ),
    ...Object.entries(anthropicSnapshot?.modelWindows ?? {}).map(
      ([model, window]) =>
        quotaBucket(
          `anthropic-${model}`,
          `${model} bucket`,
          window.usedPercent,
          window.resetsAt,
          "resets",
          anthropic?.status,
        ),
    ),
  ];
  const codex = reports.get("codex");
  const codexSnapshot =
    codex?.snapshot?.kind === "window" ? codex.snapshot : null;
  const codexBuckets = [
    quotaBucket(
      "codex-five-hour",
      "5-hour",
      codexSnapshot?.fiveHour?.usedPercent ?? null,
      codexSnapshot?.fiveHour?.resetsAt ?? null,
      "resets",
      codex?.status,
      codex?.error,
      Boolean(codexSnapshot && !codexSnapshot.fiveHour),
      "fiveHour",
      reachHistory("codex", "fiveHour")?.reachedCount,
      reachHistory("codex", "fiveHour")?.reachedAt,
      reachHistory("codex", "fiveHour")?.reaches,
    ),
    quotaBucket(
      "codex-weekly",
      "Weekly",
      codexSnapshot?.weekly?.usedPercent ?? null,
      codexSnapshot?.weekly?.resetsAt ?? null,
      "resets",
      codex?.status,
      codex?.error,
      false,
      "weekly",
      reachHistory("codex", "weekly")?.reachedCount,
      reachHistory("codex", "weekly")?.reachedAt,
      reachHistory("codex", "weekly")?.reaches,
    ),
  ];
  const warp = reports.get("warp");
  const pool = warp?.snapshot?.kind === "pool" ? warp.snapshot.pool : null;
  const warpBuckets = [
    quotaBucket(
      "warp-monthly",
      pool?.cadence ?? "Monthly",
      pool?.usedPercent ?? null,
      pool?.refreshesAt ?? null,
      "renews",
      warp?.status,
      pool
        ? `${pool.used.toLocaleString()} / ${pool.limit.toLocaleString()} requests`
        : warp?.error,
    ),
  ];
  const banked = quotas.resets?.codexBankedResetCredits;
  const bankedResets =
    banked?.credits
      .filter((credit) => credit.status === "available")
      .map(({ id, title, expiresAt }) => ({ id, title, expiresAt })) ?? [];
  return [
    {
      provider: "anthropic",
      providerLabel: "Anthropic",
      state: quotaCardState(anthropic),
      stateLabel: quotaCardStateLabel(anthropic),
      buckets: anthropicBuckets,
      bankedResets: [],
      usedResetCount: 0,
      usedResets: [],
      notice: quotaProviderNotice(anthropic),
    },
    {
      provider: "codex",
      providerLabel: "OpenAI",
      state: quotaCardState(codex),
      stateLabel: quotaCardStateLabel(codex),
      buckets: codexBuckets,
      bankedResets,
      usedResetCount: quotas.history?.codexBankedResets.usedCount ?? 0,
      usedResets: quotas.history?.codexBankedResets.used ?? [],
      notice: quotaProviderNotice(codex),
    },
    {
      provider: "warp",
      providerLabel: "Warp",
      state: quotaCardState(warp),
      stateLabel: quotaCardStateLabel(warp),
      buckets: warpBuckets,
      bankedResets: [],
      usedResetCount: 0,
      usedResets: [],
      notice: quotaProviderNotice(warp),
    },
  ];
}

export type ProviderCapacityRow = {
  provider: "anthropic" | "codex" | "warp";
  label: string;
  state: QuotaCard["state"];
  tokens: number;
  tokenShare: number;
  highestUsedPercent: number | null;
  windows: Array<{
    id: string;
    label: string;
    usedPercent: number | null;
    state: QuotaState;
  }>;
  limitReaches: number | null;
  reachBreakdown: string | null;
  resetsApplied: number | null | undefined;
};


/** Joins filtered activity with account-level quota readings. Token share is the
 * utility proxy; current window pressure and locally observed events stay separate
 * so the UI does not pretend unlike provider limits form one efficiency score. */
export function providerCapacityRows(
  daily: MetricRow[],
  quotas: DashboardData["quotas"],
): ProviderCapacityRow[] {
  const tokens = new Map<ActivityProvider, number>();
  for (const row of daily) {
    for (const item of row.agents ?? [row]) {
      const provider = providerFromAgent(item.agent);
      if (!provider) continue;
      tokens.set(provider, (tokens.get(provider) ?? 0) + item.totalTokens);
    }
  }
  const total = [...tokens.values()].reduce((sum, value) => sum + value, 0);
  const reports = new Set(
    quotas.usage?.providers.map((provider) => provider.provider) ?? [],
  );
  return quotaCards(quotas)
    .filter((card) => {
      const hasHistory = quotas.history?.windows.some(
        (window) => window.provider === card.provider,
      );
      return (
        (tokens.get(card.provider) ?? 0) > 0 ||
        reports.has(card.provider) ||
        hasHistory
      );
    })
    .map((card) => {
      const providerTokens = tokens.get(card.provider) ?? 0;
      const usedLevels = card.buckets
        .map((bucket) => bucket.usedPercent)
        .filter(
          (value): value is number => value !== null && Number.isFinite(value),
        );
      const historyWindows =
        card.provider === "warp"
          ? []
          : card.buckets.filter((bucket) => bucket.historyWindow);
      const limitReaches =
        card.provider !== "warp" && quotas.history?.available
          ? historyWindows.reduce(
              (sum, bucket) => sum + (bucket.reachedCount ?? 0),
              0,
            )
          : null;
      const reachBreakdown = historyWindows
        .filter((bucket) => (bucket.reachedCount ?? 0) > 0)
        .map((bucket) => `${bucket.windowLabel} ${bucket.reachedCount}`)
        .join(" · ") || null;
      return {
        provider: card.provider,
        label: card.providerLabel,
        state: card.state,
        tokens: providerTokens,
        tokenShare: total > 0 ? (providerTokens / total) * 100 : 0,
        highestUsedPercent: usedLevels.length ? Math.max(...usedLevels) : null,
        windows: card.buckets.map((bucket) => ({
          id: bucket.id,
          label: bucket.windowLabel,
          usedPercent: bucket.usedPercent,
          state: bucket.state,
        })),
        limitReaches,
        reachBreakdown,
        resetsApplied:
          card.provider === "codex"
            ? quotas.history?.available
              ? card.usedResetCount
              : null
            : undefined,
      };
    });
}

export function sessionModelNames(session: Session) {
  return [
    ...new Set([
      ...session.modelsUsed,
      ...session.modelBreakdowns.map((model) => model.modelName),
    ]),
  ].filter(Boolean);
}

export function quotaNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

export type SessionQuotaBalance = {
  id: string;
  label: string;
  remainingPercent: number | null;
  remainingUnits: number | null;
  reason: string | null;
  /** The closing snapshot arrived well after the session's last activity, so the balance may
   * already include later account movement. */
  stale: boolean;
};


/** Account quota remaining at the closing reading of each resource. An observation of the shared
 * account counter, not a charge to this session; still valid when movement could not resolve. */
export function sessionQuotaBalanceItems(context: SessionQuotaContext | null | undefined): SessionQuotaBalance[] {
  if (!context) return [];
  const labels = { fiveHour: "5h", weekly: "w", monthly: "m" } as const;
  // The same threshold that separates medium from low confidence for movement brackets.
  const staleAfterMs = Math.max(5 * 60_000, (context.coverage.observationCadenceMs ?? 0) * 3);
  const weeklyEnd = context.resources.find((resource) => resource.id === "weekly")?.endUsedPercent ?? null;
  return context.resources.flatMap((resource) => {
    let label: string | undefined = labels[resource.id as keyof typeof labels];
    if (!label) {
      // A model-specific window is a stricter sub-limit of the weekly one; it earns a row only
      // while its reading diverges from the generic weekly reading.
      if (!resource.id.startsWith("model:")) return [];
      if (resource.endUsedPercent === null) return [];
      if (weeklyEnd !== null && Math.abs(resource.endUsedPercent - weeklyEnd) <= 1) return [];
      label = resource.id.slice(6);
    }
    if (resource.endUsedPercent === null) {
      return [{
        id: resource.id,
        label,
        remainingPercent: null,
        remainingUnits: null,
        reason: resource.reason ?? null,
        stale: false,
      }];
    }
    const remainingUnits = resource.kind === "pool" && resource.endUsedUnits !== null && resource.limitUnits !== null
      ? resource.limitUnits - resource.endUsedUnits
      : null;
    return [{
      id: resource.id,
      label,
      remainingPercent: remainingUnits !== null ? null : Math.max(0, 100 - resource.endUsedPercent),
      remainingUnits,
      reason: resource.reason ?? null,
      stale: (resource.endGapMs ?? 0) > staleAfterMs,
    }];
  });
}


/** Quota windows that reset between two adjacent sessions' closing readings. Order-insensitive:
 * the boundary instant is the earlier of the two reset times. */
export function quotaResetBoundaries(
  left: SessionQuotaContext | null | undefined,
  right: SessionQuotaContext | null | undefined,
): Array<{ provider: SessionQuotaContext["provider"]; id: string; label: string; at: number }> {
  if (!left || !right || left.provider !== right.provider) return [];
  const labels = { fiveHour: "5-hour", weekly: "Weekly" } as const;
  return (["fiveHour", "weekly"] as const).flatMap((id) => {
    const a = left.resources.find((resource) => resource.id === id)?.endCycleId;
    const b = right.resources.find((resource) => resource.id === id)?.endCycleId;
    if (!a || !b || a === b || !a.startsWith("reset:") || !b.startsWith("reset:")) return [];
    const at = Math.min(Number(a.slice("reset:".length)), Number(b.slice("reset:".length)));
    return Number.isFinite(at) ? [{ provider: left.provider, id, label: labels[id], at }] : [];
  });
}

export type SessionQuotaEvent = {
  provider: "anthropic" | "codex";
  kind: "quota" | "weekly" | "reset";
  label: string;
  at: number;
};


/** Quota events the account recorded between two adjacent sessions' closing readings: a window
 * hitting its limit, or a banked Codex reset being spent. Order-insensitive in `from`/`to`; the
 * bounds are exclusive on the older side and inclusive on the newer one, so an event that lands
 * exactly on a session's last activity is drawn once, above that session. */
export function sessionQuotaEvents(
  history: QuotaHistory | null | undefined,
  from: number,
  to: number,
): SessionQuotaEvent[] {
  if (!history?.available) return [];
  const older = Math.min(from, to);
  const newer = Math.max(from, to);
  if (!Number.isFinite(older) && !Number.isFinite(newer)) return [];
  const within = (at: number) => at > older && at <= newer;
  const reached = history.windows.flatMap((window) =>
    window.reachedAt.filter(within).map((at) => ({
      provider: window.provider,
      kind: window.window === "weekly" ? ("weekly" as const) : ("quota" as const),
      label: window.window === "weekly" ? "Weekly quota exhausted" : "5-hour quota exhausted",
      at,
    })),
  );
  const resets = history.codexBankedResets.used
    .filter((reset) => within(reset.usedAt))
    .map((reset) => ({
      provider: "codex" as const,
      kind: "reset" as const,
      label: reset.title ? `Banked reset applied · ${reset.title}` : "Banked reset applied",
      at: reset.usedAt,
    }));
  return [...reached, ...resets].sort((left, right) => right.at - left.at);
}


/** One range per quota cycle, in remaining terms, oldest first: a session that spanned a reset
 * reads `25→0, 100→75`. Episodes inside one cycle collapse to first start → last end. */
export type SessionQuotaRange = {
  text: string;
  value: string;
  unit: "%" | "credits";
  magnitude: number;
  magnitudeValue: string;
};

export function quotaRemainingRangeItems(resource: SessionQuotaContext["resources"][number]): SessionQuotaRange[] {
  const cycles = new Map<string, { start: number; end: number; startUnits: number | null; endUnits: number | null }>();
  for (const episode of resource.episodes) {
    const existing = cycles.get(episode.cycleId);
    if (!existing) {
      cycles.set(episode.cycleId, {
        start: episode.startUsedPercent,
        end: episode.endUsedPercent,
        startUnits: episode.startUsedUnits,
        endUnits: episode.endUsedUnits,
      });
    } else {
      existing.end = episode.endUsedPercent;
      existing.endUnits = episode.endUsedUnits;
    }
  }
  return [...cycles.values()].map((cycle) => {
    if (resource.kind === "pool" && cycle.startUnits !== null && cycle.endUnits !== null) {
      if (resource.limitUnits === null || resource.limitChanged) return null;
      const magnitude = Math.max(0, cycle.endUnits - cycle.startUnits);
      const value = `${formatWarpCredits(resource.limitUnits - cycle.startUnits)}→${formatWarpCredits(resource.limitUnits - cycle.endUnits)}`;
      return {
        text: `${value} credits`,
        value,
        unit: "credits" as const,
        magnitude,
        magnitudeValue: formatWarpCredits(magnitude),
      };
    }
    const magnitude = Math.max(0, cycle.end - cycle.start);
    const value = `${quotaNumber(Math.max(0, 100 - cycle.start))}→${quotaNumber(Math.max(0, 100 - cycle.end))}`;
    return {
      text: `${value}%`,
      value,
      unit: "%" as const,
      magnitude,
      magnitudeValue: quotaNumber(magnitude),
    };
  }).filter((range): range is SessionQuotaRange => range !== null);
}

export function quotaRemainingRanges(resource: SessionQuotaContext["resources"][number]): string[] {
  return quotaRemainingRangeItems(resource).map((range) => range.text);
}


/** The agent names the recent list spells out, where "Anthropic" and "OpenAI" would name the
 * vendor rather than the tool the session ran in. */
export const agentTerminusLabels = { anthropic: "Claude", codex: "Codex" } as const;

export const terminusWindowLabels = { fiveHour: "5-hour", weekly: "weekly" } as const;

export function projectDayRows(
  trend: ProjectTrendRow[],
  activity: ProjectActivity[] = [],
) {
  const days = new Map<
    string,
    {
      date: string;
      tokens: number;
      cost: number;
      warpCredits: number;
      runs: number;
      models: Map<string, { tokens: number; cost: number }>;
    }
  >();
  trend.forEach((row) => {
    const day = days.get(row.date) ?? {
      date: row.date,
      tokens: 0,
      cost: 0,
      warpCredits: 0,
      runs: 0,
      models: new Map<string, { tokens: number; cost: number }>(),
    };
    day.tokens += row.totalTokens;
    day.cost += row.totalCost;
    day.warpCredits += row.warpCredits ?? 0;
    day.runs++;
    row.modelBreakdowns.forEach((model) => {
      const tokens =
        model.inputTokens +
        model.outputTokens +
        model.cacheReadTokens +
        model.cacheCreationTokens;
      const current = day.models.get(model.modelName) ?? { tokens: 0, cost: 0 };
      current.tokens += tokens;
      current.cost += model.cost;
      day.models.set(model.modelName, current);
    });
    days.set(row.date, day);
  });
  const providersByDay = new Map<string, ProjectActivity[]>();
  activity.forEach((item) =>
    providersByDay.set(item.date, [
      ...(providersByDay.get(item.date) ?? []),
      item,
    ]),
  );
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const providers = (providersByDay.get(day.date) ?? []).sort(
        (a, b) =>
          providerSeries.findIndex((provider) => provider.key === a.provider) -
          providerSeries.findIndex((provider) => provider.key === b.provider),
      );
      const providerTokens = providers.reduce(
        (totals, item) => {
          totals[item.provider] += item.tokens;
          return totals;
        },
        { anthropic: 0, codex: 0, warp: 0 },
      );
      const attributedTokens = Object.values(providerTokens).reduce(
        (sum, tokens) => sum + tokens,
        0,
      );
      return {
        ...day,
        ...providerTokens,
        unattributed: Math.max(0, day.tokens - attributedTokens),
        runs: providers.length
          ? providers.reduce((sum, item) => sum + item.sessions, 0)
          : day.runs,
        label: new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        models: [...day.models.entries()]
          .map(([name, totals]) => ({ name, ...totals }))
          .sort((a, b) => b.tokens - a.tokens),
        providers,
      };
    });
}

export function projectTrendRowsInRange(
  trend: ProjectTrendRow[],
  daily: MetricRow[],
) {
  const periods = new Set(daily.map((row) => row.period));
  return trend.filter((row) => periods.has(row.date));
}

export function projectSummaryInRange(
  project: ProjectSummary,
  daily: MetricRow[],
  sessionCount: number,
): ProjectSummary | null {
  const trend = projectTrendRowsInRange(project.trend, daily);
  if (!trend.length) return null;
  const modelTotals = new Map<string, number>();
  for (const day of trend) {
    for (const model of day.modelBreakdowns) {
      const tokens =
        model.inputTokens +
        model.outputTokens +
        model.cacheReadTokens +
        model.cacheCreationTokens;
      modelTotals.set(
        model.modelName,
        (modelTotals.get(model.modelName) ?? 0) + tokens,
      );
    }
  }
  return {
    ...project,
    trend,
    tokens: trend.reduce((sum, day) => sum + day.totalTokens, 0),
    cost: trend.reduce((sum, day) => sum + day.totalCost, 0),
    warpCredits: trend.reduce((sum, day) => sum + (day.warpCredits ?? 0), 0) || undefined,
    sessions: sessionCount,
    models: [...modelTotals.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([model]) => model),
  };
}

export type ProjectModelSessionRow = {
  session: Session;
  /** Best available instant for the session: its last activity, else its period day. */
  timestamp: string;
  tokens: number;
  cost: number;
};


/** Sessions of one project that touched one model, newest first. Tokens and cost are that
 * model's share of the session, so a mixed-model session is not counted at its full weight. */
export function projectModelSessionRows(
  sessions: Session[],
  modelName: string,
): ProjectModelSessionRow[] {
  return sessions
    .filter((session) => sessionModelNames(session).includes(modelName))
    .map((session) => {
      const breakdowns = session.modelBreakdowns.filter(
        (model) => model.modelName === modelName,
      );
      return {
        session,
        timestamp: String(session.metadata?.lastActivity ?? session.period),
        tokens: breakdowns.length
          ? breakdowns.reduce(
              (sum, model) =>
                sum +
                model.inputTokens +
                model.outputTokens +
                model.cacheReadTokens +
                model.cacheCreationTokens,
              0,
            )
          : session.totalTokens,
        cost: breakdowns.length
          ? breakdowns.reduce((sum, model) => sum + model.cost, 0)
          : session.totalCost,
      };
    })
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}


/** Date-only periods have no time zone, so they are read at midday to keep the calendar day. */
function sessionStampDate(value: string) {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
}

function formatSessionDay(value: string) {
  const date = sessionStampDate(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

export function formatSessionStamp(value: string) {
  const date = sessionStampDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatSessionDay(value)
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}


/** Oldest — newest, collapsed to a single date when the whole set lands on one day. */
export function sessionRangeLabel(rows: ProjectModelSessionRow[]) {
  if (!rows.length) return "No dated sessions";
  const newest = formatSessionDay(rows[0]!.timestamp);
  const oldest = formatSessionDay(rows.at(-1)!.timestamp);
  return oldest === newest ? oldest : `${oldest} — ${newest}`;
}


/** Every ccusage observation of one model inside the selected rows, agent by agent. Built from
 * the raw agent branches rather than `aggregateModels`, which merges Warp and ccusage sightings
 * of the same model name into one row; the token-type table has to keep them apart. */
export function modelTokenTypeInputs(daily: MetricRow[], modelName: string): ModelRowInput[] {
  const inputs: ModelRowInput[] = [];
  for (const row of daily) {
    for (const agent of row.agents ?? [row]) {
      for (const breakdown of agent.modelBreakdowns) {
        if (breakdown.modelName === modelName) inputs.push({ agent: agent.agent, breakdown });
      }
    }
  }
  return inputs;
}

export type ModelSortKey =
  | "model"
  | "sessions"
  | "total"
  | "output"
  | "input"
  | "cacheRead"
  | "cacheWrite"
  | "cost"
  | "perMtok"
  | "outputShare";

export type ModelSort = { key: ModelSortKey; direction: "asc" | "desc" };

export type ModelTableRow = {
  model: ReturnType<typeof aggregateModels>[number];
  index: number;
  sessions: Session[];
  warpOnly: boolean;
  warpCredits: number;
  perMtok: number | null;
  outputShare: number | null;
};


/** A missing value (an unpriced cost, a Warp-only output share) sorts last in both directions so
 * flipping a column never floats the dashes to the top. */
function modelSortValue(row: ModelTableRow, key: ModelSortKey): number | string | null {
  switch (key) {
    case "model":
      return row.model.model;
    case "sessions":
      return row.sessions.length;
    case "total":
      return row.model.tokens;
    case "output":
      return row.warpOnly ? row.model.tokens : row.model.outputTokens;
    case "input":
      return row.model.inputTokens;
    case "cacheRead":
      return row.model.cacheReadTokens;
    case "cacheWrite":
      return row.model.cacheCreationTokens;
    case "cost":
      return row.model.priced ? row.model.cost : null;
    case "perMtok":
      return row.perMtok;
    case "outputShare":
      return row.outputShare;
  }
}

export function compareModelRows(left: ModelTableRow, right: ModelTableRow, sort: ModelSort) {
  const a = modelSortValue(left, sort.key);
  const b = modelSortValue(right, sort.key);
  if (a === null || b === null) {
    if (a === null && b === null) return left.model.model.localeCompare(right.model.model);
    return a === null ? 1 : -1;
  }
  const comparison =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b)
      : Number(a) - Number(b);
  if (comparison !== 0) return sort.direction === "asc" ? comparison : -comparison;
  return left.model.model.localeCompare(right.model.model);
}

export const MODEL_TABLE_COLUMN_COUNT = 12;


// Only providers that never report (unconfigured) are dropped from the (up to
// three) sets. A stale provider still appears — its windows may carry no values
// (e.g. an expired token), but hiding it would misread as "no Anthropic here".
export function quickOverviewCards(
  quotas: DashboardData["quotas"],
): QuotaCard[] {
  return quotaCards(quotas).filter(
    (card) =>
      card.state !== "unavailable" ||
      card.buckets.some((bucket) => bucket.usedPercent !== null),
  );
}


// Countdown ("3h 12m 10s") plus a condensed local stamp (e.g. "8/28 7:40p" in
// en-US, "28.8. 19:40" in a 24-hour locale), or null once the reset moment
// has passed. The stamp defers to the browser's locale for field order and
// 12- vs 24-hour clock, trimming the day-period to a single lowercase letter
// where the locale uses one, to stay compact.
export function resetCountdownParts(
  resetAt: number,
  now: number,
  withSeconds: boolean,
): { countdown: string; stamp: string } | null {
  const remaining = Math.floor((resetAt - now) / 1000);
  if (remaining <= 0) return null;
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  if (withSeconds) parts.push(`${remaining % 60}s`);
  const date = new Date(resetAt);
  const datePart = date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  const timeParts = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(/\s*([AaPp])\.?[Mm]\.?$/, (_, letter) => letter.toLowerCase());
  const stamp = `${datePart} ${timeParts}`;
  return { countdown: parts.join(" "), stamp };
}

export function condensedResetCopy(
  resetAt: number,
  verb: "resets" | "renews",
  now: number,
  withSeconds: boolean,
) {
  const parts = resetCountdownParts(resetAt, now, withSeconds);
  if (!parts) return `${verb} now`;
  return `${verb} in ${parts.countdown} · ${parts.stamp}`;
}
