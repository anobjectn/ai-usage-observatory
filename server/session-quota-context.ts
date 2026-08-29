import type { QuotaObservation, SessionQuotaContext } from "../src/types";
import { getEffortMeta } from "./effort-store";
import { collectQuotaLifecycleMarkers, collectRawQuotaHistory, type QuotaLifecycleMarker } from "./quota";
import { getNativeSessionKey } from "./path-indexer";
import {
  getEmbeddedQuotaObservations,
  getEpisodesOverlapping,
  mergeActivityEpisodes,
  getSessionEpisodes,
  getSessionProvider,
  SESSION_IDLE_GAP_MS,
  type ActivityEpisode,
} from "./session-evidence";

type Provider = SessionQuotaContext["provider"];
type ResourcePoint = {
  id: string;
  kind: "window" | "pool";
  observedAt: number;
  usedPercent: number;
  usedUnits: number | null;
  limitUnits: number | null;
  cycleId: string;
  unit: "percentage_points" | "warp_credit" | "unknown";
};

export type ContextPolicyInput = {
  sessionId: string;
  provider: Provider;
  basis: SessionQuotaContext["basis"];
  episodes: ActivityEpisode[];
  points: ResourcePoint[];
  otherSessions: ReturnType<typeof getEpisodesOverlapping>;
  earliestObservationAt: number | null;
  sourceState: SessionQuotaContext["sourceState"];
  initialReason?: string | null;
  now?: number;
};

function pointsFromHistory(observations: QuotaObservation[]): ResourcePoint[] {
  const points: ResourcePoint[] = [];
  for (const observation of observations) {
    if (observation.quota.kind === "windows") {
      points.push(...observation.quota.windows.map((window) => ({
        id: window.id,
        kind: "window" as const,
        observedAt: observation.observedAt,
        usedPercent: window.usedPercent,
        usedUnits: null,
        limitUnits: null,
        cycleId: window.cycleId,
        unit: "percentage_points" as const,
      })));
    } else {
      points.push({
        id: observation.quota.pool.id,
        kind: "pool" as const,
        observedAt: observation.observedAt,
        usedPercent: observation.quota.pool.usedPercent,
        usedUnits: observation.quota.pool.usedUnits,
        limitUnits: observation.quota.pool.limitUnits,
        cycleId: observation.quota.pool.cycleId,
        unit: observation.quota.pool.unit === "warp_credit" ? "warp_credit" as const : "unknown" as const,
      });
    }
  }
  return points;
}

function overlap(left: ActivityEpisode, right: ActivityEpisode) {
  return left.startAt <= right.endAt && right.startAt <= left.endAt;
}

function maxConcurrent(target: ActivityEpisode[], others: ActivityEpisode[]) {
  let maximum = 0;
  for (const episode of target) {
    const events: Array<{ at: number; change: number }> = [];
    for (const other of others) {
      if (!overlap(episode, other)) continue;
      events.push({ at: Math.max(episode.startAt, other.startAt), change: 1 });
      events.push({ at: Math.min(episode.endAt, other.endAt), change: -1 });
    }
    events.sort((a, b) => a.at - b.at || b.change - a.change);
    let active = 0;
    for (const event of events) {
      active += event.change;
      maximum = Math.max(maximum, active);
    }
  }
  return maximum;
}

function concurrencyOf(input: ContextPolicyInput): SessionQuotaContext["concurrency"] {
  const same = input.otherSessions.filter((session) => session.sessionId !== input.sessionId && session.provider === input.provider);
  const cross = input.otherSessions.filter((session) => session.sessionId !== input.sessionId && session.provider !== input.provider);
  const overlapping = (session: (typeof input.otherSessions)[number]) =>
    session.episodes.some((other) => input.episodes.some((target) => overlap(target, other)));
  return {
    distinctOtherSameProviderSessions: same.filter(overlapping).length,
    maxOtherSameProviderSessions: maxConcurrent(input.episodes, same.flatMap((session) => session.episodes)),
    distinctOtherProviderSessions: cross.filter(overlapping).length,
    maxOtherProviderSessions: maxConcurrent(input.episodes, cross.flatMap((session) => session.episodes)),
    externalActivity: "unknown",
  };
}

