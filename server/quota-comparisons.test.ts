import { expect, test } from "bun:test";
import type { Session, SessionQuotaContext } from "../src/types";
import { buildAllowanceComparisonReport, type AllowanceComparisonSample } from "./quota-comparisons";

function session(provider: "codex" | "warp", index: number): Session {
  return {
    agent: provider,
    source: provider === "warp" ? "warp" : "ccusage",
    sessionId: `${provider}-${index}`,
    period: "2026-08-01",
    cwd: null,
    pathTags: [],
    annotation: { tags: [], note: "", verdict: null },
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 120,
    totalCost: 2,
    modelsUsed: ["model"],
    modelBreakdowns: [{ modelName: "model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 2 }],
    ...(provider === "warp" ? {
      warp: {
        conversationId: String(index), credits: 5, lastTurnCredits: null, contextWindowUsage: null,
        wasSummarized: false, status: "completed", turns: 1, tasks: 0, blockCount: 0,
        failedCommands: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0, commandsExecuted: 0,
        toolUsage: {}, tokensBySource: { total: 1_000, warp: 400, byok: 300, customEndpoint: 300 }, tokensByCategory: {},
      },
    } : {}),
  };
}

function context(provider: "codex" | "warp", index = 0): SessionQuotaContext {
  const warp = provider === "warp";
  // Each sample moves its own quota cycle: independent sessions whose movement must sum.
  const cycleId = `reset:${provider}-${index}`;
  return {
    provider,
    basis: warp ? "bracketed_account_delta" : "embedded_account_observation",
    resources: [{
      id: warp ? "monthly" : "fiveHour",
      kind: warp ? "pool" : "window",
      unit: warp ? "warp_credit" : "percentage_points",
      deltaPercentagePoints: 10,
      deltaUnits: warp ? 5 : null,
      cycleCount: 1,
      measurable: true,
      limitChanged: false,
      confidence: "high",
      reason: null,
      endUsedPercent: 50,
      endUsedUnits: warp ? 105 : null,
      limitUnits: warp ? 1_500 : null,
      endObservedAt: 0,
      endCycleId: cycleId,
      endGapMs: 0,
      episodes: [{
        cycleId,
        startUsedPercent: 40,
        endUsedPercent: 50,
        deltaPercentagePoints: 10,
        startUsedUnits: warp ? 100 : null,
        endUsedUnits: warp ? 105 : null,
        deltaUnits: warp ? 5 : null,
      }],
    }],
    concurrency: {
      distinctOtherSameProviderSessions: 0, maxOtherSameProviderSessions: 0,
      distinctOtherProviderSessions: 0, maxOtherProviderSessions: 0, externalActivity: "unknown",
    },
    coverage: { startGapMs: 0, endGapMs: 0, activeDurationCoveredPercent: 100, snapshotCount: 2, historyReachesSession: true, observationCadenceMs: 60_000 },
    confidence: "high",
    additive: false,
    reason: null,
    sourceState: "connected",
  };
}

function sample(provider: "codex" | "warp", index: number): AllowanceComparisonSample {
  return {
    session: session(provider, index),
    context: context(provider, index),
    meta: {
      planId: provider === "warp" ? "warp-pro" : "plus",
      planLabel: provider === "warp" ? "Warp Pro" : "Codex Plus",
      planSource: provider === "warp" ? "configured" : "provider",
      effectiveFrom: provider === "warp" ? 100 : null,
      poolLimit: provider === "warp" ? 1_500 : null,
      cadence: provider === "warp" ? "Monthly" : null,
    },
    activeMinutes: 10,
  };
}

test("allowance comparisons partition cohorts and never invent cross-provider ratios", () => {
  const report = buildAllowanceComparisonReport([
    ...Array.from({ length: 5 }, (_, index) => sample("codex", index)),
    ...Array.from({ length: 5 }, (_, index) => sample("warp", index)),
  ]);
  expect(report.cohorts).toHaveLength(2);
  expect(report.crossProviderRatios).toEqual([]);
  const codex = report.cohorts.find((cohort) => cohort.provider === "codex")!;
  expect(codex.plan).toEqual({ id: "plus", label: "Codex Plus", source: "provider" });
  expect(codex.metrics.outputTokensPer100PercentagePoints).toBe(200);
  expect(codex.metrics.warpManagedTokensPer100Credits).toBeNull();
  const warp = report.cohorts.find((cohort) => cohort.provider === "warp")!;
  expect(warp).toMatchObject({ poolLimit: 1_500, cadence: "Monthly" });
  expect(warp.metrics.warpManagedTokensPer100Credits).toBe(8_000);
  expect(warp.metrics.apiEquivalentUsdPer100PercentagePoints).toBeNull();
  expect(report.note).toContain("not equivalent");
});

test("allowance comparisons reject unknown tiers and under-sized cohorts", () => {
  const unknown = sample("codex", 1);
  unknown.meta = { ...unknown.meta, planId: null, planSource: "unknown" };
  const report = buildAllowanceComparisonReport([unknown, ...Array.from({ length: 4 }, (_, index) => sample("codex", index + 2))]);
  expect(report.excluded.unknownTier).toBe(1);
  expect(report.cohorts).toEqual([]);
});

test("overlapping sessions in one quota cycle contribute the cycle's union of movement, not the sum", () => {
  const shared = (episodes: Array<[number, number]>, index: number) => {
    const value = sample("codex", index);
    value.context.resources[0]!.episodes = episodes.map(([startUsedPercent, endUsedPercent]) => ({
      cycleId: "reset:shared",
      startUsedPercent,
      endUsedPercent,
      deltaPercentagePoints: endUsedPercent - startUsedPercent,
      startUsedUnits: null,
      endUsedUnits: null,
      deltaUnits: null,
    }));
    value.context.resources[0]!.deltaPercentagePoints = episodes
      .reduce((sum, [startUsedPercent, endUsedPercent]) => sum + endUsedPercent - startUsedPercent, 0);
    value.context.concurrency.maxOtherSameProviderSessions = 1;
    return value;
  };
  // The observed contradiction: two concurrent sessions claimed 23pp and 20pp of one
  // five-hour window whose counter only moved 0 -> 28.
  const report = buildAllowanceComparisonReport([
    shared([[0, 12], [14, 25]], 0),
    shared([[6, 10], [12, 28]], 1),
    ...Array.from({ length: 3 }, (_, index) => sample("codex", index + 2)),
  ]);
  const cohort = report.cohorts[0]!;
  // 28 from the shared cycle's union plus 10 from each of the three solo cycles.
  expect(cohort.metrics.observedPercentagePoints).toBe(58);
  expect(cohort.resolvedCycles).toBe(4);
  expect(cohort.overlappedSamples).toBe(2);
  expect(cohort.sampleSize).toBe(5);
  expect(report.note).toContain("de-duplicated per quota cycle");
});

test("synthetic cycle ids never merge across sessions", () => {
  const values = Array.from({ length: 5 }, (_, index) => {
    const value = sample("codex", index);
    value.context.resources[0]!.episodes = [{
      cycleId: "idle:0",
      startUsedPercent: 0,
      endUsedPercent: 10,
      deltaPercentagePoints: 10,
      startUsedUnits: null,
      endUsedUnits: null,
      deltaUnits: null,
    }];
    return value;
  });
  const report = buildAllowanceComparisonReport(values);
  // Five sessions, five per-session cycles: without a reset instant the cycles cannot be
  // proven shared, so each keeps its own movement.
  expect(report.cohorts[0]!.metrics.observedPercentagePoints).toBe(50);
  expect(report.cohorts[0]!.resolvedCycles).toBe(5);
});
