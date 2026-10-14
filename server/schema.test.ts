import { describe, expect, test } from "bun:test";
import { activeBlockExpiry, aggregateProjectActivity, aggregateProjects, ccusageCacheUsable, mergeWarp, monthKey, weekKey } from "./collector";
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
