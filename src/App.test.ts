import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  averageMetricSlices,
  metricRowCacheShare,
  SessionDetailPanel,
  pathFilteredRows,
  periodTickLabel,
  projectDayRows,
  projectModelSessionRows,
  projectSummaryInRange,
  projectTrendRowsInRange,
  sessionModelNames,
  sessionQuotaImpactItems,
  sessionRangeLabel,
  withoutCacheMetricRow,
} from "./App";
import type {
  MetricRow,
  ProjectActivity,
  ProjectTrendRow,
  Session,
  SessionQuotaContext,
} from "./types";

function session(overrides: Partial<Session>): Session {
  return {
    agent: "codex",
    sessionId: "session",
    period: "2026-07-18",
    cwd: "/work/observatory",
    pathTags: ["observatory"],
    annotation: { tags: [], note: "", verdict: null },
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

test("averageMetricSlices separates active weekdays and weekends", () => {
  const rows = [
    session({ period: "2026-07-20", totalTokens: 100 }),
    session({ period: "2026-07-21", totalTokens: 300 }),
    session({ period: "2026-07-25", totalTokens: 50 }),
    session({ period: "2026-07-26", totalTokens: 150 }),
  ];

  expect(averageMetricSlices(rows, (row) => row.totalTokens)).toEqual({
    day: 150,
    weekday: 200,
    weekend: 100,
  });
  expect(averageMetricSlices([], (row) => row.totalTokens)).toEqual({
    day: null,
    weekday: null,
    weekend: null,
  });
});

test("cache-share averages use each active day's share", () => {
  const rows = [
    session({
      period: "2026-07-20",
      inputTokens: 50,
      outputTokens: 50,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
    }),
    session({
      period: "2026-07-21",
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    session({
      period: "2026-07-25",
      inputTokens: 0,
      outputTokens: 50,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
    }),
  ];

  expect(metricRowCacheShare(rows[0])).toBe(50);
  expect(
    averageMetricSlices(rows, metricRowCacheShare),
  ).toMatchObject({ weekday: 25, weekend: 50 });
  expect(averageMetricSlices(rows, metricRowCacheShare).day).toBeCloseTo(33.3333, 3);
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

test("projectSummaryInRange recalculates every project card total", () => {
  const daily = [{ period: "2026-07-18" }] as MetricRow[];
  const trend = [
    {
      date: "2026-07-17",
      totalTokens: 100,
      totalCost: 1,
      modelBreakdowns: [{ modelName: "old", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }],
    },
    {
      date: "2026-07-18",
      totalTokens: 25,
      totalCost: 0.25,
      modelBreakdowns: [{ modelName: "current", inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.25 }],
    },
  ] as ProjectTrendRow[];
  const project = {
    name: "/work/example",
    tokens: 125,
    cost: 1.25,
    sessions: 4,
    models: ["old", "current"],
    trend,
  };
  expect(projectSummaryInRange(project, daily, 1)).toMatchObject({
    tokens: 25,
    cost: 0.25,
    sessions: 1,
    models: ["current"],
    trend: [trend[1]],
  });
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
  expect(html).toContain('aria-label="Open Prompt source actions"');
  expect(html).toContain('aria-label="Open Output source actions"');
  expect(html).toContain('aria-label="Open actions for src/App.tsx"');
  expect(html).toContain('class="file-path-tail"');
  expect(sessionModelNames(mixedSession)).toEqual(["gpt-test", "gpt-second"]);
});

test("session quota context uses account-level, non-additive language", () => {
  const html = renderToStaticMarkup(
    createElement(SessionDetailPanel, {
      session: session({}),
      loading: false,
      effortStatus: null,
      detail: {
        available: true,
        prompts: [], outputs: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 2,
        quotaContext: {
          provider: "codex",
          basis: "embedded_account_observation",
          resources: [{
            id: "fiveHour", kind: "window", unit: "percentage_points",
            deltaPercentagePoints: 49.25, deltaUnits: null, cycleCount: 1,
            measurable: true, limitChanged: false,
            episodes: [{
              cycleId: "reset:1", startUsedPercent: 50.5, endUsedPercent: 99.75,
              deltaPercentagePoints: 49.25, startUsedUnits: null, endUsedUnits: null, deltaUnits: null,
            }],
          }],
          concurrency: {
            distinctOtherSameProviderSessions: 2, maxOtherSameProviderSessions: 2,
            distinctOtherProviderSessions: 1, maxOtherProviderSessions: 1, externalActivity: "unknown",
          },
          coverage: {
            startGapMs: 1_000, endGapMs: 1_000, activeDurationCoveredPercent: 95,
            snapshotCount: 2, historyReachesSession: true,
          },
          confidence: "high", additive: false, reason: null, sourceState: "connected",
        },
      },
    }),
  );

  expect(html).toContain("+49.3% of quota");
  expect(html).toContain("not that it increased by 10% relative");
  expect(html).toContain("Up to 2 other local Codex sessions overlapped");
  expect(html).toContain("account or seat-level observations");
  expect(html).toContain("Overlapping session values are not additive");
  expect(html).not.toContain("this session consumed");
});

test("sessionQuotaImpactItems formats resolved account quota shares for table rows", () => {
  const context = {
    provider: "codex",
    basis: "embedded_account_observation",
    resources: [
      { id: "fiveHour", deltaPercentagePoints: 12.5 },
      { id: "weekly", deltaPercentagePoints: 3 },
      { id: "unrecognized", deltaPercentagePoints: 9 },
    ],
    confidence: "high",
  } as SessionQuotaContext;

  expect(sessionQuotaImpactItems(context)).toEqual([
    { id: "fiveHour", label: "5h", value: 12.5 },
    { id: "weekly", label: "w", value: 3 },
  ]);
  expect(sessionQuotaImpactItems({ ...context, confidence: "insufficient" })).toEqual([]);
});

test("projectModelSessionRows keeps only sessions that touched the model, newest first", () => {
  const rows = projectModelSessionRows(
    [
      session({
        sessionId: "older",
        metadata: { lastActivity: "2026-07-16T09:00:00Z" },
      }),
      session({
        sessionId: "other-model",
        modelsUsed: ["gpt-other"],
        modelBreakdowns: [
          {
            modelName: "gpt-other",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: 0.5,
          },
        ],
        metadata: { lastActivity: "2026-07-19T09:00:00Z" },
      }),
      session({
        sessionId: "newer",
        metadata: { lastActivity: "2026-07-18T09:00:00Z" },
      }),
    ],
    "gpt-test",
  );

  expect(rows.map((row) => row.session.sessionId)).toEqual(["newer", "older"]);
  expect(rows[0]?.tokens).toBe(35);
  expect(rows[0]?.cost).toBeCloseTo(0.02);
});

test("projectModelSessionRows counts only the model's share of a mixed session", () => {
  const [row] = projectModelSessionRows(
    [
      session({
        sessionId: "mixed",
        totalTokens: 135,
        totalCost: 0.52,
        modelsUsed: ["gpt-test", "gpt-second"],
        modelBreakdowns: [
          {
            modelName: "gpt-test",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 20,
            cacheCreationTokens: 0,
            cost: 0.02,
          },
          {
            modelName: "gpt-second",
            inputTokens: 60,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: 0.5,
          },
        ],
      }),
    ],
    "gpt-second",
  );

  expect(row?.tokens).toBe(100);
  expect(row?.cost).toBeCloseTo(0.5);
});

test("sessionRangeLabel collapses a single-day range and reports empty sets", () => {
  const rows = projectModelSessionRows(
    [
      session({ sessionId: "a", period: "2026-07-16" }),
      session({ sessionId: "b", period: "2026-07-18" }),
    ],
    "gpt-test",
  );

  expect(sessionRangeLabel(rows)).toBe("Jul 16, 2026 — Jul 18, 2026");
  expect(sessionRangeLabel(rows.slice(0, 1))).toBe("Jul 18, 2026");
  expect(sessionRangeLabel([])).toBe("No dated sessions");
});
