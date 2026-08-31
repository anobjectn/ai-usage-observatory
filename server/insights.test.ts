import { describe, expect, test } from "bun:test";
import type { DashboardData, Session } from "../src/types";
import { buildInsights, contextEstimate, resolveScope } from "./insights";
import { summarizeQuotaHistory } from "./quota";

describe("insights scope", () => {
  test("clamps the analysis window and keeps unsupported filters harmless", () => {
    expect(resolveScope(new URLSearchParams("range=500&providers=other&outliers=wat&finding=nope&policy=wat&findingPage=-3"))).toEqual({ rangeDays: 120, fromDate: null, toDate: null, providers: [], modelFamilies: [], pathTag: "all", cache: "include", outliers: "all", finding: "all", effort: "all", findingPage: 1, policy: "capture" });
  });
  test("accepts all time as an unbounded analysis window", () => {
    expect(resolveScope(new URLSearchParams("range=all"))).toMatchObject({ rangeDays: null });
  });
  test("accepts both Agent-filter grains and the finding facet", () => {
    expect(resolveScope(new URLSearchParams("providers=anthropic&modelFamilies=claude-opus-5,gpt-5.6-sol&finding=missed-clear")))
      .toMatchObject({ providers: ["anthropic"], modelFamilies: ["claude-opus-5", "gpt-5.6-sol"], finding: "missed-clear" });
  });
  test("accepts exact custom bounds", () => {
    expect(resolveScope(new URLSearchParams("range=custom&from=2026-07-01&to=2026-07-10")))
      .toMatchObject({ fromDate: "2026-07-01", toDate: "2026-07-10" });
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
    agent, period: "2026-07-20", sessionId: id, cwd: "/Users/x/demo", pathTags: [], annotation: { tags: [], note: "", verdict: null },
    inputTokens: row.inputTokens!, outputTokens: row.outputTokens!, cacheReadTokens: row.cacheReadTokens!, cacheCreationTokens: row.cacheCreationTokens!,
    totalTokens: row.inputTokens! + row.outputTokens! + row.cacheReadTokens! + row.cacheCreationTokens!,
    totalCost: 1, modelsUsed: [model],
    modelBreakdowns: [{ modelName: model, inputTokens: row.inputTokens!, outputTokens: row.outputTokens!, cacheReadTokens: row.cacheReadTokens!, cacheCreationTokens: row.cacheCreationTokens!, cost: 1 }],
    metadata: { lastActivity: new Date().toISOString() },
  };
}
const dashboard = (sessions: Session[]): DashboardData => ({ ...({} as DashboardData), sessions, models: [], unpricedModels: [], quotas: { available: false, collectedAt: "" } });

describe("allowance profiles", () => {
  test("keeps allowance profiles on the whole corpus when the time range narrows", () => {
    const recentClaude = session("recent-claude", "claude", "claude-opus-5", {});
    const historicalCodex = {
      ...session("historical-codex", "codex", "gpt-5.6-sol", { cacheCreationTokens: 0 }),
      metadata: { lastActivity: "2025-01-01T00:00:00.000Z" },
    };
    const all = buildInsights(dashboard([recentClaude, historicalCodex]), resolveScope(new URLSearchParams("range=all")));
    const recent = buildInsights(dashboard([recentClaude, historicalCodex]), resolveScope(new URLSearchParams("range=1")));

    expect(recent.profiles).toEqual(all.profiles);
    expect(recent.profiles.map((profile) => profile.id)).toEqual([
      "allowance-capture-anthropic",
      "allowance-capture-codex",
    ]);
    expect(
      recent.profiles.map((profile) => profile.components.find((component) => component.id === "headroom")?.evidence.sessions),
    ).toEqual([1, 1]);
    expect(recent.volume.providers.map((entry) => entry.provider)).toEqual(["anthropic"]);
  });
});

describe("custom date scope", () => {
  test("includes both endpoints and excludes sessions outside them", () => {
    const first = { ...session("first", "claude", "claude-opus-5", {}), metadata: { lastActivity: "2026-07-01T12:00:00.000Z" } };
    const last = { ...session("last", "claude", "claude-opus-5", {}), metadata: { lastActivity: "2026-07-10T12:00:00.000Z" } };
    const outside = { ...session("outside", "claude", "claude-opus-5", {}), metadata: { lastActivity: "2026-07-11T12:00:00.000Z" } };
    const insights = buildInsights(
      dashboard([first, last, outside]),
      resolveScope(new URLSearchParams("range=custom&from=2026-07-01&to=2026-07-10")),
    );
    expect(insights.facets.sessionsInScope).toBe(2);
  });
});

describe("efficiency findings", () => {
  const baseline = Array.from({ length: 8 }, (_, index) => session(`typical-${index}`, "claude", "claude-opus-5", {}));

  test("flags a thread whose context carry far exceeds its cohort median", () => {
    const rows = [...baseline, session("heavy", "claude", "claude-opus-5", { outputTokens: 10_000, cacheReadTokens: 40_000_000, cacheCreationTokens: 400_000 })];
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams()));
    const flagged = insights.efficiency.groups.filter((group) => group.findings.some((finding) => finding.ruleId === "split-session"));
    expect(flagged.map((group) => group.sessionId)).toEqual(["heavy"]);
    expect(flagged[0].recoverable).toBeGreaterThan(0);
  });

  test("flags context written beyond a single window and reports estimated turns", () => {
    const rows = [...baseline, session("long", "claude", "claude-opus-5", { cacheCreationTokens: 600_000, cacheReadTokens: 30_000_000 })];
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams()));
    const flagged = insights.efficiency.groups.find((group) => group.findings.some((finding) => finding.ruleId === "missed-clear"));
    expect(flagged?.sessionId).toBe("long");
    const missed = flagged?.findings.find((finding) => finding.ruleId === "missed-clear");
    expect(missed?.metrics.find((metric) => metric.label === "Est. turns")?.value).toBe("100");
  });

  test("reports Codex cache writes as unavailable rather than zero", () => {
    const rows = Array.from({ length: 8 }, (_, index) => session(`codex-${index}`, "codex", "gpt-5.6-sol", { cacheCreationTokens: 0 }));
    const insights = buildInsights(dashboard(rows), resolveScope(new URLSearchParams("provider=codex")));
    const codex = insights.cacheComposition.providers.find((entry) => entry.provider === "codex");
    expect(codex?.cacheWritesReported).toBe(false);
    expect(codex?.medianTurns).toBeNull();
    expect(codex?.amplification).toBeNull();
    expect(insights.efficiency.groups.some((group) => group.findings.some((finding) => finding.ruleId === "missed-clear"))).toBe(false);
  });

  test("the finding facet narrows the list without changing the measurements", () => {
    const rows = [...baseline, session("long", "claude", "claude-opus-5", { cacheCreationTokens: 600_000, cacheReadTokens: 30_000_000 })];
    const all = buildInsights(dashboard(rows), resolveScope(new URLSearchParams()));
    const filtered = buildInsights(dashboard(rows), resolveScope(new URLSearchParams("finding=missed-clear")));
    expect(filtered.efficiency.groups.every((group) => group.findings.every((finding) => finding.ruleId === "missed-clear"))).toBe(true);
    expect(filtered.efficiency.totals).toEqual(all.efficiency.totals);
    expect(filtered.volume.processed).toBe(all.volume.processed);
  });

  // The model grain now scopes like the provider grain does — it narrows before outlier detection
  // rather than after. Cohorts are keyed by family already, so the selected family's cohort is
  // still evaluated whole and its z-scores are unchanged; only unrelated cohorts disappear.
  test("the model-family grain of the Agent filter leaves that family's cohort whole", () => {
    const rows = [...baseline, ...Array.from({ length: 8 }, (_, index) => session(`haiku-${index}`, "claude", "claude-haiku-4-5", {}))];
    const scoped = buildInsights(dashboard(rows), resolveScope(new URLSearchParams("modelFamilies=claude-haiku-4-5")));
    expect(scoped.facets.sessionsInScope).toBe(8);
    expect(scoped.facets.sessionsShown).toBe(8);
    expect(scoped.volume.models.map((model) => model.model)).toEqual(["claude-haiku-4-5"]);
    // Eight is exactly the cohort minimum, so the family is tested rather than skipped as too small.
    expect(scoped.outliers.cohortsEvaluated).toBe(1);
    expect(scoped.outliers.cohortsSkipped).toBe(0);
  });

  test("both Agent-filter grains are unioned rather than intersected", () => {
    const rows = [
      ...baseline,
      ...Array.from({ length: 3 }, (_, index) => session(`codex-${index}`, "codex", "gpt-5.6-sol", { cacheCreationTokens: 0 })),
      ...Array.from({ length: 2 }, (_, index) => session(`terra-${index}`, "codex", "gpt-5.6-terra", { cacheCreationTokens: 0 })),
    ];
    // "Everything Claude, plus gpt-5.6-sol" — not the empty set of Claude sessions running a Codex model.
    const scope = resolveScope(new URLSearchParams("providers=anthropic&modelFamilies=gpt-5.6-sol"));
    const insights = buildInsights(dashboard(rows), scope);
    expect(insights.facets.sessionsInScope).toBe(11);
    expect(insights.volume.models.map((model) => model.model).sort()).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
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
