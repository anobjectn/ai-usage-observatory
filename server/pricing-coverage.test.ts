import { describe, expect, test } from "bun:test";
import { findUnpricedModels } from "./ccusage";
import { unifiedReportSchema } from "./schema";

const model = (modelName: string, tokens: number, cost: number) => ({
  modelName,
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cost,
});

const report = (modelBreakdowns: ReturnType<typeof model>[], section = "daily") =>
  unifiedReportSchema.parse({
    [section]: [
      {
        agent: "all",
        period: "2026-07-24",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        modelBreakdowns,
      },
    ],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, totalCost: 0 },
  });

describe("pricing coverage detection", () => {
  test("flags a model that burned tokens but was priced at zero", () => {
    expect(findUnpricedModels(report([model("claude-opus-5", 63_000_000, 0)]))).toEqual(["claude-opus-5"]);
  });

  test("does not flag a priced model", () => {
    expect(findUnpricedModels(report([model("claude-opus-5", 63_000_000, 41.59)]))).toEqual([]);
  });

  test("does not flag a model with no usage at all", () => {
    expect(findUnpricedModels(report([model("claude-opus-5", 0, 0)]))).toEqual([]);
  });

  test("reports each unpriced model once, sorted, across sections", () => {
    const merged = unifiedReportSchema.parse({
      ...report([model("claude-sonnet-5", 1_000, 0), model("gpt-5.5", 1_000, 2)]),
      session: report([model("claude-opus-5", 1_000, 0), model("claude-sonnet-5", 500, 0)], "session").session,
    });
    expect(findUnpricedModels(merged)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  test("inspects per-agent breakdowns, not just the rolled-up row", () => {
    const withAgents = unifiedReportSchema.parse({
      daily: [
        {
          agent: "all",
          period: "2026-07-24",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          modelBreakdowns: [],
          agents: [
            {
              agent: "claude",
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 0,
              totalCost: 0,
              modelBreakdowns: [model("claude-opus-5", 63_000_000, 0)],
            },
          ],
        },
      ],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, totalCost: 0 },
    });
    expect(findUnpricedModels(withAgents)).toEqual(["claude-opus-5"]);
  });

  test("counts cache-only traffic as usage", () => {
    const cacheOnly = report([
      { modelName: "claude-opus-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 62_800_000, cacheCreationTokens: 0, cost: 0 },
    ]);
    expect(findUnpricedModels(cacheOnly)).toEqual(["claude-opus-5"]);
  });
});
