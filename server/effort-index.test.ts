import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `server/test-setup.ts` (preloaded via bunfig.toml) has already pinned the database to a
// throwaway path; this file only needs its own directory for transcript fixtures.
const workspace = mkdtempSync(join(tmpdir(), "effort-index-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

import { Database } from "bun:sqlite";
import { db } from "./store";
import { migrations, runMigrations } from "./migrations";
import * as store from "./effort-store";
import * as index from "./effort-index";
import { MAX_LINE_BYTES, PARSER_VERSION } from "./effort-parse";
import * as fixtures from "./effort-fixtures";
import type { SessionSource as Source } from "./path-indexer";

const { SENSITIVE_SENTINEL } = fixtures;

let counter = 0;

async function writeSource(agent: "claude" | "codex", body: string, options: { cwd?: string; sessionId?: string } = {}): Promise<Source> {
  const sessionId = options.sessionId ?? `session-${++counter}`;
  const sourceFile = join(workspace, `${sessionId}.jsonl`);
  await writeFile(sourceFile, body);
  const info = await stat(sourceFile);
  db.query(`INSERT INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET source_mtime = excluded.source_mtime, source_size = excluded.source_size`)
    .run(sessionId, agent, sessionId, sourceFile, options.cwd ?? "/fixture/project", info.mtimeMs, info.size);
  return { sessionId, agent, sourceFile, mtimeMs: info.mtimeMs, size: info.size, sourceIdentity: `${info.dev}:${info.ino}` };
}

async function restat(source: Source): Promise<Source> {
  const info = await stat(source.sourceFile);
  return { ...source, mtimeMs: info.mtimeMs, size: info.size };
}

function derived(sessionId: string) {
  return db.query("SELECT occurred_on, model, effort, observations, total_tokens FROM session_effort_usage WHERE session_id = ? ORDER BY occurred_on, model, effort")
    .all(sessionId) as Array<Record<string, unknown>>;
}

const codexBody = (turns = 2) => fixtures.transcript(
  Array.from({ length: turns }, (_, turn) => [
    fixtures.codexTurnContext({ effort: turn % 2 === 0 ? "high" : "low" }),
    fixtures.codexTokenCount({ timestamp: `2026-07-01T15:${String(turn + 1).padStart(2, "0")}:00.000Z` }),
    fixtures.codexMessage(),
  ]).flat(),
);

beforeEach(() => {
  db.query("DELETE FROM session_effort_usage").run();
  db.query("DELETE FROM session_effort_state").run();
  db.query("DELETE FROM session_paths").run();
  index.resetVerifiedBoundaries();
});

describe("migration 3", () => {
  test("applies to a database that stops at migration 2", () => {
    const legacy = new Database(":memory:");
    legacy.exec("PRAGMA foreign_keys = ON");
    runMigrations(legacy, migrations.filter((migration) => migration.id <= 2));
    legacy.query("INSERT INTO session_paths (session_id, agent, native_session_key, source_file, source_mtime) VALUES ('a','claude','a','/tmp/a.jsonl', 1)").run();
    runMigrations(legacy);

    const columns = (legacy.query("PRAGMA table_info(session_paths)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("source_size");
    expect(legacy.query("SELECT enabled, index_version FROM effort_index_meta WHERE id = 1").get()).toMatchObject({ enabled: 0, index_version: 0 });

    legacy.query("INSERT INTO session_effort_state (session_id, parser_version, source_size, source_mtime, last_offset, resume_hash, coverage_state, last_indexed_at) VALUES ('a', 1, 0, 1, 0, '', 'unavailable', 'now')").run();
    legacy.query("INSERT INTO session_effort_usage (session_id, occurred_on, model, effort) VALUES ('a','2026-07-01','m','high')").run();
    legacy.query("DELETE FROM session_paths WHERE session_id = 'a'").run();
    expect((legacy.query("SELECT COUNT(*) AS count FROM session_effort_usage").get() as { count: number }).count).toBe(0);
    expect((legacy.query("SELECT COUNT(*) AS count FROM session_effort_state").get() as { count: number }).count).toBe(0);
    legacy.close();
  });

  test("the bundled SQLite can bind scope ids through json_each", () => {
    expect(store.assertJsonEachSupport()).toBe(true);
  });
});

describe("incremental indexing", () => {
  test("a clean backfill records grouped rows and a resumable offset", async () => {
    const source = await writeSource("codex", codexBody());
    const result = await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    expect(result.done).toBe(true);
    expect(result.offset).toBe(source.size);

    const state = store.getEffortState(source.sessionId)!;
    expect(state.parserVersion).toBe(PARSER_VERSION);
    expect(state.observations).toBe(2);
    expect(state.attributedTokens).toBe(2120);
    expect(state.resumeHash).not.toBe("");
    expect(derived(source.sessionId).map((row) => row.effort)).toEqual(["high", "low"]);
  });

  test("interrupted, resumed, and rebuilt indexes produce identical rows", async () => {
    const body = codexBody(6);
    const clean = await writeSource("codex", body);
    await index.indexOneSession(clean, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const expected = derived(clean.sessionId);

    // Tiny chunks plus a zero-millisecond budget force a resume after nearly every span.
    const chunked = await writeSource("codex", body);
    let passes = 0;
    for (;;) {
      const state = store.getEffortState(chunked.sessionId);
      const work = state ? { kind: "append" as const } : { kind: "rebuild" as const, reason: "new" };
      const result = await index.indexOneSession(chunked, work, { budgetMs: 0, chunkBytes: 700 });
      if (result.done) break;
      expect(++passes).toBeLessThan(1_000);
    }
    expect(derived(chunked.sessionId)).toEqual(expected);
    expect(store.getEffortState(chunked.sessionId)!.attributedTokens).toBe(store.getEffortState(clean.sessionId)!.attributedTokens);

    // A rebuild of the already-complete session must land on the same numbers, not double them.
    await index.indexOneSession(chunked, { kind: "rebuild", reason: "parser-version" }, { budgetMs: 60_000 });
    expect(derived(chunked.sessionId)).toEqual(expected);
  });

  test("multi-byte UTF-8 survives every chunk boundary", async () => {
    const marker = "café-日本語-🚀";
    const body = fixtures.transcript([
      fixtures.codexTurnContext({ effort: "high", model: `gpt-${marker}` }),
      fixtures.codexTokenCount({}),
    ]);
    for (const chunkBytes of [1, 2, 3, 5, 7, 11, 13, 17, 64]) {
      const source = await writeSource("codex", body);
      let guard = 0;
      for (;;) {
        const state = store.getEffortState(source.sessionId);
        const result = await index.indexOneSession(source, state ? { kind: "append" } : { kind: "rebuild", reason: "new" }, { budgetMs: 60_000, chunkBytes });
        if (result.done) break;
        expect(++guard).toBeLessThan(100_000);
      }
      const rows = derived(source.sessionId);
      expect(rows.map((row) => row.model)).toEqual([`gpt-${marker}`]);
      expect(rows[0].total_tokens).toBe(1060);
    }
  });

  test("an append does work proportional to the appended bytes and never re-counts", async () => {
    let source = await writeSource("codex", codexBody(1));
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const firstOffset = store.getEffortState(source.sessionId)!.lastOffset;

    await writeFile(source.sourceFile, codexBody(1) + fixtures.transcript([
      fixtures.codexTokenCount({ timestamp: "2026-07-01T15:02:00.000Z" }),
    ]));
    source = await restat(source);
    const result = await index.indexOneSession(source, { kind: "append" }, { budgetMs: 60_000 });
    expect(result.offset).toBe(source.size);
    expect(firstOffset).toBeLessThan(source.size);
    // Two usage events under one high-effort turn context.
    expect(store.getEffortState(source.sessionId)!.attributedTokens).toBe(2120);
    expect(store.getEffortState(source.sessionId)!.observations).toBe(1);
  });

  test("an incomplete final line is normal and is re-read once terminated", async () => {
    const appended = fixtures.codexTokenCount({ timestamp: "2026-07-01T15:02:00.000Z" });
    const partial = codexBody(1) + appended.slice(0, 30);
    let source = await writeSource("codex", partial);
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const state = store.getEffortState(source.sessionId)!;
    expect(state.lastOffset).toBeLessThan(source.size);
    expect(state.parseErrors).toBe(0);

    await writeFile(source.sourceFile, codexBody(1) + fixtures.transcript([appended]));
    source = await restat(source);
    await index.indexOneSession(source, { kind: "append" }, { budgetMs: 60_000 });
    expect(store.getEffortState(source.sessionId)!.observedUsageTokens).toBe(2120);
  });

  test("a rewritten boundary forces a rebuild instead of a corrupt append", async () => {
    let source = await writeSource("codex", codexBody(2));
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const before = store.getEffortState(source.sessionId)!;

    // Same prefix length, different bytes, then more content: a naive offset resume would splice
    // two unrelated transcripts together.
    await writeFile(source.sourceFile, codexBody(3).replace("high", "xhigh"));
    source = await restat(source);
    await index.indexOneSession(source, { kind: "append" }, { budgetMs: 60_000 });
    const after = store.getEffortState(source.sessionId)!;
    expect(after.observations).toBe(3);
    expect(after.observations).not.toBe(before.observations + 3);
    // codexBody(3) is high / low / high; replacing only the first occurrence gives xhigh / low / high.
    expect(derived(source.sessionId).map((row) => row.effort)).toEqual(["high", "low", "xhigh"]);
  });

  test("shrink, mtime-backwards, and identity changes are classified as rebuilds", async () => {
    const source = await writeSource("codex", codexBody(3));
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const states = store.getEffortStates();

    expect(index.buildBacklog([source], states)).toEqual([]);
    expect(index.buildBacklog([{ ...source, size: 10 }], states)[0].work).toMatchObject({ kind: "rebuild", reason: "shrink" });
    expect(index.buildBacklog([{ ...source, mtimeMs: source.mtimeMs - 5_000 }], states)[0].work).toMatchObject({ kind: "rebuild", reason: "mtime-backwards" });
    expect(index.buildBacklog([{ ...source, mtimeMs: source.mtimeMs + 5_000 }], states)[0].work).toMatchObject({ kind: "rebuild", reason: "rewritten-in-place" });
    expect(index.buildBacklog([{ ...source, sourceIdentity: "9:9" }], states)[0].work).toMatchObject({ kind: "rebuild", reason: "source-identity" });
  });

  test("a parser-version bump rebuilds from byte zero", async () => {
    const source = await writeSource("codex", codexBody(2));
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    db.query("UPDATE session_effort_state SET parser_version = parser_version - 1 WHERE session_id = ?").run(source.sessionId);
    expect(index.buildBacklog([source], store.getEffortStates())[0].work).toMatchObject({ kind: "rebuild", reason: "parser-version" });
  });

  test("a relevant line over the buffer limit clears attribution and records a gap", async () => {
    const oversized = `{"type":"turn_context","payload":{"effort":"high","note":"${"x".repeat(MAX_LINE_BYTES + 16)}"}}`;
    const body = fixtures.transcript([
      fixtures.codexTurnContext({ effort: "high" }),
      oversized,
      fixtures.codexTokenCount({}),
    ]);
    const source = await writeSource("codex", body);
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const state = store.getEffortState(source.sessionId)!;
    expect(state.parseErrors).toBe(1);
    expect(state.skippedBytes).toBeGreaterThan(MAX_LINE_BYTES);
    expect(state.contextGaps).toBe(1);
    expect(state.attributedTokens).toBe(0);
  });

  test("Claude sessions index through the same path", async () => {
    const source = await writeSource("claude", fixtures.transcript([
      fixtures.claudeUser(),
      fixtures.claudeAssistant({ effort: "high" }),
      fixtures.claudeAssistant({ effort: null }),
    ]));
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const state = store.getEffortState(source.sessionId)!;
    expect(state.observations).toBe(2);
    expect(state.unknownObservations).toBe(1);
    expect(state.attributedTokens).toBe(135);
    expect(state.observedUsageTokens).toBe(270);
    expect(state.coverageState).toBe("partial");
  });
});

describe("backlog and lifecycle", () => {
  test("the full catalog enqueues a first enable even when no path changed", async () => {
    const source = await writeSource("codex", codexBody(1));
    const backlog = index.buildBacklog([source], store.getEffortStates());
    expect(backlog).toHaveLength(1);
    expect(backlog[0].pendingBytes).toBe(source.size);
  });

  test("recent sources are prioritised, and older ones still remain in the backlog", async () => {
    const old = await writeSource("codex", codexBody(1));
    const recent = await writeSource("codex", codexBody(1));
    const older = { ...old, mtimeMs: Date.now() - (index.RECENT_WINDOW_DAYS + 30) * 86_400_000 };
    const backlog = index.buildBacklog([older, recent], store.getEffortStates());
    expect(backlog.map((entry) => entry.source.sessionId)).toEqual([recent.sessionId, older.sessionId]);
  });

  test("progress reports both indexed and pending work", async () => {
    const done = await writeSource("codex", codexBody(1));
    const pending = await writeSource("codex", codexBody(1));
    await index.indexOneSession(done, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    const progress = index.effortProgress([done, pending], store.getEffortStates());
    expect(progress).toMatchObject({ indexedSessions: 1, pendingSessions: 1 });
    expect(progress.indexedBytes).toBe(done.size);
    expect(progress.pendingBytes).toBe(pending.size);
  });

  test("disabled indexing schedules no work at all", async () => {
    await writeSource("codex", codexBody(1));
    store.setEffortEnabled(false);
    expect(index.scheduleEffortIndexing()).toBeNull();
    expect(store.getEffortStates().size).toBe(0);
  });

  test("enabling drains the backlog, and deleting removes only derived rows", async () => {
    const source = await writeSource("codex", codexBody(2));
    index.setEffortCatalog([source]);
    store.setEffortEnabled(true);
    await index.scheduleEffortIndexing();
    expect(store.getEffortStates().size).toBe(1);
    expect(store.getEffortMeta().indexedAt).not.toBeNull();

    const versionBefore = store.getEffortMeta().indexVersion;
    store.deleteEffortDerived();
    expect(store.getEffortStates().size).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM session_effort_usage").get()).toMatchObject({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM session_paths").get()).toMatchObject({ count: 1 });
    expect(store.getEffortMeta().enabled).toBe(false);
    expect(store.getEffortMeta().indexVersion).toBeGreaterThan(versionBefore);
    index.setEffortCatalog([]);
  });

  test("a disappeared source cascades its derived rows away", async () => {
    const source = await writeSource("codex", codexBody(1));
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    expect(derived(source.sessionId).length).toBeGreaterThan(0);
    db.query("DELETE FROM session_paths WHERE session_id = ?").run(source.sessionId);
    expect(derived(source.sessionId)).toEqual([]);
    expect(store.getEffortState(source.sessionId)).toBeNull();
  });

  test("the index version advances on every derived write", async () => {
    const source = await writeSource("codex", codexBody(1));
    const before = store.getEffortMeta().indexVersion;
    await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });
    expect(store.getEffortMeta().indexVersion).toBeGreaterThan(before);
  });
});

describe("privacy", () => {
  test("no transcript text reaches SQLite", async () => {
    const codex = await writeSource("codex", codexBody(2));
    const claude = await writeSource("claude", fixtures.transcript([fixtures.claudeUser(), fixtures.claudeAssistant({ effort: "high" })]));
    for (const source of [codex, claude]) await index.indexOneSession(source, { kind: "rebuild", reason: "new" }, { budgetMs: 60_000 });

    const tables = ["session_effort_usage", "session_effort_state", "effort_index_meta"];
    for (const table of tables) {
      const rows = db.query(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows)).not.toContain(SENSITIVE_SENTINEL);
    }
    // Belt and braces: the sentinel must not survive anywhere in the database file either.
    const bytes = await Bun.file(process.env.USAGE_OBSERVATORY_DB!).arrayBuffer();
    expect(new TextDecoder().decode(bytes).includes(SENSITIVE_SENTINEL)).toBe(false);
  });
});
