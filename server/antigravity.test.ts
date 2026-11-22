import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ANTIGRAVITY_SQL,
  antigravityCwd,
  antigravityReadStats,
  antigravityTime,
  collectAntigravity,
  effortFromLabel,
  readProviderDatabase,
  resetAntigravityCache,
} from "./antigravity";
import {
  appendConversation,
  conversationPath,
  fileUri,
  leaveEmptySidecars,
  openLiveWriter,
  removeSidecars,
  writeConversation,
  writeOrphanWal,
  writeSummaries,
  type FixtureConversation,
} from "./antigravity-fixture";
import { getSessionEpisodes } from "./session-evidence";
import { db } from "./store";
import { testAntigravityDirectory } from "./test-setup";

const t0 = Date.UTC(2026, 10, 21, 20, 0, 0);
const second = 1000;
const neonHigh = { modelId: "gemini-4-neon", label: "Gemini 4 Neon (High)" };
const neonLow = { modelId: "gemini-4-neon", label: "Gemini 4 Neon (Low)" };

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "antigravity-test-"));
  resetAntigravityCache();
});

afterEach(() => {
  process.env.ANTIGRAVITY_DATA_DIRS = testAntigravityDirectory;
  rmSync(directory, { recursive: true, force: true });
  resetAntigravityCache();
});

function useRoots(...roots: string[]) {
  process.env.ANTIGRAVITY_DATA_DIRS = roots.join(delimiter);
}

function root(name = "install/antigravity-acp") {
  const path = join(directory, name);
  mkdirSync(join(path, "conversations"), { recursive: true });
  return path;
}

function sidecarsOf(path: string) {
  return { wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) };
}

/** One user step, two model turns at different efforts, a compaction call missing from
 * `gen_metadata`, a repeated message id, and a step without metadata. */
function mixedConversation(): FixtureConversation {
  return {
    steps: [
      { idx: 0, stepType: 14, at: t0 },
      { idx: 1, at: t0 + 5 * second, finishedAt: t0 + 9 * second, usage: { input: 1000, output: 300, thinking: 200, messageId: "m1" } },
      { idx: 2, at: t0 + 60 * second, usage: { input: 50, output: 400, cacheRead: 9000, cacheWrite: 7, thinking: 350, messageId: "m2" } },
      { idx: 3, stepType: 23, at: t0 + 120 * second, usage: { input: 70, output: 80, cacheRead: 5000, messageId: "c1" } },
      { idx: 4, at: t0 + 130 * second, usage: { input: 50, output: 400, cacheRead: 9000, cacheWrite: 7, thinking: 350, messageId: "m2" } },
      { idx: 5, stepType: 132, at: t0 + 140 * second, metadata: null },
    ],
    generations: [
      { idx: 0, usage: { input: 1000, output: 300, thinking: 200, messageId: "m1" }, ...neonHigh },
      { idx: 1, usage: { input: 50, output: 400, cacheRead: 9000, cacheWrite: 7, thinking: 350, messageId: "m2" }, ...neonLow },
    ],
  };
}

function highConversation(at = t0, messagePrefix = "h"): FixtureConversation {
  return {
    steps: [
      { idx: 0, stepType: 14, at },
      { idx: 1, at: at + second, usage: { input: 100, output: 20, thinking: 5, messageId: `${messagePrefix}1` } },
      { idx: 2, stepType: 23, at: at + 2 * second, usage: { input: 10, output: 2, cacheRead: 30, messageId: `${messagePrefix}-compact` } },
    ],
    generations: [{ idx: 0, usage: { input: 100, output: 20, thinking: 5, messageId: `${messagePrefix}1` }, ...neonHigh }],
  };
}

