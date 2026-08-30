import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  averageMetricSlices,
  metricRowCacheShare,
  SessionDetailPanel,
  SessionMixGroupBreakdown,
  pathFilteredRows,
  periodTickLabel,
  projectDayRows,
  projectModelSessionRows,
  projectSummaryInRange,
  projectTrendRowsInRange,
  sessionProviderMix,
  sessionModelNames,
  sessionQuotaBalanceItems,
  quotaRemainingRanges,
  quotaResetBoundaries,
  sessionRangeLabel,
  withoutCacheMetricRow,
} from "./App";
import type {
  EffortSummary,
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

test("periodTickLabel prepends a locale-aware weekday abbreviation", () => {
  expect(periodTickLabel("2026-07-20")).toBe("Mon Jul 20");
  expect(periodTickLabel("2026-07-21")).toBe("Tue Jul 21");
  expect(periodTickLabel("2026-07-26")).toBe("Sun Jul 26");
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

  const columns = ["prompt", "output", "files", "tools", "models"];
  expect(columns.map((column) => html.indexOf(`data-detail-column="${column}"`)))
    .toEqual([...columns.keys()].map((index) => html.indexOf(`data-detail-column="${columns[index]}"`)).sort((a, b) => a - b));
  for (const column of ["prompt", "output", "files"]) {
    expect(html).toContain(`data-detail-column="${column}" data-state="expanded"`);
  }
  for (const column of ["tools", "models"]) {
    expect(html).toContain(`data-detail-column="${column}" data-state="collapsed"`);
  }
  // Models and effort share one column, so the rail names both and effort never gets its own.
  expect(html).not.toContain('data-detail-column="effort"');
  expect(html).toContain("Expand Models &amp; Effort, OpenAI, effort unknown");
  expect(html).toContain("file-diff");
  expect(html).toContain("1 addition and 0 deletions");
  expect(html).toContain('aria-label="Open Prompt source actions"');
  expect(html).toContain('aria-label="Open Output source actions"');
  expect(html).toContain('aria-label="Open actions for src/App.tsx"');
  expect(html).toContain('class="file-path-tail"');
  expect(sessionModelNames(mixedSession)).toEqual(["gpt-test", "gpt-second"]);
});

test("provider totals carry model \u00d7 effort subtotals and keep the remainder visible", () => {
  const { groups, comboCount, tokens } = sessionProviderMix(
    [
      { modelName: "claude-opus-5", tokens: 900 },
      { modelName: "claude-sonnet-5", tokens: 100 },
    ],
    [
      // Two transcript spellings of one family at one effort are one combo, not two.
      { model: "claude-opus-5[1m]", family: "claude-opus-5", effort: "high", observations: 2, tokens: 600 },
      { model: "claude-opus-5", family: "claude-opus-5", effort: "high", observations: 1, tokens: 40 },
      { model: "claude-sonnet-5", family: "claude-sonnet-5", effort: "low", observations: 1, tokens: 90 },
    ],
    "anthropic",
  );

  expect(groups.map((group) => [group.label, group.tokens, group.attributed])).toEqual([
    ["Anthropic", 1_000, 730],
  ]);
  expect(groups[0].combos).toEqual([
    { family: "claude-opus-5", effort: "high", tokens: 640, observations: 3 },
    { family: "claude-sonnet-5", effort: "low", tokens: 90, observations: 1 },
  ]);
  // The provider total is authoritative, so what the combos miss is reported, never absorbed.
  expect(groups[0].unattributed).toBe(270);
  expect(comboCount).toBe(2);
  expect(tokens).toBe(1_000);
});

test("each provider keeps its own total and its own combos", () => {
  const { groups, tokens } = sessionProviderMix(
    [
      { modelName: "claude-opus-5", tokens: 600 },
      { modelName: "gpt-5.6-sol", tokens: 400 },
    ],
    [
      { model: "gpt-5.6-sol", family: "gpt-5.6-sol", effort: "max", observations: 2, tokens: 400 },
      { model: "claude-opus-5", family: "claude-opus-5", effort: "high", observations: 1, tokens: 600 },
    ],
    "anthropic",
  );

  expect(groups.map((group) => [group.label, group.tokens, group.unattributed])).toEqual([
    ["Anthropic", 600, 0],
    ["OpenAI", 400, 0],
  ]);
  expect(groups[1].combos).toEqual([
    { family: "gpt-5.6-sol", effort: "max", tokens: 400, observations: 2 },
  ]);
  expect(tokens).toBe(1_000);
});

test("a provider with no recorded token total reports none rather than a partial sum", () => {
  const { groups, tokens } = sessionProviderMix(
    [{ modelName: "claude-opus-5", tokens: null }],
    [{ model: "claude-haiku-4-5", family: "claude-haiku-4-5", effort: "medium", observations: 1, tokens: 20 }],
    "anthropic",
  );

  expect(groups[0].tokens).toBeNull();
  // Without a total there is nothing to take the attributed tokens away from.
  expect(groups[0].unattributed).toBe(0);
  expect(groups[0].combos).toEqual([
    { family: "claude-haiku-4-5", effort: "medium", tokens: 20, observations: 1 },
  ]);
  expect(tokens).toBeNull();
});

test("the collapsed rail names the provider and its combos, not effort alone", () => {
  const effort: EffortSummary = {
    coverageState: "partial",
    quality: "ok",
    dominant: "high",
    dominantBasis: "tokens",
    mixed: true,
    levels: [
      { effort: "low", observations: 1, tokens: 100, tokenShare: 0.1 },
      { effort: "high", observations: 2, tokens: 600, tokenShare: 0.6 },
    ],
    reconciliationDeltaTokens: 0,
    observedObservations: 3,
    unknownObservations: 1,
    observationCoverage: 0.75,
    eligibleTokens: 1_000,
    attributedTokens: 700,
    unknownTokens: 300,
    tokenCoverage: 0.7,
  };
  const html = renderToStaticMarkup(
    createElement(SessionDetailPanel, {
      session: session({}),
      loading: false,
      effortStatus: null,
      detail: {
        available: true,
        prompts: [], outputs: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 1,
        effort,
        effortCombos: [
          { model: "gpt-test", family: "gpt-test", effort: "high", observations: 2, tokens: 600 },
          { model: "gpt-test", family: "gpt-test", effort: "low", observations: 1, tokens: 100 },
        ],
      },
    }),
  );

  // 70% of the tokens carry an effort, so the collapsed rail says so rather than showing only a
  // dominant value.
  expect(html).toContain("Expand Models &amp; Effort, OpenAI, 2 model \u00d7 effort combos, 70% of tokens tagged");
  expect(html).toContain("mixed");
  expect(html).toContain("tagged");
});

test("every subtotal is a model \u00d7 effort pill, and the remainder is labelled", () => {
  const html = renderToStaticMarkup(
    createElement(SessionMixGroupBreakdown, {
      label: "Anthropic",
      color: "var(--anthropic-color)",
      tokens: 1_000,
      combos: [
        { family: "claude-opus-5", effort: "high", tokens: 640, observations: 3 },
        { family: "claude-sonnet-5", effort: "", tokens: 90, observations: 1 },
      ],
      unattributed: 270,
    }),
  );

  expect(html).toContain("split-pill");
  // Effort is never shown without the model that recorded it.
  expect(html).toContain("Opus 5");
  expect(html).toContain("High");
  expect(html).toContain("Sonnet 5");
  expect(html).toContain("Unknown");
  // Every subtotal carries the same two metrics, so the untagged share can be compared with the
  // tagged one instead of being read as a footnote.
  expect(html).toContain("64% · 3 obs");
  expect(html).toContain("9% · 1 obs");
  expect(html).toContain("No effort recorded");
  expect(html).toContain("27% · no observations");
  expect(html).toContain("Anthropic by model and effort: Opus 5 · High 64%, Sonnet 5 · Unknown 9%, unattributed 27%");
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
            confidence: "high", reason: null,
            endUsedPercent: 99.75, endUsedUnits: null, limitUnits: null,
            endObservedAt: 1, endCycleId: "reset:1", endGapMs: 1_000,
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
            snapshotCount: 2, historyReachesSession: true, observationCadenceMs: 60_000,
          },
          confidence: "high", additive: false, reason: null, sourceState: "connected",
        },
      },
    }),
  );

  // Movement reads as a remaining-quota range, not a summed attribution.
  expect(html).toContain("49.5→0.3% remaining");
  expect(html).not.toContain("+49.3% of quota");
  expect(html).toContain("Closing reading: 0.3% (5h) remaining.");
  expect(html).toContain("Up to 2 other local Codex sessions overlapped");
  expect(html).toContain("account or seat-level observations");
  expect(html).toContain("never additive");
  expect(html).toContain("the window reset, then fell from 100% to 75%");
  expect(html).toContain("last embedded account reading during this session&#x27;s activity");
  expect(html).not.toContain("first account snapshot after");
  expect(html).not.toContain("this session consumed");
});

