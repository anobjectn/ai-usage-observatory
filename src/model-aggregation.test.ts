import { expect, test } from "bun:test";
import { aggregateModels, hasUnpricedModel } from "./model-aggregation";

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

test("Antigravity models are priced by ccusage like any other agent's", () => {
  const gemini = { modelName: "gemini-4-neon", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 9_000, cacheCreationTokens: 0, cost: 0.006 };
  const [model] = aggregateModels([{ agent: "all", modelBreakdowns: [], agents: [{ agent: "antigravity", modelBreakdowns: [gemini] }] }]);
  expect(model).toMatchObject({ model: "gemini-4-neon", tokens: 10_100, pricedTokens: 10_100, cost: 0.006, priced: true, agents: ["antigravity"] });
});

test("offline, ccusage's unpriced Antigravity model stays out of the $/Mtok denominator", () => {
  const gemini = { modelName: "gemini-4-neon", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 9_000, cacheCreationTokens: 0, cost: 0 };
  const [model] = aggregateModels([{ agent: "all", modelBreakdowns: [], agents: [{ agent: "antigravity", modelBreakdowns: [gemini] }] }], ["gemini-4-neon"]);
  expect(model).toMatchObject({ model: "gemini-4-neon", tokens: 10_100, pricedTokens: 0, cost: 0, priced: false });
});

test("a session that ran an unpriced model is flagged so its cost stays out of medians", () => {
  const session = { modelBreakdowns: [{ modelName: "claude-opus-5" }, { modelName: "gemini-4-neon" }] };
  expect(hasUnpricedModel(session, ["gemini-4-neon"])).toBe(true);
  expect(hasUnpricedModel(session, [])).toBe(false);
  expect(hasUnpricedModel(session, ["gpt-5.6-sol"])).toBe(false);
});
