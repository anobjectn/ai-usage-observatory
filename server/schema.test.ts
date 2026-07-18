import { describe, expect, test } from "bun:test";
import { stableSessionId } from "./path-indexer";
import { blocksReportSchema, unifiedReportSchema } from "./schema";

describe("normalized ingestion contracts", () => {
  test("accepts a synthetic unified report without raw transcript content", () => {
    const report = unifiedReportSchema.parse({
      daily: [{
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
      }],
      totals: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 0, totalTokens: 35, totalCost: 0.02 },
    });
    expect(report.daily[0].totalTokens).toBe(35);
    expect(report.session).toEqual([]);
  });

  test("accepts null burn rate and projection from inactive blocks", () => {
    const report = blocksReportSchema.parse({ blocks: [{
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
    }] });
    expect(report.blocks[0].burnRate).toBeNull();
  });
});

describe("app-owned session identity", () => {
  test("is deterministic across report refreshes", () => {
    const first = stableSessionId("codex", ".codex/sessions/2026/07/rollout-a.jsonl", "native-a");
    const next = stableSessionId("codex", ".codex/sessions/2026/07/rollout-a.jsonl", "native-a");
    expect(first).toBe(next);
    expect(first).toHaveLength(24);
  });

  test("namespaces identical native keys by agent and source", () => {
    const claude = stableSessionId("claude", ".claude/projects/project/a.jsonl", "a");
    const codex = stableSessionId("codex", ".codex/sessions/a.jsonl", "a");
    expect(claude).not.toBe(codex);
  });
});
