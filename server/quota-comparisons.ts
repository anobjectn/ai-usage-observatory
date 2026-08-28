import type { Session, SessionQuotaContext } from "../src/types";
import { getSessionEpisodes, listEvidenceSessionIds } from "./session-evidence";
import {
  getSessionQuotaCohortMeta,
  getSessionQuotaContext,
  type SessionQuotaCohortMeta,
} from "./session-quota-context";

export const QUOTA_COMPARISON_SAMPLE_FLOOR = 5;

export type AllowanceComparisonSample = {
  session: Session;
  context: SessionQuotaContext;
  meta: SessionQuotaCohortMeta;
  activeMinutes: number;
};

export type AllowanceComparisonCohort = {
  provider: "anthropic" | "codex" | "warp";
  plan: { id: string; label: string; source: "provider" | "configured" };
  resource: string;
  poolLimit: number | null;
  cadence: string | null;
  sampleSize: number;
  resolvedCycles: number;
  confidence: { high: number; medium: number };
  coveragePercent: number;
  metrics: {
    apiEquivalentUsdPer100PercentagePoints: number | null;
    outputTokensPer100PercentagePoints: number | null;
    activeMinutesPer100PercentagePoints: number | null;
    warpManagedTokensPer100Credits: number | null;
    activeMinutesPer100Credits: number | null;
    sessionsPerResolvedCycle: number;
    observedCredits: number | null;
    observedPercentagePoints: number | null;
  };
};

export type AllowanceComparisonReport = {
  basis: "observed_account_and_workload";
  generatedAt: number;
  sampleFloor: number;
  eligibleSamples: number;
  excluded: { unknownTier: number; confidence: number; unresolved: number; zeroMovement: number };
  cohorts: AllowanceComparisonCohort[];
  crossProviderRatios: never[];
  note: string;
};

function cohortKey(sample: AllowanceComparisonSample, resource: SessionQuotaContext["resources"][number]) {
  return [
    sample.context.provider,
    sample.meta.planId,
    sample.meta.planSource,
    sample.meta.effectiveFrom ?? "provider",
    resource.id,
    sample.meta.poolLimit ?? "window",
    sample.meta.cadence ?? "rolling",
  ].join("\0");
}

export function buildAllowanceComparisonReport(
  samples: AllowanceComparisonSample[],
  sampleFloor = QUOTA_COMPARISON_SAMPLE_FLOOR,
): AllowanceComparisonReport {
  const excluded = { unknownTier: 0, confidence: 0, unresolved: 0, zeroMovement: 0 };
  const groups = new Map<string, Array<{ sample: AllowanceComparisonSample; resource: SessionQuotaContext["resources"][number] }>>();
  let eligibleSamples = 0;
  for (const sample of samples) {
    if (!sample.meta.planId || sample.meta.planSource === "unknown") {
      excluded.unknownTier++;
      continue;
    }
    if (sample.context.confidence !== "high" && sample.context.confidence !== "medium") {
      excluded.confidence++;
      continue;
    }
    if (!sample.context.coverage.historyReachesSession || sample.context.resources.length === 0) {
      excluded.unresolved++;
      continue;
    }
    let accepted = false;
    for (const resource of sample.context.resources) {
      const denominator = sample.context.provider === "warp" ? resource.deltaUnits : resource.deltaPercentagePoints;
      if (denominator === null || denominator <= 0) {
        excluded.zeroMovement++;
        continue;
      }
      const key = cohortKey(sample, resource);
      const values = groups.get(key) ?? [];
      values.push({ sample, resource });
      groups.set(key, values);
      accepted = true;
    }
    if (accepted) eligibleSamples++;
  }

  const cohorts = [...groups.values()].flatMap((values): AllowanceComparisonCohort[] => {
    if (values.length < sampleFloor) return [];
    const first = values[0]!;
    const provider = first.sample.context.provider;
    const totalPp = values.reduce((sum, value) => sum + (value.resource.deltaPercentagePoints ?? 0), 0);
    const totalCredits = values.reduce((sum, value) => sum + (value.resource.deltaUnits ?? 0), 0);
    const totalActive = values.reduce((sum, value) => sum + value.sample.activeMinutes, 0);
    const totalOutput = values.reduce((sum, value) => sum + value.sample.session.outputTokens, 0);
    const totalCost = values.reduce((sum, value) => sum + value.sample.session.totalCost, 0);
    const warpTokens = values.reduce((sum, value) => sum + (value.sample.session.warp?.tokensBySource.warp ?? 0), 0);
    const resolvedCycles = values.reduce((sum, value) => sum + value.resource.cycleCount, 0);
    const confidence = {
      high: values.filter((value) => value.sample.context.confidence === "high").length,
      medium: values.filter((value) => value.sample.context.confidence === "medium").length,
    };
    return [{
      provider,
      plan: {
        id: first.sample.meta.planId!,
        label: first.sample.meta.planLabel ?? first.sample.meta.planId!,
        source: first.sample.meta.planSource as "provider" | "configured",
      },
      resource: first.resource.id,
      poolLimit: first.sample.meta.poolLimit,
      cadence: first.sample.meta.cadence,
      sampleSize: values.length,
      resolvedCycles,
      confidence,
      coveragePercent: values.reduce((sum, value) => sum + value.sample.context.coverage.activeDurationCoveredPercent, 0) / values.length,
      metrics: {
        apiEquivalentUsdPer100PercentagePoints: provider === "warp" || totalPp <= 0 ? null : totalCost / totalPp * 100,
        outputTokensPer100PercentagePoints: provider === "warp" || totalPp <= 0 ? null : totalOutput / totalPp * 100,
        activeMinutesPer100PercentagePoints: provider === "warp" || totalPp <= 0 ? null : totalActive / totalPp * 100,
        warpManagedTokensPer100Credits: provider !== "warp" || totalCredits <= 0 ? null : warpTokens / totalCredits * 100,
        activeMinutesPer100Credits: provider !== "warp" || totalCredits <= 0 ? null : totalActive / totalCredits * 100,
        sessionsPerResolvedCycle: resolvedCycles > 0 ? values.length / resolvedCycles : 0,
        observedCredits: provider === "warp" ? totalCredits : null,
        observedPercentagePoints: totalPp > 0 ? totalPp : null,
      },
    }];
  });

  return {
    basis: "observed_account_and_workload",
    generatedAt: Date.now(),
    sampleFloor,
    eligibleSamples,
    excluded,
    cohorts,
    crossProviderRatios: [],
    note: "Observed on this account and workload. Provider plans and quota units are not equivalent.",
  };
}

export async function collectAllowanceComparisonReport(sessions: Session[]) {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const samples = (await Promise.all(listEvidenceSessionIds().map(async (sessionId) => {
    const session = byId.get(sessionId);
    if (!session) return null;
    const context = await getSessionQuotaContext(sessionId);
    const meta = getSessionQuotaCohortMeta(sessionId);
    if (!context || !meta) return null;
    const activeMinutes = getSessionEpisodes(sessionId)
      .reduce((sum, episode) => sum + Math.max(0, episode.endAt - episode.startAt), 0) / 60_000;
    return { session, context, meta, activeMinutes };
  }))).filter(Boolean) as AllowanceComparisonSample[];
  return buildAllowanceComparisonReport(samples);
}