describe("token ledger", () => {
  test("reads every usage step once, splits the buckets, and attributes effort per generation", () => {
    const base = root();
    writeSummaries(base, [{ conversationId: "conv-a", workspaceUris: [fileUri("/Users/someone/Work/my project")], lastModified: "2026-11-21 20:10:00.123456+00:00" }]);
    writeConversation(base, "conv-a", mixedConversation());
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions).toHaveLength(1);
    const session = collected.sessions[0]!;
    expect(session.sessionId).toBe("antigravity-conv-a");
    expect(session.agent).toBe("antigravity");
    expect(session.cwd).toBe("/Users/someone/Work/my project");
    // m1 + m2 + c1; the repeated m2 is the same call.
    expect(session.inputTokens).toBe(1000 + 50 + 70);
    expect(session.outputTokens).toBe(300 + 400 + 80);
    expect(session.cacheReadTokens).toBe(9000 + 5000);
    expect(session.cacheCreationTokens).toBe(7);
    expect(session.totalTokens).toBe(1120 + 780 + 14000 + 7);
    expect(session.totalCost).toBe(0);
    expect(session.antigravity).toMatchObject({ conversationId: "conv-a", generations: 3, reasoningOutputTokens: 550, root: "t3" });
    expect(session.modelBreakdowns).toEqual([{ modelName: "gemini-4-neon", inputTokens: 1120, outputTokens: 780, cacheReadTokens: 14000, cacheCreationTokens: 7, cost: 0 }]);
    expect(session.metadata?.lastActivity).toBe(new Date(t0 + 130 * second).toISOString());
    expect(collected.auxiliaryCalls).toBe(1);
    const effort = collected.effortSources[0]!;
    const byEffort = Object.fromEntries(effort.rows.map((row) => [row.effort, row.observations]));
    // The compaction call ran under an enum that carried two labels, so its effort is unknown.
    expect(byEffort).toEqual({ high: 1, low: 1, "": 1 });
    expect(effort.rows.find((row) => row.effort === "high")).toMatchObject({ reasoningOutputTokens: 200, reasoningReportedEvents: 1, totalTokens: 1300 });
    expect(collected.notes.some((note) => note.includes("without a recognized effort label"))).toBe(true);
  });

  test("gives a call missing from gen_metadata the label its model enum always ran under", () => {
    const base = root();
    writeConversation(base, "conv-b", highConversation());
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.effortSources[0]!.rows.map((row) => [row.effort, row.observations])).toEqual([["high", 2]]);
    expect(collected.notes).toEqual([]);
  });

  test("an enum with no generation row stays an unknown model", () => {
    const base = root();
    writeConversation(base, "conv-c", { steps: [{ idx: 0, at: t0, usage: { modelEnum: 9, input: 5, output: 1, messageId: "x" } }] });
    useRoots(base);
    const session = collectAntigravity("UTC").sessions[0]!;
    expect(session.modelsUsed).toEqual(["Unknown model"]);
  });

  test("reasoning above output is not counted, and a usage record without a model enum is no call", () => {
    const base = root();
    writeConversation(base, "conv-d", {
      steps: [
        { idx: 0, at: t0, usage: { input: 5, output: 10, thinking: 50, messageId: "over" } },
        { idx: 1, at: t0 + second, metadata: null },
      ],
      generations: [{ idx: 0, usage: { input: 5, output: 10, messageId: "over" }, ...neonHigh }],
    });
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions[0]!.antigravity?.reasoningOutputTokens).toBe(0);
    expect(collected.effortSources[0]!.rows[0]!.reasoningReportedEvents).toBe(0);
  });

  test("conversations without usage are placeholders, not sessions", () => {
    const base = root();
    writeSummaries(base, [{ conversationId: "empty", stepCount: 0, lastModified: "0001-01-01 00:00:00+00:00" }]);
    writeConversation(base, "empty", { steps: [{ idx: 0, stepType: 14, at: t0 }] });
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions).toEqual([]);
    expect(collected.available).toBe(true);
  });
});

