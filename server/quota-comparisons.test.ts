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

function context(provider: "codex" | "warp"): SessionQuotaContext {
  const warp = provider === "warp";
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
      episodes: [],
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
    context: context(provider),
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
