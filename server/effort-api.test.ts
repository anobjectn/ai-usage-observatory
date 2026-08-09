import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { db } from "./store";
import * as api from "./effort-api";
import { setEffortEnabled } from "./effort-store";
import type { DashboardData, Session } from "../src/types";

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

function seed(sessionId: string, agent: "claude" | "codex", cwd: string, rows: Array<{ day: string; model: string; effort: string; observations: number; tokens: number }>) {
  db.query("INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size) VALUES (?, ?, ?, ?, ?, 1, 1)")
    .run(sessionId, agent, sessionId, `/tmp/${sessionId}.jsonl`, cwd);
  db.query("INSERT OR REPLACE INTO session_effort_state (session_id, parser_version, source_size, source_mtime, last_offset, resume_hash, coverage_state, last_indexed_at) VALUES (?, 1, 1, 1, 1, 'x', 'partial', 'now')").run(sessionId);
  for (const row of rows) {
    db.query(`INSERT OR REPLACE INTO session_effort_usage (session_id, occurred_on, model, effort, observations, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, row.day, row.model, row.effort, row.observations, row.tokens);
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
    expect(digest.levels[joined[1]]).toBe("high");
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
