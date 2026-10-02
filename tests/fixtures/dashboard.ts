import type { DashboardData, Session } from "../../src/types";

export function dashboardFixture(): DashboardData {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const session: Session = {
    sessionId: "fixture-session", agent: "codex", period: "fixture-session",
    cwd: "/fixture/project", pathTags: [], annotation: { tags: [], note: "", verdict: null },
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 150, totalCost: 0.001, modelsUsed: ["gpt-fixture"],
    modelBreakdowns: [{ modelName: "gpt-fixture", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.001 }],
    metadata: { lastActivity: now },
  };
  const daily = { ...session, period: day };
  return {
    collectedAt: now, timeZone: "UTC", ccusageVersion: "fixture", apiPort: 0,
    costMethodology: "ccusage", blockScope: "Claude Code",
    daily: [daily], weekly: [daily], monthly: [daily], totals: daily, sessions: [session],
    projectActivity: [], projects: [], models: [], blocks: [], unpricedModels: [],
    rateCard: { status: "fallback", fetchedAt: null, models: {} },
    quotas: { available: false, collectedAt: now, sourceState: "disabled", history: {
      available: false, trackingSince: null, windows: [], series: [], codexBankedResets: { usedCount: 0, used: [] },
    } },
    warp: {
      available: false, observedAt: now, sourceFile: null, error: "Fixture has no Warp ledger",
      sessionCount: 0, queryCount: 0, linkedQueryCount: 0, queryCoverage: 0, daily: [],
      schema: { required: [], missing: [] },
      totals: { sessions: 0, credits: 0, tokens: 0 },
    },
    rules: [], settings: { monthlyBudget: "250" }, sources: [],
    refresh: { inProgress: false, lastError: null, stale: false },
  };
}
