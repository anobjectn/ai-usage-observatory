import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAntigravity, resetAntigravityCache } from "./antigravity";
import { ANTIGRAVITY_EFFORT_VERSION, syncAntigravityEffort } from "./antigravity-effort";
import { appendConversation, writeConversation } from "./antigravity-fixture";
import { buildSessionEffortCombos } from "./effort-api";
import { deleteEffortDerived, effortGeneration, getEffortState, setEffortEnabled } from "./effort-store";
import { getSessionEpisodes } from "./session-evidence";
import { db } from "./store";
import { testAntigravityDirectory } from "./test-setup";

const t0 = Date.UTC(2026, 10, 21, 20, 0, 0);
const neonHigh = { modelId: "gemini-4-neon", label: "Gemini 4 Neon (High)" };
let root: string;

function conversation(id: string, messages = ["a"]) {
  return {
    steps: messages.map((messageId, idx) => ({ idx, at: t0 + idx * 1000, usage: { input: 100, output: 10, thinking: 4, messageId } })),
    generations: messages.map((messageId, idx) => ({ idx, usage: { input: 100, output: 10, thinking: 4, messageId }, ...neonHigh })),
  };
}

function usageRows(sessionId: string) {
  return db.query("SELECT occurred_on, model, effort, observations, total_tokens FROM session_effort_usage WHERE session_id = ?").all(sessionId) as Array<{ occurred_on: string; model: string; effort: string; observations: number; total_tokens: number }>;
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "antigravity-effort-")), "install/antigravity-acp");
  mkdirSync(join(root, "conversations"), { recursive: true });
  process.env.ANTIGRAVITY_DATA_DIRS = root;
  resetAntigravityCache();
  db.query("DELETE FROM session_effort_usage").run();
  db.query("DELETE FROM session_effort_state").run();
  db.query("DELETE FROM session_paths").run();
  setEffortEnabled(false);
});

afterEach(() => {
  process.env.ANTIGRAVITY_DATA_DIRS = testAntigravityDirectory;
  rmSync(join(root, "../.."), { recursive: true, force: true });
  resetAntigravityCache();
  setEffortEnabled(false);
});

test("session paths are always written, effort rows only while the index is enabled", () => {
  writeConversation(root, "one", conversation("one"));
  const collected = collectAntigravity("UTC");
  expect(syncAntigravityEffort(collected)).toEqual({ written: 0 });
  expect(db.query("SELECT agent, native_session_key, cwd FROM session_paths WHERE session_id = 'antigravity-one'").get()).toEqual({ agent: "antigravity", native_session_key: "one", cwd: null });
  expect(usageRows("antigravity-one")).toEqual([]);

  setEffortEnabled(true);
  expect(syncAntigravityEffort(collected)).toEqual({ written: 1 });
  expect(usageRows("antigravity-one")).toEqual([{ occurred_on: "2026-11-21", model: "gemini-4-neon", effort: "high", observations: 1, total_tokens: 110 }]);
  expect(getEffortState("antigravity-one")).toMatchObject({ parserVersion: ANTIGRAVITY_EFFORT_VERSION, coverageState: "complete", observations: 1 });
  expect(getSessionEpisodes("antigravity-one")).toEqual([{ startAt: t0, endAt: t0 }]);
  expect(buildSessionEffortCombos("antigravity-one")).toEqual([{ model: "gemini-4-neon", family: "gemini-4-neon", effort: "high", observations: 1, tokens: 110 }]);
});

test("an unchanged signature is a no-op, and a change replaces rows without double-counting", () => {
  setEffortEnabled(true);
  const path = writeConversation(root, "two", conversation("two"));
  syncAntigravityEffort(collectAntigravity("UTC"));
  expect(syncAntigravityEffort(collectAntigravity("UTC"))).toEqual({ written: 0 });
  appendConversation(path, {
    steps: [{ idx: 5, at: t0 + 5000, usage: { input: 1, output: 1, messageId: "b" } }],
    generations: [{ idx: 5, usage: { input: 1, output: 1, messageId: "b" }, ...neonHigh }],
  });
  expect(syncAntigravityEffort(collectAntigravity("UTC"))).toEqual({ written: 1 });
  expect(usageRows("antigravity-two")).toEqual([{ occurred_on: "2026-11-21", model: "gemini-4-neon", effort: "high", observations: 2, total_tokens: 112 }]);
  expect(getEffortState("antigravity-two")?.observations).toBe(2);
});

test("a pass that began before derived data was deleted writes nothing", () => {
  setEffortEnabled(true);
  writeConversation(root, "three", conversation("three"));
  const collected = collectAntigravity("UTC");
  const stale = effortGeneration();
  deleteEffortDerived();
  setEffortEnabled(true);
  expect(syncAntigravityEffort(collected, stale)).toEqual({ written: 0 });
  expect(usageRows("antigravity-three")).toEqual([]);
  expect(getEffortState("antigravity-three")).toBeNull();
  expect(syncAntigravityEffort(collected)).toEqual({ written: 1 });
});

test("a session gone from a complete collection is pruned with its effort rows", () => {
  setEffortEnabled(true);
  const path = writeConversation(root, "four", conversation("four"));
  writeConversation(root, "five", conversation("five"));
  syncAntigravityEffort(collectAntigravity("UTC"));
  expect(usageRows("antigravity-four")).toHaveLength(1);
  rmSync(path);
  const collected = collectAntigravity("UTC");
  expect(collected.complete).toBe(true);
  syncAntigravityEffort(collected);
  expect(db.query("SELECT session_id FROM session_paths WHERE agent = 'antigravity' ORDER BY session_id").all()).toEqual([{ session_id: "antigravity-five" }]);
  expect(usageRows("antigravity-four")).toEqual([]);
  expect(getEffortState("antigravity-four")).toBeNull();
});

test("an incomplete collection never prunes", () => {
  setEffortEnabled(true);
  writeConversation(root, "six", conversation("six"));
  syncAntigravityEffort(collectAntigravity("UTC"));
  syncAntigravityEffort({ effortSources: [], complete: false });
  expect(usageRows("antigravity-six")).toHaveLength(1);
});