test("session quota context panel shows a resolved resource beside an unresolved one", () => {
  type QuotaResource = SessionQuotaContext["resources"][number];
  const resource = (over: Partial<QuotaResource>): QuotaResource => ({
    id: "weekly", kind: "window", unit: "percentage_points",
    deltaPercentagePoints: 3, deltaUnits: null, cycleCount: 1,
    measurable: true, limitChanged: false, confidence: "medium", reason: null,
    endUsedPercent: 43, endUsedUnits: null, limitUnits: null,
    endObservedAt: 2, endCycleId: "reset:2", endGapMs: 180_000,
    episodes: [{
      cycleId: "reset:2", startUsedPercent: 40, endUsedPercent: 43,
      deltaPercentagePoints: 3, startUsedUnits: null, endUsedUnits: null, deltaUnits: null,
    }],
    ...over,
  });
  const html = renderToStaticMarkup(
    createElement(SessionDetailPanel, {
      session: session({}),
      loading: false,
      effortStatus: null,
      detail: {
        available: true,
        prompts: [], outputs: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 2,
        quotaContext: {
          provider: "anthropic",
          basis: "bracketed_account_delta",
          resources: [
            resource({
              id: "fiveHour", deltaPercentagePoints: null, measurable: false, cycleCount: 0,
              confidence: "insufficient", episodes: [],
              endUsedPercent: null, endObservedAt: null, endCycleId: null, endGapMs: null,
              reason: "Waiting for the first snapshot after this session's last activity.",
            }),
            resource({}),
          ],
          concurrency: {
            distinctOtherSameProviderSessions: 0, maxOtherSameProviderSessions: 0,
            distinctOtherProviderSessions: 0, maxOtherProviderSessions: 0, externalActivity: "unknown",
          },
          coverage: {
            startGapMs: 200_000, endGapMs: 180_000, activeDurationCoveredPercent: 40,
            snapshotCount: 6, historyReachesSession: true, observationCadenceMs: 200_000,
          },
          confidence: "medium", additive: false, reason: null, sourceState: "connected",
        },
      },
    }),
  );

  expect(html).toContain("60→57% remaining");
  expect(html).toContain("Unresolved");
  expect(html).toContain("Waiting for the first snapshot");
  expect(html).toContain("1 resolved cycle · medium confidence");
  expect(html).toContain("200s snapshot cadence");
  // The detail summary names only balances backed by a closing reading.
  expect(html).toContain("Closing reading: 57% (w) remaining.");
});

