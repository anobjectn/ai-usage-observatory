import { describe, expect, test } from "bun:test";
import { activeBlockExpiry, aggregateProjectActivity, aggregateProjects, antigravityHealth, antigravityReconciliation, ccusageCacheUsable, joinAntigravitySessions, mergeWarp, monthKey, totalsWithWarp, weekKey } from "./collector";
import { foldAntigravityThinking } from "./ccusage";
import { sessionReportKeys, stableSessionId } from "./path-indexer";
import { blocksReportSchema, unifiedReportSchema } from "./schema";

describe("normalized ingestion contracts", () => {
  test("accepts a synthetic unified report without raw transcript content", () => {
    const report = unifiedReportSchema.parse({
      daily: [
        {
          agent: "all",
          period: "2026-07-18",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 20,
          cacheCreationTokens: 0,
          totalTokens: 35,
          totalCost: 0.02,
          modelsUsed: ["model-a"],
          modelBreakdowns: [],
          agents: [],
        },
      ],
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        totalTokens: 35,
        totalCost: 0.02,
      },
    });
    expect(report.daily[0].totalTokens).toBe(35);
    expect(report.session).toEqual([]);
  });

  test("rejects a missing numeric total instead of zero-filling it", () => {
    const result = unifiedReportSchema.safeParse({
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        totalTokens: 35,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["totals", "totalCost"]);
    }
  });

  test("accepts null burn rate and projection from inactive blocks", () => {
    const report = blocksReportSchema.parse({
      blocks: [
        {
          id: "synthetic-block",
          startTime: "2026-07-18T10:00:00.000Z",
          endTime: "2026-07-18T15:00:00.000Z",
          isActive: false,
          totalTokens: 42,
          costUSD: 0,
          burnRate: null,
          projection: null,
          models: [],
          entries: 1,
        },
      ],
    });
    expect(report.blocks[0].burnRate).toBeNull();
  });
});

describe("app-owned session identity", () => {
  test("keeps the documented formula, because stored annotations are keyed by it", () => {
    // sha256("codex" NUL path NUL key), first 24 hex characters (docs/ARCHITECTURE.md).
    expect(stableSessionId("codex", ".codex/sessions/2026/07/rollout-a.jsonl", "native-a")).toBe("001300775d0de30ade04ab98");
  });

  test("namespaces identical native keys by agent and by source", () => {
    const base = stableSessionId("codex", ".codex/sessions/a.jsonl", "a");
    expect(stableSessionId("claude", ".codex/sessions/a.jsonl", "a")).not.toBe(base);
    expect(stableSessionId("codex", ".codex/sessions/b.jsonl", "a")).not.toBe(base);
    expect(stableSessionId("codex", ".codex/sessions/a.jsonl", "b")).not.toBe(base);
  });

  test("matches Codex report paths to indexed session files", () => {
    expect(
      sessionReportKeys(
        "codex",
        "native-a",
        "/Users/test/.codex/sessions/2026/07/18/rollout-a.jsonl",
      ),
    ).toContain("2026/07/18/rollout-a");
  });
});

describe("cross-agent project activity", () => {
  test("groups session tokens by provider, day, and working directory", () => {
    const activity = aggregateProjectActivity([
      {
        agent: "codex",
        period: "2026/07/18/rollout-a",
        totalTokens: 100,
        totalCost: 0.01,
        cwd: "/work/myessentials-ui",
        metadata: { lastActivity: "2026-07-18T16:00:00Z" },
        modelBreakdowns: [
          {
            modelName: "gpt-test",
            inputTokens: 60,
            outputTokens: 10,
            cacheReadTokens: 30,
            cacheCreationTokens: 0,
            cost: 0.01,
          },
        ],
      },
      {
        agent: "claude",
        period: "native-a",
        totalTokens: 40,
        totalCost: 0.02,
        cwd: "/work/myessentials-ui",
        metadata: { lastActivity: "2026-07-18T17:00:00Z" },
        modelBreakdowns: [
          {
            modelName: "claude-test",
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 15,
            cacheCreationTokens: 0,
            cost: 0.02,
          },
        ],
      },
    ], "UTC");
    expect(activity).toHaveLength(2);
    expect(
      activity.find((item) => item.provider === "codex")?.projectName,
    ).toBe("myessentials-ui");
    expect(
      activity.find((item) => item.provider === "anthropic")?.models[0],
    ).toEqual({ model: "claude-test", tokens: 40, cost: 0.02 });
  });

  test("combines Codex and Claude usage in project cards", () => {
    const projects = aggregateProjects([
      {
        agent: "codex",
        period: "2026/07/18/rollout-a",
        totalTokens: 100,
        totalCost: 0.01,
        cwd: "/work/observatory",
        metadata: { lastActivity: "2026-07-18T16:00:00Z" },
        modelBreakdowns: [
          {
            modelName: "gpt-test",
            inputTokens: 60,
            outputTokens: 10,
            cacheReadTokens: 30,
            cacheCreationTokens: 0,
            cost: 0.01,
          },
        ],
      },
      {
        agent: "claude",
        period: "native-a",
        totalTokens: 40,
        totalCost: 0.02,
        cwd: "/work/observatory",
        metadata: { lastActivity: "2026-07-18T17:00:00Z" },
        modelBreakdowns: [
          {
            modelName: "claude-test",
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 15,
            cacheCreationTokens: 0,
            cost: 0.02,
          },
        ],
      },
    ], "UTC");
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "/work/observatory",
      tokens: 140,
      cost: 0.03,
      sessions: 2,
      models: ["gpt-test", "claude-test"],
    });
    expect(
      projects[0].trend[0].modelBreakdowns.map((model) => model.modelName),
    ).toEqual(["gpt-test", "claude-test"]);
  });
});

