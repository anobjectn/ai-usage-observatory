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
      pricedTokens: 0,
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

test("priced tokens exclude Warp sightings of a model that ccusage also prices", () => {
  const breakdown = { modelName: "claude-test", inputTokens: 600_000, outputTokens: 400_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const row = {
    agent: "all",
    modelBreakdowns: [],
    agents: [
      { agent: "claude", modelBreakdowns: [{ ...breakdown, cost: 10 }] },
      { agent: "warp", modelBreakdowns: [{ ...breakdown, cost: 0 }] },
    ],
  };
  const [model] = aggregateModels([row]);
  expect(model.tokens).toBe(2_000_000);
  expect(model.pricedTokens).toBe(1_000_000);
  // Equal Warp traffic must not halve the rate: $10 over 1 Mtok of priced traffic.
  expect(model.cost / (model.pricedTokens / 1_000_000)).toBe(10);
});