test("sessionQuotaBalanceItems reads remaining quota from closing balances", () => {
  const context = {
    provider: "anthropic",
    coverage: { observationCadenceMs: 60_000 },
    resources: [
      { id: "fiveHour", kind: "window", endUsedPercent: 29, endUsedUnits: null, limitUnits: null, endGapMs: 1_000 },
      { id: "weekly", kind: "window", endUsedPercent: 24, endUsedUnits: null, limitUnits: null, endGapMs: 700_000 },
      { id: "unrecognized", kind: "window", endUsedPercent: 9, endUsedUnits: null, limitUnits: null, endGapMs: 0 },
      { id: "monthly", kind: "pool", endUsedPercent: 10, endUsedUnits: 150, limitUnits: 1_500, endGapMs: 0 },
    ],
  } as SessionQuotaContext;

  expect(sessionQuotaBalanceItems(context)).toEqual([
    { id: "fiveHour", label: "5h", remainingPercent: 71, remainingUnits: null, reason: null, stale: false },
    // A closing snapshot far beyond the movement-confidence threshold is flagged stale.
    { id: "weekly", label: "w", remainingPercent: 76, remainingUnits: null, reason: null, stale: true },
    { id: "monthly", label: "m", remainingPercent: null, remainingUnits: 1_350, reason: null, stale: false },
  ]);
  // A standard resource without a closing balance keeps its labelled slot beside its siblings.
  const mixed = {
    ...context,
    resources: [
      { ...context.resources[0]!, endUsedPercent: null },
      context.resources[1]!,
    ],
  } as SessionQuotaContext;
  expect(sessionQuotaBalanceItems(mixed).map((balance) => [balance.id, balance.remainingPercent])).toEqual([
    ["fiveHour", null],
    ["weekly", 76],
  ]);
});

