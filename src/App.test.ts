import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SessionDetailPanel,
  pathFilteredRows,
  periodTickLabel,
  projectDayRows,
  projectTrendRowsInRange,
  sessionModelNames,
  withoutCacheMetricRow,
} from "./App";
import type {
  MetricRow,
  ProjectActivity,
  ProjectTrendRow,
  Session,
} from "./types";

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

test("projectTrendRowsInRange uses the dashboard time window", () => {
  const daily = [
    { period: "2026-07-17" },
    { period: "2026-07-18" },
  ] as MetricRow[];
  const trend = [
    { date: "2026-07-16" },
    { date: "2026-07-17" },
    { date: "2026-07-18" },
  ] as ProjectTrendRow[];

  expect(projectTrendRowsInRange(trend, daily).map((row) => row.date)).toEqual([
    "2026-07-17",
    "2026-07-18",
  ]);
});

test("projectDayRows exposes provider token segments", () => {
  const trend = [
    {
      date: "2026-07-18",
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      totalTokens: 100,
      totalCost: 0.1,
      modelsUsed: [],
      modelBreakdowns: [],
    },
  ] satisfies ProjectTrendRow[];
  const activity = [
    { date: "2026-07-18", provider: "anthropic", tokens: 35, sessions: 1 },
    { date: "2026-07-18", provider: "codex", tokens: 65, sessions: 2 },
  ] as ProjectActivity[];

  expect(projectDayRows(trend, activity)[0]).toMatchObject({
    anthropic: 35,
    codex: 65,
    warp: 0,
    unattributed: 0,
    runs: 3,
  });
});

test("periodTickLabel prepends an unambiguous weekday code", () => {
  expect(periodTickLabel("2026-07-20")).toBe("Mo Jul 20");
  expect(periodTickLabel("2026-07-21")).toBe("Tu Jul 21");
  expect(periodTickLabel("2026-07-26")).toBe("Su Jul 26");
});

test("withoutCacheMetricRow removes cache from totals and model breakdowns", () => {
  const row = withoutCacheMetricRow(session({}));

  expect(row).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 20,
    cacheCreationTokens: 0,
    totalTokens: 15,
  });
  expect(row.modelBreakdowns[0]).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});

test("session detail columns render in the requested order and default state", () => {
  const mixedSession = session({
    modelsUsed: ["gpt-test", "gpt-second"],
    modelBreakdowns: [
      ...session({}).modelBreakdowns,
      {
        modelName: "gpt-second",
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cost: 0.01,
      },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(SessionDetailPanel, {
      session: mixedSession,
      loading: false,
      effortStatus: null,
      detail: {
        available: true,
        prompts: [{ text: "Build it", timestamp: null }],
        outputs: [{ text: "Built", timestamp: null, truncated: false }],
        tools: [{ name: "apply_patch", count: 1 }],
        files: [
          {
            path: "src/App.tsx",
            status: "modified",
            additions: 1,
            deletions: 0,
          },
        ],
        additions: 1,
        deletions: 0,
        eventsRead: 4,
      },
    }),
  );

  const columns = ["prompt", "output", "files", "tools", "models", "effort"];
  expect(columns.map((column) => html.indexOf(`data-detail-column="${column}"`)))
    .toEqual([...columns.keys()].map((index) => html.indexOf(`data-detail-column="${columns[index]}"`)).sort((a, b) => a - b));
  for (const column of ["prompt", "output", "files"]) {
    expect(html).toContain(`data-detail-column="${column}" data-state="expanded"`);
  }
  for (const column of ["tools", "models", "effort"]) {
    expect(html).toContain(`data-detail-column="${column}" data-state="collapsed"`);
  }
  expect(html).toContain("Expand Model Mix, Mixed, 2 models");
  expect(html).toContain("file-diff");
  expect(html).toContain("1 addition and 0 deletions");
  expect(sessionModelNames(mixedSession)).toEqual(["gpt-test", "gpt-second"]);
});
