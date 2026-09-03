import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { db } from "./store";
import * as api from "./effort-api";
import { setEffortEnabled } from "./effort-store";
import type { DashboardData, EffortComboBoard, EffortComboDayRow, Session } from "../src/types";
import { encodeComboFacet } from "../src/combo";

const today = "2026-07-27";
const yesterday = "2026-07-26";
const old = "2026-01-01";

beforeAll(() => setSystemTime(new Date("2026-07-27T18:00:00.000Z")));
afterAll(() => setSystemTime());

function session(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    agent: "claude",
    period: overrides.sessionId,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 1_000, totalCost: 1,
    modelsUsed: ["claude-opus-5"],
    modelBreakdowns: [{ modelName: "claude-opus-5", inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }],
    metadata: { lastActivity: `${today}T12:00:00.000Z` },
    cwd: "/fixture/alpha",
    pathTags: ["alpha"],
    annotation: { tags: [], note: "" },
    ...overrides,
  } as Session;
}

function snapshotOf(sessions: Session[]): DashboardData {
  const byDay = new Map<string, number>();
  for (const item of sessions) byDay.set(String(item.metadata?.lastActivity).slice(0, 10), (byDay.get(String(item.metadata?.lastActivity).slice(0, 10)) ?? 0) + item.totalTokens);
  return {
    collectedAt: "2026-07-27T18:00:00.000Z",
    sessions,
    daily: [...byDay.entries()].map(([period, totalTokens]) => ({
      agent: "all", period, inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      totalTokens, totalCost: 1, modelsUsed: [], modelBreakdowns: [],
      agents: [{ agent: "claude", period, inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens, totalCost: 1, modelsUsed: [], modelBreakdowns: [] }],
    })),
  } as unknown as DashboardData;
}

type SeedRow = {
  day: string;
  model: string;
  effort: string;
  observations: number;
  tokens: number;
  /** Reasoning fields default to "provider reported nothing", which is the `null` share case. */
  outputTokens?: number;
  reasoningOutputTokens?: number;
  reasoningReportedEvents?: number;
};