test("a model window earns a balance row only while it diverges from the weekly reading", () => {
  const context = (modelUsedPercent: number) => ({
    provider: "anthropic",
    coverage: { observationCadenceMs: 60_000 },
    resources: [
      { id: "weekly", kind: "window", endUsedPercent: 24, endUsedUnits: null, limitUnits: null, endGapMs: 0 },
      { id: "model:Fable", kind: "window", endUsedPercent: modelUsedPercent, endUsedUnits: null, limitUnits: null, endGapMs: 0 },
    ],
  }) as SessionQuotaContext;

  expect(sessionQuotaBalanceItems(context(38))).toEqual([
    { id: "weekly", label: "w", remainingPercent: 76, remainingUnits: null, reason: null, stale: false },
    { id: "model:Fable", label: "Fable", remainingPercent: 62, remainingUnits: null, reason: null, stale: false },
  ]);
  expect(sessionQuotaBalanceItems(context(24)).map((balance) => balance.id)).toEqual(["weekly"]);
});

test("quotaRemainingRanges splits at resets and collapses episodes inside one cycle", () => {
  const episode = (cycleId: string, startUsedPercent: number, endUsedPercent: number) => ({
    cycleId, startUsedPercent, endUsedPercent,
    deltaPercentagePoints: endUsedPercent - startUsedPercent,
    startUsedUnits: null, endUsedUnits: null, deltaUnits: null,
  });
  const resource = {
    kind: "window", limitUnits: null, limitChanged: false,
    episodes: [episode("reset:a", 75, 100), episode("reset:b", 0, 12), episode("reset:b", 14, 25)],
  } as SessionQuotaContext["resources"][number];

  // A session that ran a window to exhaustion, crossed the reset, and kept going: nothing is
  // summed across the two cycles.
  expect(quotaRemainingRanges(resource)).toEqual(["25→0%", "100→75%"]);
});

test("quotaRemainingRanges reports pool movement only when remaining units can be calculated", () => {
  const resource = (limitChanged: boolean) => ({
    kind: "pool", limitUnits: 1_500, limitChanged,
    episodes: [{
      cycleId: "reset:monthly", startUsedPercent: 10, endUsedPercent: 20,
      deltaPercentagePoints: 10, startUsedUnits: 150, endUsedUnits: 300, deltaUnits: 150,
    }],
  }) as SessionQuotaContext["resources"][number];

  expect(quotaRemainingRanges(resource(false))).toEqual(["1,350→1,200 credits"]);
  expect(quotaRemainingRanges(resource(true))).toEqual([]);
});

test("quotaResetBoundaries reports the window that reset between two adjacent sessions", () => {
  const context = (fiveHourCycle: string) => ({
    provider: "anthropic",
    resources: [
      { id: "fiveHour", endCycleId: fiveHourCycle },
      { id: "weekly", endCycleId: "reset:7000" },
    ],
  }) as SessionQuotaContext;

  expect(quotaResetBoundaries(context("reset:2000"), context("reset:1000"))).toEqual([
    { provider: "anthropic", id: "fiveHour", label: "5-hour", at: 1000 },
  ]);
  expect(quotaResetBoundaries(context("reset:2000"), context("reset:2000"))).toEqual([]);
  // Cross-provider neighbours share no counter, so no boundary is drawn between them.
  const codex = { ...context("reset:1000"), provider: "codex" } as SessionQuotaContext;
  expect(quotaResetBoundaries(context("reset:2000"), codex)).toEqual([]);
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
