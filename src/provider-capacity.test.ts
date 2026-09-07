import { expect, test } from "bun:test";
import { providerCapacityRows } from "./App";
import type { DashboardData, MetricRow } from "./types";

function metric(agent: string, totalTokens: number): MetricRow {
  return {
    agent,
    period: "2026-09-07",
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens,
    totalCost: 0,
    modelsUsed: [],
    modelBreakdowns: [],
  };
}

function quotas(): DashboardData["quotas"] {
  return {
    available: true,
    collectedAt: "2026-09-07T12:00:00Z",
    usage: {
      generatedAt: Date.parse("2026-09-07T12:00:00Z"),
      providers: [
        {
          provider: "anthropic",
          status: "ok",
          source: "test",
          snapshot: {
            kind: "window",
            fiveHour: { usedPercent: 40, resetsAt: null },
            weekly: { usedPercent: 80, resetsAt: null },
          },
        },
        {
          provider: "codex",
          status: "ok",
          source: "test",
          snapshot: {
            kind: "window",
            fiveHour: { usedPercent: 95, resetsAt: null },
            weekly: { usedPercent: 50, resetsAt: null },
          },
        },
      ],
    },
    history: {
      available: true,
      trackingSince: Date.parse("2026-08-01T00:00:00Z"),
      windows: [
        {
          provider: "anthropic",
          window: "fiveHour",
          reachedCount: 2,
          lastReachedAt: null,
          reachedAt: [],
        },
        {
          provider: "anthropic",
          window: "weekly",
          reachedCount: 1,
          lastReachedAt: null,
          reachedAt: [],
        },
        {
          provider: "codex",
          window: "fiveHour",
          reachedCount: 4,
          lastReachedAt: null,
          reachedAt: [],
        },
        {
          provider: "codex",
          window: "weekly",
          reachedCount: 0,
          lastReachedAt: null,
          reachedAt: [],
        },
      ],
      codexBankedResets: {
        usedCount: 2,
        used: [],
      },
    },
  };
}

test("providerCapacityRows compares filtered token share with current quota pressure", () => {
  const rows = providerCapacityRows(
    [
      {
        ...metric("all", 400),
        agents: [metric("claude-code", 300), metric("codex", 100)],
      },
    ],
    quotas(),
  );

  expect(rows.map((row) => row.provider)).toEqual(["anthropic", "codex"]);
  expect(rows[0]).toMatchObject({
    tokenShare: 75,
    highestUsedPercent: 80,
    limitReaches: 3,
    reachBreakdown: "5-hour 2 · Weekly 1",
  });
  expect(rows[1]).toMatchObject({
    tokenShare: 25,
    highestUsedPercent: 95,
    limitReaches: 4,
    resetsApplied: 2,
  });
});

test("connected capacity remains visible when the filtered range has no activity", () => {
  const rows = providerCapacityRows([], quotas());
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.tokenShare === 0)).toBe(true);
});