describe("warp usage in period rows", () => {
  const warpSession = (lastActivity: string, tokens: number) => ({
    agent: "warp",
    period: `warp-${lastActivity}`,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: tokens,
    totalCost: 0,
    cwd: "/work/observatory",
    metadata: { lastActivity },
    modelBreakdowns: [],
  });
  const ccusageRow = (period: string) => ({
    agent: "all",
    period,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 20,
    cacheCreationTokens: 0,
    totalTokens: 35,
    totalCost: 0.02,
    modelsUsed: [],
    modelBreakdowns: [],
  });

  test("weekKey buckets any day onto its Monday, matching ccusage weeks", () => {
    expect(weekKey("2026-08-24")).toBe("2026-08-24");
    expect(weekKey("2026-08-29")).toBe("2026-08-24");
    expect(weekKey("2026-08-30")).toBe("2026-08-24");
    expect(weekKey("2026-01-01")).toBe("2025-12-29");
    expect(monthKey("2026-08-29")).toBe("2026-08");
  });

  test("merges warp days into the matching ccusage week and keeps warp-only weeks", () => {
    const weekly = mergeWarp(
      [ccusageRow("2026-08-24")],
      [warpSession("2026-08-25T12:00:00Z", 100), warpSession("2026-08-29T12:00:00Z", 40), warpSession("2026-09-01T12:00:00Z", 7)],
      "UTC",
      weekKey,
    );
    expect(weekly.map((row) => row.period)).toEqual(["2026-08-24", "2026-08-31"]);
    expect(weekly[0]).toMatchObject({ agent: "all", inputTokens: 150, totalTokens: 175 });
    expect(weekly[0].agents?.find((agent) => agent.agent === "warp")?.totalTokens).toBe(140);
    expect(weekly[1]).toMatchObject({ agent: "warp", inputTokens: 7, totalTokens: 7 });
  });

  test("merges warp days into the matching ccusage month", () => {
    const monthly = mergeWarp(
      [ccusageRow("2026-08")],
      [warpSession("2026-08-25T12:00:00Z", 100), warpSession("2026-08-29T12:00:00Z", 40)],
      "UTC",
      monthKey,
    );
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({ agent: "all", period: "2026-08", inputTokens: 150, totalTokens: 175 });
  });
});

describe("ccusage report cache", () => {
  const blocks = [
    { isActive: false, endTime: "2026-10-13T10:00:00.000Z" },
    { isActive: true, endTime: "2026-10-13T15:00:00.000Z" },
  ];

  test("expires when the earliest active block ends", () => {
    const expiresAt = activeBlockExpiry(blocks);
    expect(expiresAt).toBe(Date.parse("2026-10-13T15:00:00.000Z"));
    const cache = { fingerprint: "a", expiresAt };
    expect(ccusageCacheUsable(cache, "a", expiresAt! - 1)).toBe(true);
    expect(ccusageCacheUsable(cache, "a", expiresAt!)).toBe(false);
  });

  test("without an active block, only a transcript change invalidates it", () => {
    const cache = { fingerprint: "a", expiresAt: activeBlockExpiry([blocks[0]]) };
    expect(cache.expiresAt).toBeNull();
    expect(ccusageCacheUsable(cache, "a", Date.parse("2030-01-01"))).toBe(true);
    expect(ccusageCacheUsable(cache, "b", 0)).toBe(false);
    expect(ccusageCacheUsable(null, "a", 0)).toBe(false);
  });
});