describe("source fields", () => {
  test("effort labels map only the known vocabulary", () => {
    expect(effortFromLabel("Gemini 4 Neon (High)")).toBe("high");
    expect(effortFromLabel("Gemini 4 Neon (Low)")).toBe("low");
    expect(effortFromLabel("Gemini 4 Argon (Extra High)")).toBe("xhigh");
    expect(effortFromLabel("Gemini 4 Argon (minimal) ")).toBe("minimal");
    expect(effortFromLabel("Gemini 4 Neon (Thinking)")).toBe("");
    expect(effortFromLabel("Gemini 4 Neon High")).toBe("");
    expect(effortFromLabel("gemini-4-neon-high")).toBe("");
    expect(effortFromLabel(null)).toBe("");
  });

  test("the working directory is the first file workspace", () => {
    expect(antigravityCwd(JSON.stringify(["file:///Users/someone/My%20Work/app"]))).toBe("/Users/someone/My Work/app");
    expect(antigravityCwd(JSON.stringify(["vscode-remote://host/x", "file:///tmp/second/", "file:///tmp/third"]))).toBe("/tmp/second");
    expect(antigravityCwd(JSON.stringify(["https://example.com"]))).toBeNull();
    expect(antigravityCwd("not json")).toBeNull();
    expect(antigravityCwd(JSON.stringify({ uri: "file:///tmp" }))).toBeNull();
    expect(antigravityCwd(null)).toBeNull();
  });

  test("summary times drop the Go zero sentinel and read microseconds", () => {
    expect(antigravityTime("0001-01-01 00:00:00+00:00")).toBeNull();
    expect(antigravityTime("2026-11-21 20:28:41.836392+00:00")).toBe("2026-11-21T20:28:41.836Z");
    expect(antigravityTime("2026-11-21 20:28:41+00:00")).toBe("2026-11-21T20:28:41.000Z");
    expect(antigravityTime("")).toBeNull();
  });

  test("activity comes from step times, and a summary time only orders a session", () => {
    const base = root();
    writeSummaries(base, [{ conversationId: "conv-e", lastModified: "2026-11-30 10:00:00+00:00" }]);
    writeConversation(base, "conv-e", mixedConversation());
    useRoots(base);
    const session = collectAntigravity("UTC").sessions[0]!;
    expect(session.metadata?.lastActivity).toBe(new Date(t0 + 130 * second).toISOString());
    expect(session.activityIntervals).toEqual([{ startAt: t0, endAt: t0 + 130 * second }]);
    expect(getSessionEpisodes("antigravity-conv-e")).toEqual(session.activityIntervals!);
  });

  test("a conversation that crosses midnight is split by generation day", () => {
    const base = root();
    const lateEvening = Date.UTC(2026, 10, 21, 23, 59, 0);
    writeConversation(base, "conv-f", {
      steps: [
        { idx: 0, at: lateEvening, usage: { input: 100, output: 10, messageId: "a" } },
        { idx: 1, at: lateEvening + 2 * 60 * second, usage: { input: 200, output: 20, cacheRead: 5, messageId: "b" } },
      ],
      generations: [
        { idx: 0, usage: { input: 100, output: 10, messageId: "a" }, ...neonHigh },
        { idx: 1, usage: { input: 200, output: 20, cacheRead: 5, messageId: "b" }, ...neonHigh },
      ],
    });
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.dailyRows.map((row) => [row.period, row.totalTokens])).toEqual([["2026-11-21", 110], ["2026-11-22", 225]]);
    expect(collected.daily).toEqual([{ date: "2026-11-21", generations: 1, tokens: 110 }, { date: "2026-11-22", generations: 1, tokens: 225 }]);
    expect(collected.effortSources[0]!.rows.map((row) => row.occurredOn)).toEqual(["2026-11-21", "2026-11-22"]);
    expect(collected.sessions[0]!.totalTokens).toBe(335);
  });

  test("a subagent conversation is its own session and is noted", () => {
    const base = root();
    writeSummaries(base, [{ conversationId: "child", parentConversationId: "parent", nestingDepth: 1 }]);
    writeConversation(base, "child", highConversation());
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions[0]!.antigravity?.parentConversationId).toBe("parent");
    expect(collected.subagentConversations).toBe(1);
    expect(collected.notes).toContain("1 subagent conversation counted as separate sessions");
  });
});