function tolerance(provider: Provider, kind: "window" | "pool") {
  if (kind === "pool") return 0.11;
  return provider === "anthropic" ? 1 : 0.01;
}

type Confidence = SessionQuotaContext["confidence"];
const CONFIDENCE_RANK: Record<Confidence, number> = { insufficient: 0, low: 1, medium: 2, high: 3 };

/** The cadence the collector actually achieved, measured rather than assumed: a fixed 60s
 * threshold called nothing "high" on a service polling every three to four minutes. */
function observedCadenceMs(points: ResourcePoint[]): number | null {
  const times = [...new Set(points.map((point) => point.observedAt))].sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((time, index) => time - times[index]!).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

function confidenceFor(input: {
  basis: SessionQuotaContext["basis"];
  coveredPercent: number;
  startGapMs: number | null;
  endGapMs: number | null;
  cadenceMs: number | null;
}): Confidence {
  if (input.basis === "embedded_account_observation" && input.coveredPercent >= 90) return "high";
  if (input.startGapMs === null || input.endGapMs === null) return "insufficient";
  const widest = Math.max(input.startGapMs, input.endGapMs);
  const cadence = input.cadenceMs ?? 0;
  if (widest <= Math.max(60_000, cadence * 1.5)) return "high";
  if (widest <= Math.max(5 * 60_000, cadence * 3)) return "medium";
  return "low";
}

export function calculateSessionQuotaContext(input: ContextPolicyInput): SessionQuotaContext {
  const now = input.now ?? Date.now();
  const resources: SessionQuotaContext["resources"] = [];
  const resourceIds = [...new Set(input.points.map((point) => point.id))];
  const snapshotKeys = new Set<string>();
  const cadenceMs = observedCadenceMs(input.points);
  const panelStartGaps: number[] = [];
  const panelEndGaps: number[] = [];
  let bestCoveredPercent = 0;
  let activeMs = 0;
  let inconsistent = false;

  for (const episode of input.episodes) {
    activeMs += Math.max(1, episode.endAt - episode.startAt);
  }

  for (const id of resourceIds) {
    const points = input.points.filter((point) => point.id === id).sort((a, b) => a.observedAt - b.observedAt);
    const segments: SessionQuotaContext["resources"][number]["episodes"] = [];
    const startGaps: number[] = [];
    const endGaps: number[] = [];
    let coveredMs = 0;
    let limitChanged = false;
    let unresolved = false;
    let awaitingSnapshot = false;
    for (const episode of input.episodes) {
      const before = [...points].reverse().find((point) => point.observedAt <= episode.startAt) ?? null;
      const after = points.find((point) => point.observedAt >= episode.endAt) ?? null;
      const inside = points.filter((point) => point.observedAt >= episode.startAt && point.observedAt <= episode.endAt);
      const selected = input.basis === "embedded_account_observation"
        ? inside
        : [...new Map([before, ...inside, after].filter(Boolean).map((point) => [`${point!.observedAt}:${point!.cycleId}`, point!])).values()];
      if (input.basis === "bracketed_account_delta") {
        if (!before || !after) {
          unresolved = true;
          // A session that is still running has no closing snapshot yet. That is a schedule
          // which has not caught up, not evidence that is missing, and it reads very
          // differently to someone watching the panel live.
          if (before && !after && now - episode.endAt <= SESSION_IDLE_GAP_MS) awaitingSnapshot = true;
          continue;
        }
        if (episode.startAt - before.observedAt > SESSION_IDLE_GAP_MS || after.observedAt - episode.endAt > SESSION_IDLE_GAP_MS) {
          unresolved = true;
          continue;
        }
        startGaps.push(episode.startAt - before.observedAt);
        endGaps.push(after.observedAt - episode.endAt);
        coveredMs += Math.max(1, episode.endAt - episode.startAt);
      } else if (inside.length) {
        const first = inside[0]!;
        const last = inside.at(-1)!;
        startGaps.push(first.observedAt - episode.startAt);
        endGaps.push(episode.endAt - last.observedAt);
        coveredMs += Math.max(0, last.observedAt - first.observedAt);
      }
      for (const point of selected) snapshotKeys.add(`${point.observedAt}:${point.id}:${point.cycleId}`);
      // A window reported at 0% with no reset instant is a window that has not started yet,
      // which is an unambiguous zero baseline rather than an unreadable cycle. Anthropic
      // reports its five-hour window that way roughly half the time, so rejecting those
      // points left every session that opened a fresh window unresolvable.
      const idle: ResourcePoint[] = [];
      const cycles = new Map<string, ResourcePoint[]>();
      for (const point of selected) {
        if (point.kind === "window" && point.cycleId.startsWith("observed:") && point.usedPercent === 0) {
          idle.push(point);
          continue;
        }
        const values = cycles.get(point.cycleId) ?? [];
        values.push(point);
        cycles.set(point.cycleId, values);
      }
      idle.sort((a, b) => a.observedAt - b.observedAt);
      for (const values of cycles.values()) {
        values.sort((a, b) => a.observedAt - b.observedAt);
        const anchor = [...idle].reverse().find((point) => point.observedAt <= values[0]!.observedAt);
        if (anchor) values.unshift({ ...anchor, cycleId: values[0]!.cycleId });
      }
      // Every observation across the bracket showed an unstarted window: the session moved
      // this resource by nothing, which is a resolved answer rather than a missing one.
      if (!cycles.size && idle.length > 1) cycles.set(`idle:${idle[0]!.observedAt}`, idle);
      for (const [cycleId, values] of cycles) {
        values.sort((a, b) => a.observedAt - b.observedAt);
        if (cycleId.startsWith("observed:") || values.length < 2) {
          unresolved = true;
          continue;
        }
        const start = values[0]!;
        const end = values.at(-1)!;
        const percentDelta = end.usedPercent - start.usedPercent;
        const unitsDelta = start.usedUnits !== null && end.usedUnits !== null
          ? end.usedUnits - start.usedUnits
          : null;
        if (percentDelta < -tolerance(input.provider, start.kind) || (unitsDelta !== null && unitsDelta < 0)) {
          inconsistent = true;
          continue;
        }
        const sameLimit = start.limitUnits === end.limitUnits && (start.limitUnits ?? 1) > 0;
        if (start.kind === "pool" && !sameLimit) limitChanged = true;
        segments.push({
          cycleId,
          startUsedPercent: start.usedPercent,
          endUsedPercent: end.usedPercent,
          deltaPercentagePoints: start.kind === "pool" && !sameLimit ? null : percentDelta,
          startUsedUnits: start.usedUnits,
          endUsedUnits: end.usedUnits,
          deltaUnits: unitsDelta,
        });
      }
    }

    const kind = points[0]!.kind;
    const startGapMs = startGaps.length ? Math.max(...startGaps) : null;
    const endGapMs = endGaps.length ? Math.max(...endGaps) : null;
    const coveredPercent = activeMs > 0 ? Math.min(100, coveredMs / activeMs * 100) : 0;

    if (!segments.length) {
      resources.push({
        id,
        kind,
        unit: points[0]!.unit,
        deltaPercentagePoints: null,
        deltaUnits: null,
        cycleCount: 0,
        measurable: false,
        limitChanged,
        confidence: "insufficient",
        reason: awaitingSnapshot
          ? "Waiting for the first snapshot after this session's last activity."
          : unresolved
            ? "Quota observations do not resolve both sides of this session."
            : "No quota observations cover this session.",
        episodes: [],
      });
      continue;
    }

    panelStartGaps.push(...startGaps);
    panelEndGaps.push(...endGaps);
    bestCoveredPercent = Math.max(bestCoveredPercent, coveredPercent);
    const percentSegments = segments.map((segment) => segment.deltaPercentagePoints).filter((value): value is number => value !== null);
    const unitSegments = segments.map((segment) => segment.deltaUnits).filter((value): value is number => value !== null);
    const deltaPercentagePoints = percentSegments.length === segments.length
      ? percentSegments.reduce((sum, value) => sum + value, 0)
      : null;
    const deltaUnits = unitSegments.length === segments.length
      ? unitSegments.reduce((sum, value) => sum + value, 0)
      : null;
    resources.push({
      id,
      kind,
      unit: points[0]!.unit,
      deltaPercentagePoints,
      deltaUnits,
      cycleCount: new Set(segments.map((segment) => segment.cycleId)).size,
      measurable: (deltaPercentagePoints ?? 0) > tolerance(input.provider, kind) || (deltaUnits ?? 0) > 0,
      limitChanged,
      confidence: confidenceFor({ basis: input.basis, coveredPercent, startGapMs, endGapMs, cadenceMs }),
      // A resource that resolved some episodes but not others still carries a caveat; it just
      // no longer silences the resources beside it. A running session's open end is the
      // common case, so it gets named rather than folded into the generic boundary text.
      reason: awaitingSnapshot
        ? "The reading closes at the last snapshot; this session is still running."
        : unresolved
          ? "Part of the session crosses an unresolved quota cycle boundary."
          : null,
      episodes: segments,
    });
  }

  const resolved = resources.filter((resource) => resource.episodes.length > 0);
  const startGapMs = panelStartGaps.length ? Math.max(...panelStartGaps) : null;
  const endGapMs = panelEndGaps.length ? Math.max(...panelEndGaps) : null;
  const historyReachesSession = input.basis === "embedded_account_observation"
    ? input.points.length > 0
    : input.earliestObservationAt !== null && input.episodes.length > 0
      && input.earliestObservationAt <= Math.min(...input.episodes.map((episode) => episode.startAt));

  let confidence: Confidence = resolved.reduce<Confidence>(
    (best, resource) => CONFIDENCE_RANK[resource.confidence] > CONFIDENCE_RANK[best] ? resource.confidence : best,
    "insufficient",
  );
  let reason = input.initialReason ?? null;
  if (!resolved.length && !reason) reason = resources[0]?.reason ?? null;

  if (!historyReachesSession && input.basis === "bracketed_account_delta") {
    confidence = "insufficient";
    reason = reason ?? "Retained quota history does not reach this session.";
  }
  if (inconsistent) {
    confidence = "insufficient";
    reason = "The account counter decreased inside one quota cycle.";
  }

  return {
    provider: input.provider,
    basis: input.basis,
    resources: inconsistent ? resources.map((resource) => ({ ...resource, deltaPercentagePoints: null, deltaUnits: null })) : resources,
    concurrency: concurrencyOf(input),
    coverage: {
      startGapMs,
      endGapMs,
      activeDurationCoveredPercent: bestCoveredPercent,
      snapshotCount: snapshotKeys.size,
      historyReachesSession,
      observationCadenceMs: cadenceMs,
    },
    confidence,
    additive: false,
    reason,
    sourceState: input.sourceState,
  };
}

const contextCache = new Map<string, SessionQuotaContext>();
export type SessionQuotaCohortMeta = {
  planId: string | null;
  planLabel: string | null;
  planSource: "provider" | "configured" | "unknown";
  effectiveFrom: number | null;
  poolLimit: number | null;
  cadence: string | null;
};
const cohortMeta = new Map<string, SessionQuotaCohortMeta>();

export function getSessionQuotaCohortMeta(sessionId: string) {
  return cohortMeta.get(sessionId) ?? null;
}

function markerEpisodes(markers: QuotaLifecycleMarker[]): ActivityEpisode[] {
  if (!markers.some((marker) => marker.event === "session_start" || marker.event === "session_resume")) return [];
  return mergeActivityEpisodes(markers.map((marker) => marker.occurredAt));
}

export async function getSessionQuotaContext(sessionId: string): Promise<SessionQuotaContext | null> {
  const provider = getSessionProvider(sessionId);
  let episodes = getSessionEpisodes(sessionId);
  if (provider === "anthropic" && episodes.length) {
    const nativeSessionKey = getNativeSessionKey(sessionId);
    if (nativeSessionKey) {
      const markers = await collectQuotaLifecycleMarkers(
        Math.max(0, episodes[0]!.startAt - 24 * 60 * 60_000),
        episodes.at(-1)!.endAt + 24 * 60 * 60_000,
      );
      const refined = markerEpisodes(markers.markers.filter((marker) => marker.sessionId === nativeSessionKey));
      if (refined.length) episodes = refined;
    }
  }
  if (!provider || !episodes.length) {
    const indexingDisabled = !getEffortMeta().enabled && !sessionId.startsWith("warp-");
    if (!provider) return null;
    return calculateSessionQuotaContext({
      sessionId,
      provider,
      basis: provider === "codex" ? "embedded_account_observation" : "bracketed_account_delta",
      episodes,
      points: [],
      otherSessions: [],
      earliestObservationAt: null,
      sourceState: "disabled",
      initialReason: indexingDisabled ? "Local transcript indexing is disabled." : "No eligible local activity events were recorded.",
    });
  }
  const from = Math.min(...episodes.map((episode) => episode.startAt));
  const to = Math.max(...episodes.map((episode) => episode.endAt));
  const otherSessions = getEpisodesOverlapping(from, to);
  if (provider === "codex") {
    const embedded = getEmbeddedQuotaObservations(sessionId);
    const points: ResourcePoint[] = embedded.map((row) => ({
      id: row.resourceId,
      kind: "window",
      observedAt: row.observedAt,
      usedPercent: row.usedPercent,
      usedUnits: null,
      limitUnits: null,
      cycleId: row.cycleId,
      unit: "percentage_points",
    }));
    const plan = [...embedded].reverse().find((row) => row.planId)?.planId ?? null;
    cohortMeta.set(sessionId, {
      planId: plan,
      planLabel: plan,
      planSource: plan ? "provider" : "unknown",
      effectiveFrom: null,
      poolLimit: null,
      cadence: null,
    });
    return calculateSessionQuotaContext({
      sessionId, provider, basis: "embedded_account_observation", episodes, points,
      otherSessions, earliestObservationAt: points[0]?.observedAt ?? null,
      sourceState: points.length ? "connected" : "disabled",
      initialReason: points.length ? null : "This transcript has no embedded account quota observations.",
    });
  }

  const pages = await Promise.all(episodes.map((episode) => collectRawQuotaHistory(
    provider,
    Math.max(0, episode.startAt - 24 * 60 * 60_000),
    episode.endAt + 24 * 60 * 60_000,
  )));
  const observations = [...new Map(pages.flatMap((page) => page.observations).map((row) => [
    `${row.observedAt}:${JSON.stringify(row.quota)}`,
    row,
  ])).values()].sort((a, b) => a.observedAt - b.observedAt);
  const points = pointsFromHistory(observations);
  const metaObservation = [...observations].reverse().find((row) => row.plan.id !== null)
    ?? observations.at(-1)
    ?? null;
  cohortMeta.set(sessionId, {
    planId: metaObservation?.plan.id ?? null,
    planLabel: metaObservation?.plan.label ?? null,
    planSource: metaObservation?.plan.source ?? "unknown",
    effectiveFrom: metaObservation?.plan.effectiveFrom ?? null,
    poolLimit: metaObservation?.quota.kind === "pool" ? metaObservation.quota.pool.limitUnits : null,
    cadence: metaObservation?.quota.kind === "pool" ? metaObservation.quota.pool.cadence : null,
  });
  const sourceState = pages.some((page) => page.sourceState === "connected")
    ? pages.some((page) => page.error) ? "degraded" as const : "connected" as const
    : pages.some((page) => page.sourceState === "history_only")
      ? "history_only" as const
      : pages.some((page) => page.sourceState === "degraded")
        ? "degraded" as const
        : "unreachable" as const;
  const version = pages.map((page) => page.historyVersion).join(",");
  const cacheKey = `${sessionId}:${version}:${sourceState}:${episodes.map((episode) => `${episode.startAt}-${episode.endAt}`).join(",")}`;
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;
  const result = calculateSessionQuotaContext({
    sessionId,
    provider,
    basis: "bracketed_account_delta",
    episodes,
    points,
    otherSessions,
    earliestObservationAt: pages.map((page) => page.earliestObservationAt).filter((value): value is number => value !== null).sort((a, b) => a - b)[0] ?? null,
    sourceState,
    initialReason: points.length ? null : "Quota history is unavailable for this session.",
  });
  contextCache.set(cacheKey, result);
  return result;
}
