import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { antigravityDatabaseFiles, collectAntigravity, resetAntigravityCache } from "./antigravity";
import { ANTIGRAVITY_EFFORT_VERSION, syncAntigravityEffort } from "./antigravity-effort";
import { appendConversation, conversationPath, writeConversation } from "./antigravity-fixture";
import { antigravityHealth } from "./collector";
import { buildSessionEffortCombos } from "./effort-api";
import { deleteEffortDerived, effortGeneration, getEffortState, setEffortEnabled } from "./effort-store";
import { getSessionEpisodes } from "./session-evidence";
import { db } from "./store";
import { testAntigravityDirectory } from "./test-setup";

const t0 = Date.UTC(2026, 10, 21, 20, 0, 0);
/** Root ignores file modes, so a test that denies access by chmod proves nothing there. */
const permissionTest = test.skipIf(process.getuid?.() === 0);
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
  // Restored outermost first, so each inner directory can be reached again.
  for (const path of [join(root, ".."), root, join(root, "conversations")]) {
    try { chmodSync(path, 0o755); } catch { /* removed by the test */ }
  }
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

function sessionPathIds() {
  return (db.query("SELECT session_id FROM session_paths WHERE agent = 'antigravity' ORDER BY session_id").all() as Array<{ session_id: string }>).map((row) => row.session_id);
}

const uncheckedNote = "1 stored conversation was not read this time; its effort rows are kept until its database file is deleted";
const unreadableNote = "1 database could not be read this time";

/** Collects and syncs one conversation with effort enabled, so it has stored effort rows. */
function storedConversation(id: string) {
  setEffortEnabled(true);
  const path = writeConversation(root, id, conversation(id));
  syncAntigravityEffort(collectAntigravity("UTC"));
  expect(usageRows(`antigravity-${id}`)).toHaveLength(1);
  return path;
}

test("a session whose database file is deleted is pruned with its effort rows", () => {
  const path = storedConversation("four");
  writeConversation(root, "five", conversation("five"));
  syncAntigravityEffort(collectAntigravity("UTC"));
  rmSync(path);
  const collected = collectAntigravity("UTC");
  expect(collected.missingSessionIds).toEqual(["antigravity-four"]);
  expect(collected.notes).not.toContain(uncheckedNote);
  syncAntigravityEffort(collected);
  expect(sessionPathIds()).toEqual(["antigravity-five"]);
  expect(usageRows("antigravity-four")).toEqual([]);
  expect(getEffortState("antigravity-four")).toBeNull();
});

test("a sync removes only the sessions the collection found missing", () => {
  storedConversation("six");
  syncAntigravityEffort({ effortSources: [], missingSessionIds: [] });
  expect(usageRows("antigravity-six")).toHaveLength(1);
  syncAntigravityEffort({ effortSources: [], missingSessionIds: ["antigravity-six"] });
  expect(usageRows("antigravity-six")).toEqual([]);
});