describe("opening provider databases", () => {
  test("a closed WAL database without sidecars opens through immutable and stays untouched", () => {
    const base = root();
    const path = writeConversation(base, "closed", highConversation());
    const read = readProviderDatabase(path, (database) => database.query("SELECT count(*) AS n FROM steps").get());
    expect(read).toMatchObject({ ok: true, mode: "immutable", value: { n: 3 } });
    expect(sidecarsOf(path)).toEqual({ wal: false, shm: false });
  });

  test("a leftover empty -wal beside a -shm opens plainly", () => {
    const base = root();
    const path = writeConversation(base, "leftover", highConversation());
    leaveEmptySidecars(path);
    expect(statSync(`${path}-wal`).size).toBe(0);
    const read = readProviderDatabase(path, (database) => database.query("SELECT count(*) AS n FROM steps").get());
    expect(read).toMatchObject({ ok: true, mode: "plain", value: { n: 3 } });
  });

  test("an empty -wal without a -shm is read immutably, so no -shm is created", () => {
    const base = root();
    const path = writeConversation(base, "empty-wal", highConversation());
    writeFileSync(`${path}-wal`, "");
    const read = readProviderDatabase(path, (database) => database.query("SELECT count(*) AS n FROM steps").get());
    expect(read).toMatchObject({ ok: true, mode: "immutable" });
    expect(sidecarsOf(path)).toEqual({ wal: true, shm: false });
  });

  test("a non-empty -wal without a -shm is never opened", () => {
    const base = root();
    const path = writeOrphanWal(base, "orphan", highConversation(), { steps: [{ idx: 9, at: t0 + 60 * second, usage: { input: 1, output: 1, messageId: "late" } }] });
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const read = readProviderDatabase(path, () => "read");
    expect(read).toEqual({ ok: false, reason: "write-ahead log without shared memory" });
    expect(sidecarsOf(path)).toEqual({ wal: true, shm: false });
  });

  test("an open writer's rows that exist only in its -wal are visible", () => {
    const base = root();
    const path = writeConversation(base, "live", highConversation());
    const writer = openLiveWriter(path, { steps: [{ idx: 9, at: t0 + 60 * second, usage: { input: 1, output: 1, messageId: "late" } }] });
    try {
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
      const read = readProviderDatabase(path, (database) => database.query("SELECT count(*) AS n FROM steps").get());
      expect(read).toMatchObject({ ok: true, mode: "plain", value: { n: 4 } });
    } finally {
      writer.close();
    }
  });

  test("an immutable read is discarded when the file changed during it", () => {
    const base = root();
    const path = writeConversation(base, "moving", highConversation());
    const read = readProviderDatabase(path, (database) => {
      database.query("SELECT count(*) FROM steps").get();
      appendConversation(path, { steps: [{ idx: 9, at: t0, usage: { input: 1, output: 1, messageId: "z" } }] });
      return "stale";
    });
    expect(read).toEqual({ ok: false, reason: "the database changed while it was read" });
  });

  test("a path with spaces and non-ASCII characters opens", () => {
    const base = root("Application Support/Antigravity é/antigravity-acp");
    const path = writeConversation(base, "spaced", highConversation());
    expect(readProviderDatabase(path, (database) => database.query("SELECT count(*) AS n FROM steps").get())).toMatchObject({ ok: true, value: { n: 3 } });
    expect(sidecarsOf(path)).toEqual({ wal: false, shm: false });
  });

  test("the collector creates no sidecar anywhere it reads", () => {
    const base = root();
    const summaries = writeSummaries(base, [{ conversationId: "one" }, { conversationId: "two" }]);
    const one = writeConversation(base, "one", highConversation());
    const two = writeConversation(base, "two", highConversation(t0, "t"));
    writeFileSync(`${two}-wal`, "");
    useRoots(base);
    expect(collectAntigravity("UTC").sessions).toHaveLength(2);
    expect([sidecarsOf(summaries), sidecarsOf(one), sidecarsOf(two)]).toEqual([
      { wal: false, shm: false }, { wal: false, shm: false }, { wal: true, shm: false },
    ]);
  });

  test("an unsafe read keeps the last good parse and says so", () => {
    const base = root();
    const path = writeConversation(base, "kept", highConversation());
    useRoots(base);
    expect(collectAntigravity("UTC").sessions[0]!.totalTokens).toBe(120 + 42);
    // A copied log with no index appears beside the file: it cannot be read without creating one.
    removeSidecars(path);
    rmSync(path);
    writeOrphanWal(base, "kept", highConversation(), { steps: [{ idx: 9, at: t0 + 60 * second, usage: { input: 1, output: 1, messageId: "late" } }] });
    const collected = collectAntigravity("UTC");
    expect(collected.sessions[0]!.totalTokens).toBe(162);
    expect(collected.complete).toBe(false);
    expect(collected.notes).toContain("1 database could not be read safely; the last good read is kept");
  });

  test("an unsafe first read skips the conversation", () => {
    const base = root();
    writeOrphanWal(base, "never", highConversation(), { steps: [{ idx: 9, at: t0, usage: { input: 1, output: 1, messageId: "late" } }] });
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions).toEqual([]);
    expect(collected.notes).toHaveLength(1);
  });
});