function seed(sessionId: string, agent: "claude" | "codex", cwd: string, rows: SeedRow[]) {
  db.query("INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size) VALUES (?, ?, ?, ?, ?, 1, 1)")
    .run(sessionId, agent, sessionId, `/tmp/${sessionId}.jsonl`, cwd);
  db.query("INSERT OR REPLACE INTO session_effort_state (session_id, parser_version, source_size, source_mtime, last_offset, resume_hash, coverage_state, last_indexed_at) VALUES (?, 1, 1, 1, 1, 'x', 'partial', 'now')").run(sessionId);
  for (const row of rows) {
    db.query(`INSERT OR REPLACE INTO session_effort_usage (session_id, occurred_on, model, effort, observations, total_tokens, output_tokens, reasoning_output_tokens, reasoning_reported_events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, row.day, row.model, row.effort, row.observations, row.tokens, row.outputTokens ?? 0, row.reasoningOutputTokens ?? 0, row.reasoningReportedEvents ?? 0);
  }
}

const params = (query: string) => new URLSearchParams(query);

beforeEach(() => {
  db.query("DELETE FROM session_effort_usage").run();
  db.query("DELETE FROM session_effort_state").run();
  db.query("DELETE FROM session_paths").run();
  api.clearEffortMemo();
  setEffortEnabled(true);
});

describe("scope validation", () => {
  test("rejects unsupported values instead of trusting the query string", () => {
    const scope = api.resolveEffortScope(params("basis=nonsense&rangeDays=-4&providers=hacked&effort=drop%20table"));
    expect(scope).toMatchObject({ basis: "timeline", rangeDays: null, providers: [], modelFamilies: [], effort: "all" });
    expect(api.resolveEffortGroup("nonsense")).toBe("total");
    expect(api.resolveEffortGroup("project")).toBe("project");
  });

  test("accepts the documented facet forms", () => {
    expect(api.resolveEffortScope(params("effort=value:xhigh")).effort).toBe("value:xhigh");
    expect(api.resolveEffortScope(params("effort=mixed")).effort).toBe("mixed");
    expect(api.resolveEffortScope(params("effort=unknown")).effort).toBe("unknown");
  });

  test("accepts valid inclusive bounds and drops an invalid pair", () => {
    expect(api.resolveEffortScope(params("from=2026-07-01&to=2026-07-10"))).toMatchObject({
      fromDate: "2026-07-01",
      toDate: "2026-07-10",
    });
    expect(api.resolveEffortScope(params("from=2026-07-10&to=2026-07-01"))).toMatchObject({
      fromDate: null,
      toDate: null,
    });
  });

  test("a path-tag scope cannot alter SQL", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", pathTags: ["a'); DROP TABLE session_effort_usage;--"] })]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    const scope = api.resolveEffortScope(params("pathTag=a%27)%3B%20DROP%20TABLE%20session_effort_usage%3B--"));
    expect(api.buildEffortAggregate(snapshot, scope, "total").total.attributedTokens).toBe(400);
    expect(db.query("SELECT COUNT(*) AS count FROM session_effort_usage").get()).toMatchObject({ count: 1 });
  });
});

describe("scoped denominators", () => {
  test("known plus unknown equals the eligible total", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 3, tokens: 600 },
      { day: today, model: "claude-opus-5", effort: "", observations: 2, tokens: 100 },
    ]);
    const summary = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "total").total;
    expect(summary.eligibleTokens).toBe(1_000);
    expect(summary.attributedTokens).toBe(600);
    expect(summary.unknownTokens).toBe(400);
    expect(summary.unknownObservations).toBe(2);
    expect(summary.observationCoverage).toBeCloseTo(3 / 5, 10);
    expect(summary.coverageState).toBe("partial");
  });

  test("each grouping carries its own denominator", () => {
    const sessions = [
      session({ sessionId: "s1", cwd: "/fixture/alpha", totalTokens: 1_000 }),
      session({ sessionId: "s2", cwd: "/fixture/beta", totalTokens: 3_000, agent: "codex", modelsUsed: ["gpt-5.4"], modelBreakdowns: [{ modelName: "gpt-5.4", inputTokens: 3_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }] }),
    ];
    const snapshot = snapshotOf(sessions);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 2, tokens: 500 }]);
    seed("s2", "codex", "/fixture/beta", [{ day: today, model: "gpt-5.4", effort: "low", observations: 4, tokens: 1_500 }]);

    const byProject = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "project");
    expect(byProject.rows.map((row) => [row.key, row.summary.eligibleTokens, row.summary.attributedTokens])).toEqual([
      ["/fixture/beta", 3_000, 1_500],
      ["/fixture/alpha", 1_000, 500],
    ]);

    const byModel = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "model");
    expect(byModel.rows.find((row) => row.key === "gpt-5.4")!.summary.eligibleTokens).toBe(3_000);

    const byProvider = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "provider");
    expect(byProvider.rows.map((row) => [row.key, row.summary.eligibleTokens])).toEqual([["codex", 3_000], ["claude", 1_000]]);
    expect(byProvider.total.eligibleTokens).toBe(4_000);
  });

  test("a provider scope narrows both the numerator and the denominator", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1" }),
      session({ sessionId: "s2", agent: "codex", totalTokens: 3_000 }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 1, tokens: 400 }]);
    seed("s2", "codex", "/fixture/alpha", [{ day: today, model: "m", effort: "low", observations: 1, tokens: 900 }]);
    const codex = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("providers=codex")), "total").total;
    expect(codex.eligibleTokens).toBe(3_000);
    expect(codex.attributedTokens).toBe(900);
    expect(codex.levels.map((level) => level.effort)).toEqual(["low"]);
  });

  test("a model-family scope keeps only sessions that used that family", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", modelsUsed: ["claude-opus-5"], modelBreakdowns: [{ modelName: "claude-opus-5", inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }] }),
      session({ sessionId: "s2", modelsUsed: ["claude-sonnet-5"], modelBreakdowns: [{ modelName: "claude-sonnet-5-20260114", inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }], totalTokens: 2_000 }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 1, tokens: 400 }]);
    seed("s2", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "low", observations: 1, tokens: 900 }]);
    const scope = api.resolveEffortScope(params("modelFamilies=claude-sonnet-5"));
    expect(scope.modelFamilies).toEqual(["claude-sonnet-5"]);
    const filtered = api.scopedSessions(snapshot, scope);
    expect(filtered.map((session) => session.sessionId)).toEqual(["s2"]);
    const summary = api.buildEffortAggregate(snapshot, scope, "total").total;
    expect(summary.eligibleTokens).toBe(2_000);
    expect(summary.attributedTokens).toBe(900);
  });

  test("a provider and a model from another provider are unioned, not intersected", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", modelsUsed: ["claude-opus-5"], modelBreakdowns: [{ modelName: "claude-opus-5", inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }] }),
      session({ sessionId: "s2", agent: "codex", modelsUsed: ["gpt-5.6-sol"], modelBreakdowns: [{ modelName: "gpt-5.6-sol", inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }] }),
      session({ sessionId: "s3", agent: "codex", modelsUsed: ["gpt-5.5"], modelBreakdowns: [{ modelName: "gpt-5.5", inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 }] }),
    ]);
    const scope = api.resolveEffortScope(params("providers=anthropic&modelFamilies=gpt-5.6-sol"));
    // The Claude session plus the one named Codex model — never the empty intersection of the two.
    expect(api.scopedSessions(snapshot, scope).map((session) => session.sessionId)).toEqual(["s1", "s2"]);
    expect(api.scopedSessions(snapshot, api.resolveEffortScope(params(""))).map((session) => session.sessionId))
      .toEqual(["s1", "s2", "s3"]);
  });

  test("attributed tokens above the denominator degrade instead of rendering a share", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", totalTokens: 100 })]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 1, tokens: 900 }]);
    const summary = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "total").total;
    expect(summary.reconciliationDeltaTokens).toBe(800);
    expect(summary.quality).toBe("degraded");
    expect(summary.levels[0].tokenShare).toBeNull();
    expect(summary.unknownTokens).toBeNull();
  });
});

describe("timeline and session bases", () => {
  const build = () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", metadata: { lastActivity: `${today}T12:00:00.000Z` }, totalTokens: 1_000 })]);
    // One session whose derived rows straddle the range boundary.
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "m", effort: "high", observations: 2, tokens: 300 },
      { day: old, model: "m", effort: "low", observations: 5, tokens: 500 },
    ]);
    return snapshot;
  };

  test("timeline restricts calendar activity to the range", () => {
    const summary = api.buildEffortAggregate(build(), api.resolveEffortScope(params("basis=timeline&rangeDays=7")), "total").total;
    expect(summary.attributedTokens).toBe(300);
    expect(summary.levels.map((level) => level.effort)).toEqual(["high"]);
  });

  test("sessions basis takes the whole selected session, including older days", () => {
    const summary = api.buildEffortAggregate(build(), api.resolveEffortScope(params("basis=sessions&rangeDays=7")), "total").total;
    expect(summary.attributedTokens).toBe(800);
    expect(summary.levels.map((level) => level.effort)).toEqual(["low", "high"]);
  });

  test("timeline applies both custom endpoints inclusively", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", metadata: { lastActivity: `${yesterday}T12:00:00.000Z` } }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: old, model: "claude-opus-5", effort: "low", observations: 1, tokens: 200 },
      { day: yesterday, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 },
      { day: today, model: "claude-opus-5", effort: "xhigh", observations: 1, tokens: 600 },
    ]);
    const summary = api.buildEffortAggregate(
      snapshot,
      api.resolveEffortScope(params(`basis=timeline&from=${yesterday}&to=${yesterday}`)),
      "total",
    ).total;
    expect(summary.attributedTokens).toBe(400);
  });

  test("day rows are ordered and use the daily denominators", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", metadata: { lastActivity: `${today}T12:00:00.000Z` }, totalTokens: 1_000 }),
      session({ sessionId: "s2", metadata: { lastActivity: `${yesterday}T12:00:00.000Z` }, totalTokens: 2_000 }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 1, tokens: 400 }]);
    seed("s2", "claude", "/fixture/alpha", [{ day: yesterday, model: "m", effort: "low", observations: 1, tokens: 800 }]);
    const rows = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "day").rows;
    expect(rows.map((row) => [row.key, row.summary.eligibleTokens, row.summary.attributedTokens])).toEqual([
      [yesterday, 2_000, 800],
      [today, 1_000, 400],
    ]);
  });

  test("project-day denominators use project activity instead of last-session allocation", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", cwd: "/fixture/alpha", totalTokens: 1_000 }),
    ]);
    snapshot.projectActivity = [
      { date: yesterday, provider: "anthropic", projectId: "/fixture/alpha", projectName: "alpha", tokens: 400, cost: 1, sessions: 1, models: [] },
      { date: today, provider: "anthropic", projectId: "/fixture/alpha", projectName: "alpha", tokens: 600, cost: 1, sessions: 1, models: [] },
    ];
    seed("s1", "claude", "/fixture/alpha", [
      { day: yesterday, model: "m", effort: "low", observations: 1, tokens: 300 },
      { day: today, model: "m", effort: "high", observations: 1, tokens: 500 },
    ]);
    const scope = api.resolveEffortScope(params("basis=timeline&project=%2Ffixture%2Falpha"));
    expect(api.buildEffortAggregate(snapshot, scope, "day").rows.map((row) => [
      row.key,
      row.summary.eligibleTokens,
      row.summary.attributedTokens,
    ])).toEqual([
      [yesterday, 400, 300],
      [today, 600, 500],
    ]);
  });
});

describe("model × effort by day", () => {
  const bucketOf = (row: EffortComboDayRow, family: string, effort: string) =>
    row.buckets.find((bucket) => bucket.family === family && bucket.effort === effort);

  test("combo days reconcile against the same day totals as effort-only days", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", metadata: { lastActivity: `${today}T12:00:00.000Z` }, totalTokens: 1_000 }),
      session({ sessionId: "s2", metadata: { lastActivity: `${yesterday}T12:00:00.000Z` }, totalTokens: 2_000 }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    seed("s2", "claude", "/fixture/alpha", [{ day: yesterday, model: "claude-opus-5", effort: "low", observations: 1, tokens: 800 }]);
    const scope = api.resolveEffortScope(params(""));
    const effortOnly = api.buildEffortAggregate(snapshot, scope, "day").rows;
    const combos = api.buildEffortComboDays(snapshot, scope).rows;
    expect(combos.map((row) => [row.key, row.coverage.eligibleTokens, row.coverage.attributedTokens, row.coverage.unknownTokens]))
      .toEqual(effortOnly.map((row) => [row.key, row.summary.eligibleTokens, row.summary.attributedTokens, row.summary.unknownTokens]));
  });

  test("raw release variants collapse into one family bucket per day", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", totalTokens: 1_000 })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5-20260114", effort: "high", observations: 2, tokens: 300 },
      { day: today, model: "claude-opus-5-latest", effort: "high", observations: 1, tokens: 200 },
    ]);
    const [row] = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params(""))).rows;
    expect(row.buckets).toHaveLength(1);
    expect(row.buckets[0]).toMatchObject({ family: "claude-opus-5", effort: "high", tokens: 500, observations: 3, kind: "interactive" });
  });

  test("a denominator-only day is all-unknown coverage rather than a missing day", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", metadata: { lastActivity: `${today}T12:00:00.000Z` }, totalTokens: 1_000 }),
      session({ sessionId: "s2", metadata: { lastActivity: `${yesterday}T12:00:00.000Z` }, totalTokens: 2_000 }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    seed("s2", "claude", "/fixture/alpha", []);
    const rows = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params(""))).rows;
    const blank = rows.find((row) => row.key === yesterday)!;
    expect(blank.buckets).toEqual([]);
    expect(blank.suppressed).toBe(false);
    expect(blank.coverage).toMatchObject({ eligibleTokens: 2_000, attributedTokens: 0, unknownTokens: 2_000, tokenCoverage: 0 });
  });

  test("an over-attributed day suppresses completely rather than per cell", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", totalTokens: 100 })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 900 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 10 },
    ]);
    const [row] = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params(""))).rows;
    expect(row.suppressed).toBe(true);
    expect(row.buckets).toHaveLength(2);
    expect(row.coverage.unknownTokens).toBeNull();
    expect(row.coverage.tokenCoverage).toBeNull();
  });

  test("a reported zero reasoning share is zero; unsupported reporting is null", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", totalTokens: 10_000 })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400, outputTokens: 200, reasoningOutputTokens: 0, reasoningReportedEvents: 3 },
      { day: today, model: "gpt-5.6-sol", effort: "high", observations: 1, tokens: 400, outputTokens: 200, reasoningOutputTokens: 0, reasoningReportedEvents: 0 },
      { day: today, model: "claude-sonnet-5", effort: "low", observations: 1, tokens: 400, outputTokens: 200, reasoningOutputTokens: 50, reasoningReportedEvents: 2 },
    ]);
    const [row] = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params(""))).rows;
    expect(bucketOf(row, "claude-opus-5", "high")!.reasoningShare).toBe(0);
    expect(bucketOf(row, "gpt-5.6-sol", "high")!.reasoningShare).toBeNull();
    expect(bucketOf(row, "claude-sonnet-5", "low")!.reasoningShare).toBeCloseTo(0.25, 10);
  });

  test("non-interactive activity keeps its volume and its own kind", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", totalTokens: 10_000 })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "<synthetic>", effort: "high", observations: 1, tokens: 100 },
      { day: today, model: "codex-auto-review", effort: "low", observations: 1, tokens: 200 },
      { day: today, model: "", effort: "", observations: 4, tokens: 300 },
    ]);
    const [row] = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params(""))).rows;
    expect(row.buckets.map((bucket) => [bucket.family, bucket.kind, bucket.tokens]).sort())
      .toEqual([["<synthetic>", "synthetic", 100], ["codex-auto-review", "automated", 200], ["unknown", "unknown", 300]].sort());
    // Unknown-model activity stays in the coverage denominator, never in attributed tokens.
    expect(row.coverage.attributedTokens).toBe(300);
    expect(row.coverage.unknownObservations).toBe(4);
  });

  test("scope filters narrow numerator and denominator together", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", cwd: "/fixture/alpha", totalTokens: 1_000 }),
      session({ sessionId: "s2", cwd: "/fixture/beta", agent: "codex", totalTokens: 3_000 }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    seed("s2", "codex", "/fixture/beta", [{ day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 900 }]);
    const codex = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params("providers=codex")));
    expect(codex.total).toMatchObject({ eligibleTokens: 3_000, attributedTokens: 900 });
    expect(codex.rows[0].buckets.map((bucket) => bucket.family)).toEqual(["gpt-5.6-sol"]);
  });

  test("disabled indexing reports the denominator and no derived rows", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    setEffortEnabled(false);
    const days = api.buildEffortComboDays(snapshot, api.resolveEffortScope(params("")));
    expect(days.rows).toEqual([]);
    expect(days.total.eligibleTokens).toBe(1_000);
    expect(days.status.phase).toBe("disabled");
  });
});

describe("the combo scoreboard", () => {
  const rowFor = (board: EffortComboBoard, family: string, effort: string) =>
    board.rows.find((row) => row.family === family && row.effort === effort);
  const board = (snapshot: DashboardData, query = "") => api.buildEffortComboBoard(snapshot, api.resolveEffortScope(params(query)));

  test("a session with one combo leads it; a token tie leads nothing", () => {
    const snapshot = snapshotOf([session({ sessionId: "solo" }), session({ sessionId: "tied" })]);
    seed("solo", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    seed("tied", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 300 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 300 },
    ]);
    const result = board(snapshot);
    expect(result.tiedSessions).toBe(1);
    expect(rowFor(result, "claude-opus-5", "high")).toMatchObject({ sessionsAppeared: 2, sessionsLed: 1, tiesExcluded: 1 });
    expect(rowFor(result, "gpt-5.6-sol", "low")).toMatchObject({ sessionsAppeared: 1, sessionsLed: 0, tiesExcluded: 1 });
  });

  test("observations decide only when nothing was attributed, and only uniquely", () => {
    const snapshot = snapshotOf([session({ sessionId: "obs" }), session({ sessionId: "zero" })]);
    seed("obs", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 5, tokens: 0 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 2, tokens: 0 },
    ]);
    seed("zero", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "low", observations: 0, tokens: 0 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 0, tokens: 0 },
    ]);
    const result = board(snapshot);
    expect(rowFor(result, "claude-opus-5", "high")!.sessionsLed).toBe(1);
    expect(rowFor(result, "claude-opus-5", "low")!.sessionsLed).toBe(0);
    expect(result.tiedSessions).toBe(1);
  });

  test("family aliases merge before leadership and aggregation", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5-20260114", effort: "high", observations: 1, tokens: 300 },
      { day: today, model: "claude-opus-5-latest", effort: "high", observations: 1, tokens: 300 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 500 },
    ]);
    const result = board(snapshot);
    // Unmerged, the two aliases would each be 300 and Sol would lead with 500.
    expect(rowFor(result, "claude-opus-5", "high")).toMatchObject({ tokens: 600, sessionsAppeared: 1, sessionsLed: 1 });
    expect(result.rows.filter((row) => row.family === "claude-opus-5")).toHaveLength(1);
    expect(result.tiedSessions).toBe(0);
  });

  const flagCohort = (verdicts: Array<"good" | "mixed" | "bad" | null> = [], coldCache = 6) => {
    const sessions = Array.from({ length: 6 }, (_, index) => session({
      sessionId: `f${index}`,
      totalTokens: 200_000,
      totalCost: index + 1,
      inputTokens: 1_000,
      outputTokens: 1_000,
      // Cache written and never read is the `cold-cache` rule; the last sessions opt out of it.
      cacheCreationTokens: index < coldCache ? 60_000 : 0,
      cacheReadTokens: index < coldCache ? 0 : 60_000,
      annotation: { tags: [], note: "", verdict: verdicts[index] ?? null },
    }));
    const snapshot = snapshotOf(sessions);
    for (const item of sessions) {
      seed(item.sessionId, "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 1_000 }]);
    }
    return snapshot;
  };

  test("flag rate counts each led session once over the untruncated finding set", () => {
    const result = board(flagCohort([], 5));
    const row = rowFor(result, "claude-opus-5", "high")!;
    expect(row.sessionsLed).toBe(6);
    expect(row.flagRate).toBeCloseTo(5 / 6, 10);
    expect(row.medianCostPerLedSession).toBe(3.5);
    expect(row.medianTokensPerLedSession).toBe(200_000);
  });

  test("comparisons below the led-session floor say nothing rather than guessing", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400 }]);
    expect(rowFor(board(snapshot), "claude-opus-5", "high")).toMatchObject({
      sessionsLed: 1,
      medianTokensPerLedSession: null,
      medianCostPerLedSession: null,
      flagRate: null,
    });
  });

  test("the verdict rate has its own floor, independent of the led-session floor", () => {
    const four = rowFor(board(flagCohort(["good", "good", "bad", "mixed"])), "claude-opus-5", "high")!;
    expect(four.sessionsLed).toBe(6);
    expect(four.verdict).toMatchObject({ rated: 4, good: 2, mixed: 1, bad: 1, goodRate: null });
    const five = rowFor(board(flagCohort(["good", "good", "good", "bad", "mixed"])), "claude-opus-5", "high")!;
    expect(five.verdict).toMatchObject({ rated: 5, goodRate: 0.6 });
  });

  test("non-interactive rows keep their volume but make no comparisons", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session({ sessionId: `a${index}`, totalTokens: 1_000_000 }));
    const snapshot = snapshotOf(sessions);
    for (const item of sessions) {
      seed(item.sessionId, "claude", "/fixture/alpha", [{ day: today, model: "codex-auto-review", effort: "low", observations: 1, tokens: 900_000 }]);
    }
    const row = rowFor(board(snapshot), "codex-auto-review", "low")!;
    expect(row).toMatchObject({ kind: "automated", tokens: 5_400_000, sessionsLed: 6 });
    expect(row.medianTokensPerLedSession).toBeNull();
    expect(row.medianCostPerLedSession).toBeNull();
    expect(row.flagRate).toBeNull();
  });

  test("top projects follow this combo's own attributed tokens", () => {
    const snapshot = snapshotOf([
      session({ sessionId: "s1", cwd: "/fixture/alpha" }),
      session({ sessionId: "s2", cwd: "/fixture/beta" }),
    ]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 100 }]);
    seed("s2", "claude", "/fixture/beta", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 800 }]);
    expect(rowFor(board(snapshot), "claude-opus-5", "high")!.projects)
      .toEqual([{ projectId: "/fixture/beta", tokens: 800 }, { projectId: "/fixture/alpha", tokens: 100 }]);
  });

  test("a reported zero reasoning share survives aggregation as zero, not null", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1", totalTokens: 10_000 })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 400, outputTokens: 100, reasoningOutputTokens: 0, reasoningReportedEvents: 4 },
      { day: today, model: "gpt-5.6-sol", effort: "high", observations: 1, tokens: 400, outputTokens: 100, reasoningOutputTokens: 0, reasoningReportedEvents: 0 },
    ]);
    const result = board(snapshot);
    expect(rowFor(result, "claude-opus-5", "high")!.reasoningShare).toBe(0);
    expect(rowFor(result, "gpt-5.6-sol", "high")!.reasoningShare).toBeNull();
  });
});

describe("the combo facet", () => {
  const build = () => {
    const snapshot = snapshotOf([session({ sessionId: "both" }), session({ sessionId: "opus" }), session({ sessionId: "sol" })]);
    seed("both", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5-20260114", effort: "high", observations: 1, tokens: 100 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 100 },
    ]);
    seed("opus", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 100 }]);
    seed("sol", "codex", "/fixture/alpha", [{ day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 100 }]);
    return snapshot;
  };
  const facet = (value: string) => `effort=${encodeURIComponent(value)}`;
  const opusHigh = encodeComboFacet({ family: "claude-opus-5", effort: "high" });

  test("a combo value survives scope resolution; a malformed one falls back to all", () => {
    expect(api.resolveEffortScope(params(facet(opusHigh))).effort).toBe(opusHigh);
    expect(api.resolveEffortScope(params(facet("combo:not-json"))).effort).toBe("all");
    expect(api.resolveEffortScope(params(facet('combo:["only-one"]'))).effort).toBe("all");
  });

  test("selecting a combo selects sessions, and those sessions keep their other combos", () => {
    const snapshot = build();
    const scope = api.resolveEffortScope(params(facet(opusHigh)));
    expect([...api.sessionsMatchingEffortFacet(snapshot, scope)!].sort()).toEqual(["both", "opus"]);
    // `both` also recorded Sol · Low, and that must still be reported downstream.
    const rows = api.buildEffortComboBoard(snapshot, scope).rows;
    expect(rows.map((row) => `${row.family}/${row.effort}`).sort()).toEqual(["claude-opus-5/high", "gpt-5.6-sol/low"]);
    expect(rows.find((row) => row.family === "gpt-5.6-sol")!.tokens).toBe(100);
  });

  test("aliases resolve to the same combo selection", () => {
    const snapshot = build();
    expect([...api.sessionsMatchingEffortFacet(snapshot, api.resolveEffortScope(params(facet(opusHigh))))!].sort())
      .toEqual(["both", "opus"]);
  });

  test("a well-formed combo nobody recorded selects nothing rather than everything", () => {
    const snapshot = build();
    const scope = api.resolveEffortScope(params(facet(encodeComboFacet({ family: "claude-opus-5", effort: "max" }))));
    expect([...api.sessionsMatchingEffortFacet(snapshot, scope)!]).toEqual([]);
  });

  test("effort-only facet forms keep working beside combo ones", () => {
    const snapshot = build();
    const facetIds = (value: string) => [...api.sessionsMatchingEffortFacet(snapshot, api.resolveEffortScope(params(facet(value))))!].sort();
    expect(facetIds("value:high")).toEqual(["both", "opus"]);
    expect(facetIds("mixed")).toEqual(["both"]);
  });
});

describe("digest v2", () => {
  test("mixed effort and multiple combos are recorded as separate flags", () => {
    const snapshot = snapshotOf([session({ sessionId: "twoModels" }), session({ sessionId: "twoEfforts" })]);
    seed("twoModels", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 300 },
      { day: today, model: "gpt-5.6-sol", effort: "high", observations: 1, tokens: 100 },
    ]);
    seed("twoEfforts", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 1, tokens: 300 },
      { day: today, model: "claude-opus-5", effort: "low", observations: 1, tokens: 100 },
    ]);
    const digest = api.buildEffortSessionDigest(snapshot, api.resolveEffortScope(params("")));
    const models = digest.rows.find((row) => row[0] === "twoModels")!;
    const efforts = digest.rows.find((row) => row[0] === "twoEfforts")!;
    expect(models[2] & 1).toBe(0);
    expect(models[2] & 8).toBe(8);
    expect(efforts[2] & 1).toBe(1);
    expect(efforts[2] & 8).toBe(8);
  });

  test("the dominant display combo names its model, and aliases collapse first", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5-20260114", effort: "high", observations: 1, tokens: 200 },
      { day: today, model: "claude-opus-5-latest", effort: "high", observations: 1, tokens: 200 },
      { day: today, model: "gpt-5.6-sol", effort: "low", observations: 1, tokens: 300 },
    ]);
    const digest = api.buildEffortSessionDigest(snapshot, api.resolveEffortScope(params("")));
    const [familyIndex, effortIndex] = digest.combos[digest.rows[0][1]];
    expect(digest.families[familyIndex]).toBe("claude-opus-5");
    expect(digest.efforts[effortIndex]).toBe("high");
  });
});

describe("session digest and detail", () => {
  test("unjoinable sessions stay in the digest as Unknown", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" }), session({ sessionId: "missing" })]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 2, tokens: 600 }]);
    const digest = api.buildEffortSessionDigest(snapshot, api.resolveEffortScope(params("")));
    expect(digest.rows).toHaveLength(2);
    const unjoinable = digest.rows.find((row) => row[0] === "missing")!;
    expect(unjoinable[1]).toBe(-1);
    expect(unjoinable[2] & 4).toBe(4);
    const joined = digest.rows.find((row) => row[0] === "s1")!;
    expect(digest.version).toBe(2);
    expect(digest.combos[joined[1]]).toEqual([0, 0, "interactive"]);
    expect(digest.families[digest.combos[joined[1]][0]]).toBe("m");
    expect(digest.efforts[digest.combos[joined[1]][1]]).toBe("high");
    expect(joined[3]).toBe(600);
  });

  test("mixed sessions are flagged and keep every value in detail", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "m", effort: "high", observations: 2, tokens: 600 },
      { day: today, model: "m", effort: "low", observations: 1, tokens: 100 },
    ]);
    const digest = api.buildEffortSessionDigest(snapshot, api.resolveEffortScope(params("")));
    expect(digest.rows[0][2] & 1).toBe(1);
    const detail = api.buildSessionEffortSummary(snapshot, "s1")!;
    expect(detail.levels.map((level) => level.effort)).toEqual(["low", "high"]);
    expect(detail.dominant).toBe("high");
    expect(detail.dominantBasis).toBe("tokens");
  });

  test("session detail is null when nothing was derived", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    expect(api.buildSessionEffortSummary(snapshot, "s1")).toBeNull();
  });

  test("reasoning evidence is null unless a usage event reported it, and an honest zero stays a zero", () => {
    const snapshot = snapshotOf([session({ sessionId: "claude" }), session({ sessionId: "codex-zero", agent: "codex" }), session({ sessionId: "codex", agent: "codex" })]);
    seed("claude", "claude", "/fixture/alpha", [{ day: today, model: "claude-opus-5", effort: "high", observations: 2, tokens: 600, outputTokens: 200 }]);
    seed("codex-zero", "codex", "/fixture/alpha", [{ day: today, model: "gpt-5.5", effort: "high", observations: 1, tokens: 300, outputTokens: 50, reasoningOutputTokens: 0, reasoningReportedEvents: 1 }]);
    seed("codex", "codex", "/fixture/alpha", [
      { day: today, model: "gpt-5.5", effort: "high", observations: 2, tokens: 900, outputTokens: 400, reasoningOutputTokens: 150, reasoningReportedEvents: 2 },
      { day: today, model: "gpt-5.5", effort: "", observations: 1, tokens: 100, outputTokens: 40, reasoningOutputTokens: 10, reasoningReportedEvents: 1 },
    ]);
    expect(api.buildSessionEffortSummary(snapshot, "claude")!.reasoning).toBeNull();
    expect(api.buildSessionEffortSummary(snapshot, "codex-zero")!.reasoning).toEqual({ outputTokens: 50, reasoningOutputTokens: 0, reportedEvents: 1 });
    // Unrecorded-effort rows still count: the evidence is about output, not effort.
    expect(api.buildSessionEffortSummary(snapshot, "codex")!.reasoning).toEqual({ outputTokens: 440, reasoningOutputTokens: 160, reportedEvents: 3 });
    const byModel = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "model");
    expect(byModel.rows.find((row) => row.key === "claude-opus-5")!.summary.reasoning).toBeNull();
    expect(byModel.rows.find((row) => row.key === "gpt-5.5")!.summary.reasoning).toEqual({ outputTokens: 490, reasoningOutputTokens: 160, reportedEvents: 4 });
    const total = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "total");
    expect(total.rows[0].summary.reasoning).toEqual({ outputTokens: 690, reasoningOutputTokens: 160, reportedEvents: 4 });
  });

  test("session combos keep model and effort together, including unrecorded effort", () => {
    snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [
      { day: today, model: "claude-opus-5", effort: "high", observations: 2, tokens: 600 },
      { day: today, model: "claude-opus-5", effort: "", observations: 1, tokens: 40 },
      { day: today, model: "claude-sonnet-5", effort: "low", observations: 1, tokens: 100 },
    ]);
    const combos = api.buildSessionEffortCombos("s1")!;
    expect(combos.map((combo) => [combo.model, combo.effort, combo.tokens, combo.observations])).toEqual([
      ["claude-opus-5", "high", 600, 2],
      ["claude-sonnet-5", "low", 100, 1],
      ["claude-opus-5", "", 40, 1],
    ]);
    expect(combos[0].family).toBe("claude-opus-5");
    expect(api.buildSessionEffortCombos("missing")).toBeNull();
  });
});

describe("the Data effort facet", () => {
  const build = () => {
    const snapshot = snapshotOf([session({ sessionId: "mixed" }), session({ sessionId: "single" }), session({ sessionId: "none" })]);
    seed("mixed", "claude", "/fixture/alpha", [
      { day: today, model: "m", effort: "high", observations: 1, tokens: 100 },
      { day: today, model: "m", effort: "low", observations: 1, tokens: 100 },
    ]);
    seed("single", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 1, tokens: 100 }]);
    seed("none", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "", observations: 1, tokens: 100 }]);
    return snapshot;
  };

  test("selects sessions by value, mixed, and unknown", () => {
    const snapshot = build();
    const facet = (value: string) => [...api.sessionsMatchingEffortFacet(snapshot, api.resolveEffortScope(params(`effort=${encodeURIComponent(value)}`)))!].sort();
    expect(facet("value:high")).toEqual(["mixed", "single"]);
    expect(facet("value:low")).toEqual(["mixed"]);
    expect(facet("mixed")).toEqual(["mixed"]);
    expect(facet("unknown")).toEqual(["none"]);
    expect(api.sessionsMatchingEffortFacet(snapshot, api.resolveEffortScope(params("effort=all")))).toBeNull();
  });
});

describe("index state and isolation", () => {
  test("disabled indexing reports the eligible denominator and no derived analysis", () => {
    const snapshot = snapshotOf([session({ sessionId: "s1" })]);
    seed("s1", "claude", "/fixture/alpha", [{ day: today, model: "m", effort: "high", observations: 1, tokens: 400 }]);
    setEffortEnabled(false);
    const aggregate = api.buildEffortAggregate(snapshot, api.resolveEffortScope(params("")), "total");
    expect(aggregate.status.phase).toBe("disabled");
    expect(aggregate.status.quality).toBe("stale");
    expect(aggregate.status.progress).toMatchObject({
      indexedSessions: 1,
      pendingSessions: 0,
      indexedBytes: 1,
      pendingBytes: 0,
    });
    expect(aggregate.rows).toEqual([]);
    expect(aggregate.total.coverageState).toBe("unavailable");
    expect(aggregate.total.eligibleTokens).toBe(1_000);
    expect(api.buildSessionEffortSummary(snapshot, "s1")).toBeNull();
  });

  test("status stays small and free of scope text", () => {
    const status = api.buildEffortStatus();
    expect(JSON.stringify(status).length).toBeLessThan(4 * 1024);
    expect(status.parserVersion).toBeGreaterThan(0);
  });
});

describe("caching", () => {
  test("etags are HTTP-safe and change with snapshot, index, group, and scope", () => {
    const base = ["/api/effort", "2026-07-27T18:00:00.000Z", 1, "day", "timeline|7|all|all|||all"];
    const etag = api.effortEtag(base);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(api.effortEtag(base)).toBe(etag);
    expect(api.effortEtag([...base.slice(0, 1), "2026-07-27T19:00:00.000Z", ...base.slice(2)])).not.toBe(etag);
    expect(api.effortEtag([...base.slice(0, 2), 2, ...base.slice(3)])).not.toBe(etag);
    expect(api.effortEtag([...base.slice(0, 3), "model", ...base.slice(4)])).not.toBe(etag);
    expect(api.effortEtag([...base.slice(0, 4), "timeline|30|all|all|||all"])).not.toBe(etag);
  });

  test("scope keys never leak raw JSON into the header input", () => {
    expect(api.scopeKey(api.resolveEffortScope(params("basis=sessions&rangeDays=30&providers=codex")))).toBe("sessions|30|||codex||all|||all|all");
  });

  test("memoization is bounded and reuses bodies", () => {
    let built = 0;
    const body = () => { built++; return { ok: true }; };
    expect(api.memoizedBody("\"a\"", body)).toBe(api.memoizedBody("\"a\"", body));
    expect(built).toBe(1);
    for (let index = 0; index < 40; index++) api.memoizedBody(`"key-${index}"`, body);
    api.memoizedBody("\"a\"", body);
    expect(built).toBe(42);
  });
});

describe("payload budgets", () => {
  test("a high-cardinality grouping and digest stay inside budget", () => {
    const sessions = Array.from({ length: 1_200 }, (_, index) => session({
      sessionId: `s${index}`,
      cwd: `/fixture/project-${index % 60}`,
      metadata: { lastActivity: `2026-0${(index % 6) + 1}-1${index % 9}T12:00:00.000Z` },
    }));
    const snapshot = snapshotOf(sessions);
    for (const [index, item] of sessions.entries()) {
      seed(item.sessionId, "claude", item.cwd!, [
        { day: String(item.metadata?.lastActivity).slice(0, 10), model: `model-${index % 25}`, effort: ["low", "medium", "high", "xhigh", "turbo"][index % 5], observations: 3, tokens: 400 },
        { day: String(item.metadata?.lastActivity).slice(0, 10), model: `model-${index % 25}`, effort: "", observations: 1, tokens: 100 },
      ]);
    }
    const scope = api.resolveEffortScope(params(""));
    for (const group of ["total", "day", "project", "model", "provider"] as const) {
      const bytes = JSON.stringify(api.buildEffortAggregate(snapshot, scope, group)).length;
      expect(bytes, `group=${group} was ${bytes} bytes`).toBeLessThanOrEqual(150 * 1024);
    }
    const digest = api.buildEffortSessionDigest(snapshot, scope);
    const digestBytes = JSON.stringify(digest.rows).length;
    expect(digestBytes / sessions.length, `digest was ${digestBytes} bytes for ${sessions.length} sessions`).toBeLessThanOrEqual(96);
  });
});
