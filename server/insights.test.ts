import { describe, expect, test } from "bun:test";
import type { DashboardData, Session } from "../src/types";
import { buildInsights, contextEstimate, resolveScope } from "./insights";
import { summarizeQuotaHistory } from "./quota";

describe("insights scope", () => {
  test("clamps the analysis window and keeps unsupported filters harmless", () => {
    expect(resolveScope(new URLSearchParams("range=500&provider=other&outliers=wat&finding=nope"))).toEqual({ rangeDays: 120, provider: "all", pathTag: "all", cache: "include", outliers: "all", modelFamily: "all", finding: "all" });
  });
  test("accepts the model-family and finding facets", () => {
    expect(resolveScope(new URLSearchParams("modelFamily=claude-opus-5&finding=missed-clear"))).toMatchObject({ modelFamily: "claude-opus-5", finding: "missed-clear" });
  });
});

describe("context estimates", () => {
  test("inverts linear context growth into a turn count", () => {
    // 20 turns whose context grows 0 -> 100K averages 50K per read: 20 x 50K = 1M read, 100K written.
    expect(contextEstimate({ cacheReadTokens: 1_000_000, cacheCreationTokens: 100_000 })).toEqual({ turns: 20, contextWritten: 100_000 });
  });
  test("reports unavailable rather than zero when the provider omits cache writes", () => {
    expect(contextEstimate({ cacheReadTokens: 5_000_000, cacheCreationTokens: 0 })).toEqual({ turns: null, contextWritten: null });
  });
});

function session(id: string, agent: string, model: string, buckets: Partial<Session>): Session {
  const row = { inputTokens: 1_000, outputTokens: 10_000, cacheReadTokens: 500_000, cacheCreationTokens: 50_000, ...buckets };
  return {
    agent, period: "2026-07-20", sessionId: id, cwd: "/Users/x/demo", pathTags: [], annotation: { tags: [], note: "" },
    inputTokens: row.inputTokens!, outputTokens: row.outputTokens!, cacheReadTokens: row.cacheReadTokens!, cacheCreationTokens: row.cacheCreationTokens!,
    totalTokens: row.inputTokens! + row.outputTokens! + row.cacheReadTokens! + row.cacheCreationTokens!,
    totalCost: 1, modelsUsed: [model],
    modelBreakdowns: [{ modelName: model, inputTokens: row.inputTokens!, outputTokens: row.outputTokens!, cacheReadTokens: row.cacheReadTokens!, cacheCreationTokens: row.cacheCreationTokens!, cost: 1 }],
    metadata: { lastActivity: new Date().toISOString() },
  };
}
const dashboard = (sessions: Session[]): DashboardData => ({ ...({} as DashboardData), sessions, models: [], unpricedModels: [], quotas: { available: false, collectedAt: "" } });

describe("efficiency findings", () => {
  const baseline = Array.from({ length: 8 }, (_, index) => session(`typical-${index}`, "claude", "claude-opus-5", {}));

  test("flags a thread whose context carry far exceeds its cohort median", () => {
    const rows = [...baseline, session("heavy", "claude", "claude-opus-5", { outputTokens: 10_000, cacheReadTokens: 40_000_000, cacheCreationTokens: 400_000 })];
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams()));
    const split = insights.efficiency.findings.filter((finding) => finding.ruleId === "split-session");
    expect(split.map((finding) => finding.sessionId)).toEqual(["heavy"]);
    expect(split[0].recoverable).toBeGreaterThan(0);
  });

  test("flags context written beyond a single window and reports estimated turns", () => {
    const rows = [...baseline, session("long", "claude", "claude-opus-5", { cacheCreationTokens: 600_000, cacheReadTokens: 30_000_000 })];
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams()));
    const missed = insights.efficiency.findings.find((finding) => finding.ruleId === "missed-clear");
    expect(missed?.sessionId).toBe("long");
    expect(missed?.metrics.find((metric) => metric.label === "Est. turns")?.value).toBe("100");
  });

  test("reports Codex cache writes as unavailable rather than zero", () => {
    const rows = Array.from({ length: 8 }, (_, index) => session(`codex-${index}`, "codex", "gpt-5.6-sol", { cacheCreationTokens: 0 }));
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams("provider=codex")));
    const codex = insights.cacheComposition.providers.find((entry) => entry.provider === "codex");
    expect(codex?.cacheWritesReported).toBe(false);
    expect(codex?.medianTurns).toBeNull();
    expect(codex?.amplification).toBeNull();
    expect(insights.efficiency.findings.some((finding) => finding.ruleId === "missed-clear")).toBe(false);
  });

  test("the finding facet narrows the list without changing the measurements", () => {
    const rows = [...baseline, session("long", "claude", "claude-opus-5", { cacheCreationTokens: 600_000, cacheReadTokens: 30_000_000 })];
    const all = buildInsights(dashboard(rows), resolveScope(new URLSearchParams()));
    const filtered = buildInsights(dashboard(rows), resolveScope(new URLSearchParams("finding=missed-clear")));
    expect(filtered.efficiency.findings.every((finding) => finding.ruleId === "missed-clear")).toBe(true);
    expect(filtered.efficiency.totals).toEqual(all.efficiency.totals);
    expect(filtered.volume.processed).toBe(all.volume.processed);
  });

  test("the model-family facet keeps outlier cohorts intact", () => {
    const rows = [...baseline, ...Array.from({ length: 8 }, (_, index) => session(`haiku-${index}`, "claude", "claude-haiku-4-5", {}))];
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams("modelFamily=claude-haiku-4-5")));
    expect(insights.facets.sessionsInScope).toBe(16);
    expect(insights.facets.sessionsShown).toBe(8);
    expect(insights.volume.models.map((model) => model.model)).toEqual(["claude-haiku-4-5"]);
  });
});

describe("quota percent series", () => {
  test("downsamples history by provider, window, and five-minute bucket", () => {
    const history = summarizeQuotaHistory([
      { provider:"anthropic", capturedAt:0, snapshotJson:JSON.stringify({kind:"window",fiveHour:{usedPercent:31,resetsAt:1000},weekly:{usedPercent:55,resetsAt:2000}}) },
      { provider:"anthropic", capturedAt:120_000, snapshotJson:JSON.stringify({kind:"window",fiveHour:{usedPercent:36,resetsAt:1000},weekly:{usedPercent:56,resetsAt:2000}}) },
      { provider:"anthropic", capturedAt:300_000, snapshotJson:JSON.stringify({kind:"window",fiveHour:{usedPercent:40,resetsAt:1000},weekly:{usedPercent:57,resetsAt:2000}}) },
    ], []);
    expect(history.series).toHaveLength(4);
    expect(history.series[0]).toMatchObject({ provider:"anthropic", window:"fiveHour", usedPercent:31, cycleId:"0" });
  });
});