describe("degraded sources", () => {
  test("missing roots are silent, and no root at all is unavailable", () => {
    useRoots(join(directory, "missing"));
    const collected = collectAntigravity("UTC");
    expect(collected).toMatchObject({ available: false, sessions: [], notes: [] });
    expect(collected.error).toContain("No Antigravity data directory");
  });

  test("missing tables and columns degrade without throwing", () => {
    const base = root();
    writeSummaries(base, [{ conversationId: "no-steps" }], { columns: ["conversation_id TEXT", "title TEXT"] });
    writeConversation(base, "no-steps", { steps: [], stepColumns: ["idx INTEGER", "metadata BLOB"] });
    writeConversation(base, "no-gen", { steps: [{ idx: 0, at: t0, usage: { input: 3, output: 1, messageId: "q" } }], withoutGenerations: true });
    writeFileSync(conversationPath(base, "garbage"), "not a database");
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions.map((session) => session.sessionId)).toEqual(["antigravity-no-gen"]);
    expect(collected.sessions[0]!.modelsUsed).toEqual(["Unknown model"]);
    expect(collected.notes).toContain("2 databases did not match the expected schema");
    expect(collected.notes).toContain("1 database could not be read safely; the last good read is kept");
  });

  test("undecodable step metadata and turns without usage are noted", () => {
    const base = root();
    writeConversation(base, "drift", {
      steps: [
        { idx: 0, at: t0, usage: { input: 3, output: 1, messageId: "q" } },
        { idx: 1, stepType: 15, at: t0 + second },
        { idx: 2, stepType: 14, at: t0, metadata: new Uint8Array([0xff, 0xff, 0xff]) },
      ],
    });
    useRoots(base);
    const collected = collectAntigravity("UTC");
    expect(collected.notes).toContain("1 step could not be decoded");
    expect(collected.notes).toContain("1 model turn carried no readable usage record");
  });

  test("the same conversation in two roots is one session, from the newer copy", () => {
    const t3 = root("t3/antigravity-acp");
    const ide = root("ide");
    writeSummaries(t3, [{ conversationId: "shared", lastModified: "2026-11-21 20:00:00+00:00" }]);
    writeSummaries(ide, [{ conversationId: "shared", lastModified: "2026-11-22 08:00:00+00:00" }]);
    writeConversation(t3, "shared", highConversation());
    writeConversation(ide, "shared", mixedConversation());
    useRoots(t3, ide);
    const collected = collectAntigravity("UTC");
    expect(collected.sessions).toHaveLength(1);
    expect(collected.sessions[0]!.antigravity?.root).toBe("ide");
    expect(collected.sessions[0]!.antigravity?.generations).toBe(3);
    expect(collected.roots).toHaveLength(2);
  });
});

describe("caching", () => {
  test("an unchanged conversation is not read again, and a change is", () => {
    const base = root();
    const path = writeConversation(base, "cached", highConversation());
    useRoots(base);
    collectAntigravity("UTC");
    const first = antigravityReadStats();
    expect(first.conversationReads).toBe(1);
    collectAntigravity("UTC");
    expect(antigravityReadStats().conversationReads).toBe(1);
    appendConversation(path, {
      steps: [{ idx: 3, at: t0 + 10 * second, usage: { input: 9, output: 1, messageId: "h2" } }],
      generations: [{ idx: 1, usage: { input: 9, output: 1, messageId: "h2" }, ...neonLow }],
    });
    const collected = collectAntigravity("UTC");
    expect(antigravityReadStats().conversationReads).toBe(2);
    expect(collected.sessions[0]!.antigravity?.generations).toBe(3);
    // Only the appended generation row is decoded; the earlier one comes from the index.
    expect(antigravityReadStats().generationRows).toBe(first.generationRows + 1);
    expect(collected.effortSources[0]!.rows.map((row) => [row.effort, row.observations])).toEqual([["high", 1], ["", 1], ["low", 1]]);
  });

  test("a rewritten file rebuilds its generation index", () => {
    const base = root();
    const path = writeConversation(base, "rewritten", highConversation());
    useRoots(base);
    collectAntigravity("UTC");
    rmSync(path);
    writeConversation(base, "rewritten", {
      steps: [{ idx: 0, at: t0, usage: { input: 1, output: 1, messageId: "fresh" } }],
      generations: [{ idx: 0, usage: { input: 1, output: 1, messageId: "fresh" }, ...neonLow }],
    });
    const collected = collectAntigravity("UTC");
    expect(collected.effortSources[0]!.rows.map((row) => row.effort)).toEqual(["low"]);
  });
});

test("privacy canary: no content column reaches the collection, the database, or the SQL", () => {
  const canary = `CANARY-${crypto.randomUUID()}`;
  const base = root();
  writeSummaries(base, [{ conversationId: "secret", title: canary, preview: canary, rawSummary: canary, workspaceUris: [fileUri("/tmp/project")] }]);
  const conversation = mixedConversation();
  conversation.steps = conversation.steps.map((step) => ({ ...step, payload: canary }));
  conversation.generations = conversation.generations!.map((generation) => ({ ...generation, filler: `${canary}${"x".repeat(200_000)}` }));
  writeConversation(base, "secret", conversation);
  useRoots(base);
  const collected = collectAntigravity("UTC");
  expect(collected.sessions).toHaveLength(1);
  expect(JSON.stringify(collected)).not.toContain(canary);
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const table of tables) {
    const rows = db.query(`SELECT * FROM "${table}"`).all();
    expect(JSON.stringify(rows, (_key, value) => value instanceof Uint8Array ? new TextDecoder().decode(value) : value)).not.toContain(canary);
  }
  for (const sql of ANTIGRAVITY_SQL) {
    expect(sql).not.toMatch(/\b(title|preview|raw_summary|step_payload|fts)\b|\*/i);
  }
});