describe("Antigravity through ccusage", () => {
  const neon = (input: number, output: number, cacheRead: number, cost: number) => ({ modelName: "gemini-4-neon", inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: 0, cost });
  /** ccusage's shape: thinking is in `totalTokens` but not in `outputTokens`. */
  const antigravityAgent = (thinking: number) => ({
    agent: "antigravity", inputTokens: 100, outputTokens: 20, cacheReadTokens: 1_000, cacheCreationTokens: 0,
    totalTokens: 1_120 + thinking, totalCost: 0.05, modelsUsed: ["gemini-4-neon"], modelBreakdowns: [neon(100, 20, 1_000, 0.05)],
  });
  const claudeAgent = {
    agent: "claude", inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 1,
    totalTokens: 36, totalCost: 0.02, modelsUsed: ["claude-opus-5"],
    modelBreakdowns: [{ modelName: "claude-opus-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 1, cost: 0.02 }],
  };
  const report = () => unifiedReportSchema.parse({
    daily: [{
      agent: "all", period: "2026-11-22", inputTokens: 110, outputTokens: 25, cacheReadTokens: 1_020, cacheCreationTokens: 1,
      totalTokens: 1_156 + 30, totalCost: 0.07, modelsUsed: ["gemini-4-neon", "claude-opus-5"],
      modelBreakdowns: [neon(100, 20, 1_000, 0.05), claudeAgent.modelBreakdowns[0]],
      agents: [claudeAgent, antigravityAgent(30)],
    }],
    weekly: [], monthly: [],
    session: [
      { ...antigravityAgent(30), period: "11111111-2222-3333-4444-555555555555", metadata: { lastActivity: "2026-11-22T15:00:00.000Z" } },
      { agent: "antigravity", period: "multi", inputTokens: 0, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 401, totalCost: 1,
        modelsUsed: ["gemini-4-neon", "gemini-4-argon"],
        modelBreakdowns: [{ ...neon(0, 200, 0, 0.5) }, { ...neon(0, 100, 0, 0.5), modelName: "gemini-4-argon" }] },
      { ...claudeAgent, period: "c1" },
    ],
    totals: { inputTokens: 110, outputTokens: 25, cacheReadTokens: 1_020, cacheCreationTokens: 1, totalTokens: 1_186, totalCost: 0.07 },
  });
  const buckets = (row: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) =>
    row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;

  test("thinking folds into output, so every Antigravity bucket sum meets its total", () => {
    const unified = foldAntigravityThinking(report());
    const day = unified.daily[0]!;
    const agent = day.agents!.find((entry) => entry.agent === "antigravity")!;
    expect(agent.outputTokens).toBe(50);
    expect(buckets(agent)).toBe(agent.totalTokens);
    expect(agent.modelBreakdowns[0]!.outputTokens).toBe(50);
    expect(buckets(day)).toBe(day.totalTokens);
    expect(day.modelBreakdowns.find((model) => model.modelName === "gemini-4-neon")!.outputTokens).toBe(50);
    // Another agent's row is left exactly as ccusage wrote it.
    expect(day.agents!.find((entry) => entry.agent === "claude")).toEqual(claudeAgent);
    expect(day.modelBreakdowns.find((model) => model.modelName === "claude-opus-5")!.outputTokens).toBe(5);
    const [session, multi, claude] = unified.session;
    expect([session!.outputTokens, buckets(session!), session!.totalTokens]).toEqual([50, 1_150, 1_150]);
    expect(session!.modelBreakdowns[0]!.outputTokens).toBe(50);
    // Several models split the thinking by output, in whole tokens that add up.
    expect(multi!.modelBreakdowns.map((model) => model.outputTokens)).toEqual([267, 134]);
    expect(buckets(multi!)).toBe(401);
    expect(claude!.outputTokens).toBe(5);
    expect(unified.totals.outputTokens).toBe(55);
    expect(buckets(unified.totals)).toBe(unified.totals.totalTokens);
    // Cost is ccusage's, untouched.
    expect(unified.totals.totalCost).toBe(0.07);
  });

  test("ccusage's Antigravity rows pass through the calendar merge once", () => {
    const unified = foldAntigravityThinking(report());
    const daily = mergeWarp(unified.daily as never, [{ agent: "antigravity", period: "x", totalTokens: 1_150, totalCost: 0.05, cwd: "/work", metadata: { lastActivity: "2026-11-22T15:00:00.000Z" }, modelBreakdowns: [] }], "UTC");
    expect(daily).toHaveLength(1);
    expect(daily[0]!.totalTokens).toBe(1_186);
    expect(daily[0]!.agents).toHaveLength(2);
    expect(totalsWithWarp(unified.totals, { tokens: 100 })).toMatchObject({ inputTokens: 210, outputTokens: 55, totalTokens: 1_286, totalCost: 0.07 });
  });

  const conversation = (conversationId: string, tokens: number) => ({
    conversationId,
    sessionId: `antigravity-${conversationId}`,
    cwd: "/work/quota-service",
    lastActivity: "2026-11-22T15:00:00.000Z",
    models: ["gemini-4-neon"],
    stats: { conversationId, generations: 4, reasoningOutputTokens: 30, parentConversationId: null, root: "t3" as const },
    activityIntervals: [{ startAt: 1, endAt: 2 }],
    tokens,
  });

  test("metadata joins ccusage's session by conversation id under one stable id", () => {
    const rows = [
      { agent: "antigravity", period: "known", sessionId: "antigravity-known", cwd: null, pathTags: [], totalTokens: 10 },
      { agent: "antigravity", period: "unread", sessionId: "antigravity-unread", cwd: null, pathTags: [], totalTokens: 5 },
      { agent: "claude", period: "c", sessionId: "claude-c", cwd: "/x", pathTags: ["x"], totalTokens: 1 },
    ];
    const joined = joinAntigravitySessions(rows, [conversation("known", 10)], (cwd) => cwd ? ["tagged"] : []);
    expect(joined[0]).toMatchObject({
      sessionId: "antigravity-known", source: "antigravity", cwd: "/work/quota-service", pathTags: ["tagged"],
      antigravity: { generations: 4, reasoningOutputTokens: 30 }, activityIntervals: [{ startAt: 1, endAt: 2 }],
    });
    // A ccusage session the reader did not see keeps the same id scheme and no invented cwd.
    expect(joined[1]).toMatchObject({ sessionId: "antigravity-unread", source: "antigravity", cwd: null });
    expect(joined[2]).toBe(rows[2]);
    // Projects then see the joined working directory on the session's last-activity day.
    const activity = aggregateProjectActivity([{ ...joined[0]!, totalCost: 0.05, metadata: { lastActivity: "2026-11-22T15:00:00.000Z" }, modelBreakdowns: [] }], "UTC");
    expect(activity.map((row) => [row.date, row.provider, row.projectId, row.tokens, row.cost])).toEqual([["2026-11-22", "antigravity", "/work/quota-service", 10, 0.05]]);
  });

  test("source health reports the reconciliation with ccusage", () => {
    const sessions = [{ agent: "antigravity", period: "a", totalTokens: 1_000, totalCost: 2 }, { agent: "claude", period: "c", totalTokens: 9, totalCost: 9 }];
    const reconciliation = antigravityReconciliation(sessions, [conversation("a", 1_000)]);
    expect(reconciliation).toEqual({ ccusageSessions: 1, ccusageTokens: 1_000, ccusageCost: 2, metadataSessions: 1, metadataTokens: 1_000, joined: 1, ccusageOnly: 0, metadataOnly: 0 });
    const data = {
      available: true, roots: [".t3/userdata/providers/antigravity/x/antigravity-acp"], observedAt: "", sessionCount: 1,
      generationCount: 9, auxiliaryCalls: 1, totals: { sessions: 1, generations: 9, tokens: 1_000, reasoningOutputTokens: 0 },
      daily: [], notes: [], subagentConversations: 0, reconciliation,
    };
    expect(antigravityHealth(data)).toEqual({
      name: "Antigravity local conversations", status: "healthy", kind: "local metadata",
      detail: "1 conversation · 9 model calls · 1 data directory read · ccusage reconciles: 1 session, 1,000 tokens",
    });
    const apart = antigravityHealth({ ...data, reconciliation: antigravityReconciliation(sessions, [conversation("a", 990), conversation("b", 5)]) });
    expect(apart.status).toBe("degraded");
    expect(apart.detail).toContain("ccusage reports 1 session and 1,000 tokens; the metadata reader found 2 and 995 (1 joined, 0 ccusage only, 1 metadata only)");
    expect(antigravityHealth({ ...data, notes: ["1 database could not be read safely; the last good read is kept"] }).status).toBe("degraded");
    expect(antigravityHealth({ ...data, available: false, roots: [], error: "No Antigravity data directory was found on this machine." })).toMatchObject({ status: "unavailable" });
  });
});
