import { expect, test } from "bun:test";
import { pathFilteredRows } from "./App";
import type { Session } from "./types";

function session(overrides: Partial<Session>): Session {
  return {
    agent: "codex",
    sessionId: "session",
    period: "2026-07-18",
    cwd: "/work/observatory",
    pathTags: ["observatory"],
    annotation: { tags: [], note: "" },
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 20,
    cacheCreationTokens: 0,
    totalTokens: 35,
    totalCost: 0.02,
    modelsUsed: ["gpt-test"],
    modelBreakdowns: [
      {
        modelName: "gpt-test",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        cost: 0.02,
      },
    ],
    ...overrides,
  };
}

test("pathFilteredRows combines matching sessions only within the selected periods", () => {
  const rows = pathFilteredRows(
    [
      session({ sessionId: "first" }),
      session({
        sessionId: "second",
        inputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 0,
        totalTokens: 5,
        totalCost: 0.01,
        modelBreakdowns: [
          {
            modelName: "gpt-test",
            inputTokens: 4,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: 0.01,
          },
        ],
      }),
      session({ sessionId: "outside", period: "2026-07-17" }),
    ],
    new Set(["2026-07-18"]),
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    period: "2026-07-18",
    totalTokens: 40,
    totalCost: 0.03,
  });
  expect(rows[0]?.modelBreakdowns[0]).toMatchObject({
    modelName: "gpt-test",
    inputTokens: 14,
    outputTokens: 6,
    cacheReadTokens: 20,
    cost: 0.03,
  });
});
