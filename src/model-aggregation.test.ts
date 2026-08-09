import { expect, test } from "bun:test";
import { aggregateModels } from "./model-aggregation";

test("model aggregation uses only the supplied daily rows", () => {
  const row = {
    agent: "all",
    period: "2026-07-20",
    modelBreakdowns: [],
    agents: [
      {
        agent: "codex",
        modelBreakdowns: [
          { modelName: "gpt-test", inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 2, cost: 0.04 },
        ],
      },
    ],
  };
  expect(aggregateModels([row], ["gpt-test"])).toEqual([
    {
      model: "gpt-test",
      tokens: 37,
      cost: 0.04,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 20,
      cacheCreationTokens: 2,
      agents: ["codex"],
      priced: false,
    },
  ]);
  expect(aggregateModels([])).toEqual([]);
});
