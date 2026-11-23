import type { DashboardData, MetricRow, Session } from "../../src/types";

/** One Gemini 4 Neon (High) conversation as the collector builds it: ccusage's session (tokens,
 * cost, the conversation id as `period`) joined with the metadata reader's cwd and stats. Output
 * already holds the 640 thinking tokens ccusage reports only in its total. */
export function antigravitySessionFixture(lastActivity = new Date(Date.now() - 2 * 3_600_000).toISOString()): Session {
  return {
    sessionId: "antigravity-fixture-conversation", agent: "antigravity", source: "antigravity", period: "fixture-conversation",
    cwd: "/fixture/gemini-project", pathTags: [], annotation: { tags: [], note: "", verdict: null },
    inputTokens: 4_000, outputTokens: 900, cacheReadTokens: 60_000, cacheCreationTokens: 0,
    totalTokens: 64_900, totalCost: 0.0345, modelsUsed: ["gemini-4-neon"],
    modelBreakdowns: [{ modelName: "gemini-4-neon", inputTokens: 4_000, outputTokens: 900, cacheReadTokens: 60_000, cacheCreationTokens: 0, cost: 0.0345 }],
    metadata: { lastActivity },
    antigravity: { conversationId: "fixture-conversation", generations: 12, reasoningOutputTokens: 640, parentConversationId: null, root: "t3" },
    activityIntervals: [],
  };
}

/** A Warp conversation that ran Gemini: Warp's session, with its Gemini listed under Google. */
export function warpGeminiSessionFixture(lastActivity = new Date(Date.now() - 3 * 3_600_000).toISOString()): Session {
  return {
    sessionId: "warp-fixture-gemini", agent: "warp", source: "warp", period: lastActivity,
    cwd: "/fixture/warp-project", pathTags: [], annotation: { tags: [], note: "", verdict: null },
    inputTokens: 2_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 2_000, totalCost: 0, modelsUsed: ["gemini-3-flash"],
    modelBreakdowns: [{ modelName: "gemini-3-flash", inputTokens: 2_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 }],
    metadata: { lastActivity },
    warp: {
      conversationId: "fixture-gemini", credits: 1.5, lastTurnCredits: null, contextWindowUsage: null, wasSummarized: false,
      status: "done", turns: 1, tasks: 1, blockCount: 0, failedCommands: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0,
      commandsExecuted: 0, toolUsage: {}, tokensBySource: { total: 2_000, warp: 2_000, byok: 0, customEndpoint: 0 }, tokensByCategory: {},
    },
    activityIntervals: [],
  };
}

/** quota-service's Antigravity report: two primary windows and three model windows on Google AI Pro. */
export function antigravityQuotaFixture(includeAntigravity = true): DashboardData["quotas"] {
  const now = Date.now();
  const reset = now + 3 * 3_600_000;
  const weekly = now + 5 * 86_400_000;
  return {
    available: true, collectedAt: new Date(now).toISOString(), sourceState: "connected",
    usage: { generatedAt: now, providers: includeAntigravity ? [{
      provider: "antigravity", status: "ok", source: "antigravity_local", dataAgeMs: 4_000,
      snapshot: {
        kind: "window",
        fiveHour: { usedPercent: 28.5, resetsAt: reset },
        weekly: { usedPercent: 39.6, resetsAt: weekly },
        modelWindows: {
          "Claude and GPT models (weekly)": { usedPercent: 0, resetsAt: weekly },
          "Claude and GPT models (5h)": { usedPercent: 0, resetsAt: reset },
          "Gemini 4 Argon Weekly Limit": { usedPercent: 12, resetsAt: weekly },
        },
        extra: {
          planType: "pro", rawPlanName: "Google AI Pro",
          modelWindowIdentity: {
            "Claude and GPT models (weekly)": { model: null, family: null },
            "Claude and GPT models (5h)": { model: null, family: null },
            "Gemini 4 Argon Weekly Limit": { model: "gemini-4-argon", family: "gemini" },
          },
        },
      },
    }] : [] },
    history: includeAntigravity ? antigravityQuotaHistory(now) : { available: false, trackingSince: null, windows: [], series: [], codexBankedResets: { usedCount: 0, used: [] } },
  };
}

/** The UTC calendar days ending today, oldest first: the periods the activity chart fixture draws. */
export function fixtureDays(count: number, now = Date.now()) {
  return Array.from({ length: count }, (_, index) => new Date(now - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

/** Locally observed Antigravity quota history, shaped as the dashboard serves it: per UTC day the
 * weekly close and the five-hour peak, plus one five-hour reach yesterday. Only the primary
 * windows ever appear here; model windows stay on the quota card. */
export function antigravityQuotaHistory(now = Date.now()): NonNullable<DashboardData["quotas"]["history"]> {
  const days = fixtureDays(4, now);
  const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);
  const weeklyUsed = [12, 21.5, 30.2, 39.6];
  const fiveHourUsed = [35, 62.5, 100, 28.5];
  const reachedAt = noon(days[2]!) + 3_600_000;
  return {
    available: true,
    trackingSince: noon(days[0]!) - 86_400_000,
    windows: [
      { provider: "antigravity", window: "fiveHour", reachedCount: 1, lastReachedAt: reachedAt, reachedAt: [reachedAt] },
      { provider: "antigravity", window: "weekly", reachedCount: 0, lastReachedAt: null, reachedAt: [] },
    ],
    series: days.flatMap((day, index) => [
      { provider: "antigravity" as const, window: "fiveHour" as const, capturedAt: noon(day), usedPercent: fiveHourUsed[index]!, resetsAt: noon(day) + 3 * 3_600_000, cycleId: `f${index}` },
      { provider: "antigravity" as const, window: "weekly" as const, capturedAt: noon(day) + 6 * 3_600_000, usedPercent: weeklyUsed[index]!, resetsAt: now + 5 * 86_400_000, cycleId: "w" },
    ]),
    codexBankedResets: { usedCount: 0, used: [] },
  };
}

/** Daily activity rows for the activity chart: Neon on each fixture day. */
export function antigravityDailyRows(now = Date.now()): MetricRow[] {
  const session = antigravitySessionFixture(new Date(now).toISOString());
  return fixtureDays(4, now).map((day, index) => {
    const scale = index + 1;
    const breakdown = { ...session.modelBreakdowns[0]!, inputTokens: 4_000 * scale, cacheReadTokens: 60_000 * scale, outputTokens: 900 * scale, cost: 0.0345 * scale };
    const row = {
      agent: "antigravity", period: day, inputTokens: breakdown.inputTokens, outputTokens: breakdown.outputTokens,
      cacheReadTokens: breakdown.cacheReadTokens, cacheCreationTokens: 0,
      totalTokens: breakdown.inputTokens + breakdown.outputTokens + breakdown.cacheReadTokens, totalCost: breakdown.cost,
      modelsUsed: ["gemini-4-neon"], modelBreakdowns: [breakdown],
    };
    return { ...row, agents: [row] };
  });
}

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
    daily: [daily], weekly: [daily], monthly: [daily], totals: daily, sessions: [session, antigravitySessionFixture(now), warpGeminiSessionFixture(now)],
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