permissionTest("an unlistable conversations directory keeps every stored session and prunes nothing", () => {
  storedConversation("seven");

  // Permission denied is not an empty directory: which conversations exist is unknown.
  chmodSync(join(root, "conversations"), 0o000);
  const denied = collectAntigravity("UTC");
  expect(denied.notes).toContain("1 conversations directory could not be listed; its sessions are left out");
  expect(denied.notes).toContain(uncheckedNote);
  expect(denied.missingSessionIds).toEqual([]);
  // ccusage cannot list it either, and its files leave the ccusage fingerprint, so no session is
  // served from a cached parse; the stored effort rows stay.
  expect(denied.conversations).toEqual([]);
  expect(antigravityDatabaseFiles()).toEqual([]);
  syncAntigravityEffort(denied);
  expect(usageRows("antigravity-seven")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-seven"]);

  // A directory that is gone takes its conversations with it: each file is ENOENT, so it is pruned.
  chmodSync(join(root, "conversations"), 0o755);
  rmSync(join(root, "conversations"), { recursive: true });
  const gone = collectAntigravity("UTC");
  expect(gone.missingSessionIds).toEqual(["antigravity-seven"]);
  expect(gone.notes).toEqual([]);
  syncAntigravityEffort(gone);
  expect(usageRows("antigravity-seven")).toEqual([]);
  expect(sessionPathIds()).toEqual([]);
});

permissionTest("a conversations directory that lists but denies lookups (0400) keeps the stored rows", () => {
  storedConversation("listable");
  chmodSync(join(root, "conversations"), 0o400);
  resetAntigravityCache();
  const collected = collectAntigravity("UTC");
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  // The listed file could not be checked: counted once as unreadable, never treated as missing.
  expect(collected.notes).toEqual([unreadableNote]);
  syncAntigravityEffort(collected);
  expect(usageRows("antigravity-listable")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-listable"]);
});

permissionTest("a cold start in a conversations directory that lists but denies lookups (0400) is noted", () => {
  // No stored session, so only the per-file stat error can say anything is wrong.
  writeConversation(root, "cold", conversation("cold"));
  chmodSync(join(root, "conversations"), 0o400);
  const collected = collectAntigravity("UTC");
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  expect(collected.notes).toEqual([unreadableNote]);
  const health = antigravityHealth(collected);
  expect(health.status).toBe("degraded");
  expect(health.detail).toContain(unreadableNote);
});

permissionTest("a root whose ancestor denies access (000) keeps the stored rows", () => {
  storedConversation("ancestor");
  chmodSync(join(root, ".."), 0o000);
  const collected = collectAntigravity("UTC");
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  // The root could not be checked, which is not the same as no root at all.
  expect(collected.notes).toEqual(["1 data directory could not be checked; its sessions are left out", uncheckedNote]);
  expect(collected.error).toBe("No Antigravity data directory could be read on this machine.");
  const health = antigravityHealth(collected);
  expect(health.status).toBe("degraded");
  expect(health.detail).toContain(uncheckedNote);
  syncAntigravityEffort(collected);
  expect(usageRows("antigravity-ancestor")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-ancestor"]);
});

// Root-safe variants of the permission tests above: a regular file in the path (ENOTDIR) and a
// symlink loop (ELOOP) fail the same way for every user, root included.
test("a root under a regular file (ENOTDIR) keeps the stored rows", () => {
  storedConversation("under-file");
  const install = join(root, "..");
  renameSync(install, `${install}.moved`);
  writeFileSync(install, "");
  const collected = collectAntigravity("UTC");
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  expect(collected.notes).toEqual(["1 data directory could not be checked; its sessions are left out", uncheckedNote]);
  expect(collected.error).toBe("No Antigravity data directory could be read on this machine.");
  expect(antigravityHealth(collected).status).toBe("degraded");
  syncAntigravityEffort(collected);
  expect(usageRows("antigravity-under-file")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-under-file"]);
});

test("a listed database that is a symlink loop (ELOOP) is noted once and keeps its stored rows", () => {
  const path = storedConversation("loop");
  rmSync(path);
  symlinkSync(path, path);
  const collected = collectAntigravity("UTC");
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  expect(collected.notes).toEqual([unreadableNote]);
  expect(antigravityHealth(collected).status).toBe("degraded");
  syncAntigravityEffort(collected);
  expect(usageRows("antigravity-loop")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-loop"]);
});

test("a stored conversation outside the configured roots keeps its rows and is noted", () => {
  storedConversation("elsewhere");
  // The configured list moves to another directory; the old file is still there.
  const other = join(root, "../../other/antigravity-acp");
  mkdirSync(join(other, "conversations"), { recursive: true });
  process.env.ANTIGRAVITY_DATA_DIRS = other;
  const collected = collectAntigravity("UTC");
  expect(collected.available).toBe(true);
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  expect(collected.notes).toEqual([uncheckedNote]);
  expect(antigravityHealth(collected).status).toBe("degraded");
  syncAntigravityEffort(collected);
  expect(usageRows("antigravity-elsewhere")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-elsewhere"]);
});

test("a conversation whose schema changed (a renamed column) keeps its stored rows", () => {
  storedConversation("drifted");
  const database = new Database(conversationPath(root, "drifted"));
  database.run("ALTER TABLE steps RENAME COLUMN metadata TO metadata_v2");
  database.close();
  const collected = collectAntigravity("UTC");
  expect(collected.effortSources).toEqual([]);
  expect(collected.missingSessionIds).toEqual([]);
  expect(collected.notes).toEqual(["1 database did not match the expected schema", uncheckedNote]);
  syncAntigravityEffort(collected);
  expect(usageRows("antigravity-drifted")).toHaveLength(1);
  expect(sessionPathIds()).toEqual(["antigravity-drifted"]);
});

test("a reporting time-zone change rewrites the rows' days", () => {
  setEffortEnabled(true);
  const late = Date.UTC(2026, 10, 22, 1, 0, 0);
  writeConversation(root, "eight", {
    steps: [{ idx: 0, at: late, usage: { input: 100, output: 10, thinking: 4, messageId: "a" } }],
    generations: [{ idx: 0, usage: { input: 100, output: 10, thinking: 4, messageId: "a" }, ...neonHigh }],
  });
  syncAntigravityEffort(collectAntigravity("UTC"));
  expect(usageRows("antigravity-eight").map((row) => row.occurred_on)).toEqual(["2026-11-22"]);
  expect(syncAntigravityEffort(collectAntigravity("America/New_York"))).toEqual({ written: 1 });
  expect(usageRows("antigravity-eight").map((row) => row.occurred_on)).toEqual(["2026-11-21"]);
  expect(syncAntigravityEffort(collectAntigravity("America/New_York"))).toEqual({ written: 0 });
});

test("a replacement that keeps the size and mtime but is a different file rebuilds the effort and activity rows", () => {
  setEffortEnabled(true);
  const path = writeConversation(root, "swap", conversation("swap"));
  // A whole-second mtime, so the replacement can carry exactly the same one.
  const fixed = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  utimesSync(path, fixed, fixed);
  syncAntigravityEffort(collectAntigravity("UTC"));
  expect(usageRows("antigravity-swap").map((row) => row.effort)).toEqual(["high"]);
  const original = statSync(path);
  // The same conversation, restored from elsewhere: Medium effort, a day later.
  const elsewhere = join(root, "../elsewhere");
  mkdirSync(join(elsewhere, "conversations"), { recursive: true });
  const day = 86_400_000;
  const replacement = writeConversation(elsewhere, "swap", {
    steps: [{ idx: 0, at: t0 + day, usage: { input: 100, output: 10, thinking: 4, messageId: "a" } }],
    generations: [{ idx: 0, usage: { input: 100, output: 10, thinking: 4, messageId: "a" }, modelId: "gemini-4-neon", label: "Gemini 4 Neon (Medium)" }],
  });
  expect(statSync(replacement).size).toBe(original.size);
  utimesSync(replacement, fixed, fixed);
  renameSync(replacement, path);
  expect(statSync(path).mtimeMs).toBe(original.mtimeMs);
  expect(statSync(path).ino).not.toBe(original.ino);
  expect(syncAntigravityEffort(collectAntigravity("UTC"))).toEqual({ written: 1 });
  expect(usageRows("antigravity-swap").map((row) => row.effort)).toEqual(["medium"]);
  expect(getSessionEpisodes("antigravity-swap")).toEqual([{ startAt: t0 + day, endAt: t0 + day }]);
});
