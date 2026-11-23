import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detailOutputSampleCharacters,
  detailOutputSampleCount,
  getSessionDetail,
  parseSessionDetailJsonl,
  pendingSessionDetailReads,
} from "./session-detail";

const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("on-demand session output samples", () => {
  test("keeps Claude assistant text while excluding thinking and tool payloads", () => {
    const detail = parseSessionDetailJsonl(
      jsonl(
        {
          type: "assistant",
          timestamp: "2026-08-08T12:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "Visible answer" },
              { type: "tool_use", name: "Read", input: { file_path: "secret" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", content: "command output" }] },
        },
      ),
    );

    expect(detail.outputs).toEqual([
      {
        text: "Visible answer",
        timestamp: "2026-08-08T12:00:00.000Z",
        truncated: false,
      },
    ]);
    expect(JSON.stringify(detail.outputs)).not.toContain("private reasoning");
    expect(JSON.stringify(detail.outputs)).not.toContain("command output");
  });

  test("keeps Codex output_text while excluding other response item types", () => {
    const detail = parseSessionDetailJsonl(
      jsonl(
        {
          type: "response_item",
          timestamp: "2026-08-08T13:00:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "reasoning", text: "hidden" },
              { type: "output_text", text: "User-facing result" },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "tool result",
          },
        },
      ),
    );

    expect(detail.outputs.map((output) => output.text)).toEqual(["User-facing result"]);
  });

  test("returns only the most recent bounded samples and marks clipped text", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `answer-${index}` }],
      },
    }));
    rows.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "x".repeat(detailOutputSampleCharacters + 1) },
        ],
      },
    });

    const detail = parseSessionDetailJsonl(jsonl(...rows));

    expect(detail.outputs).toHaveLength(detailOutputSampleCount);
    expect(detail.outputs[0]?.text).toBe("answer-2");
    expect(detail.outputs.at(-1)).toMatchObject({
      truncated: true,
      text: "x".repeat(detailOutputSampleCharacters),
    });
  });
});

describe("session file diff counts", () => {
  test("attributes apply_patch additions and deletions to each file", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            "-before",
            "+after",
            "+another line",
            "*** Add File: src/b.ts",
            "+first line",
            "+second line",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
      {
        path: "src/b.ts",
        status: "added",
        additions: 2,
        deletions: 0,
      },
    ]);
    expect(detail.additions).toBe(4);
    expect(detail.deletions).toBe(1);
  });

  test("attributes Claude structured patch counts to the edited file", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        type: "user",
        toolUseResult: {
          filePath: "src/c.ts",
          structuredPatch: [
            { lines: [" unchanged", "-before", "+after", "+another line"] },
          ],
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/c.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  test("marks per-file counts unavailable when only change metadata exists", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        changes: {
          "src/unknown.ts": { type: "update" },
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/unknown.ts",
        status: "modified",
        additions: null,
        deletions: null,
      },
    ]);
  });

  test("reads counts from a structured unified diff", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        changes: {
          "src/from-metadata.ts": {
            type: "update",
            unified_diff: "@@ -1 +1,2 @@\n-before\n+after\n+another line",
          },
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/from-metadata.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
    expect(detail.additions).toBe(2);
    expect(detail.deletions).toBe(1);
  });

  test("merges relative patch input with its absolute structured result", () => {
    const detail = parseSessionDetailJsonl(
      jsonl(
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            input: [
              "*** Begin Patch",
              "*** Update File: src/same.ts",
              "@@",
              "-before",
              "+after",
              "*** End Patch",
            ].join("\n"),
          },
        },
        {
          changes: {
            "/repo/src/same.ts": {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-before\n+after",
            },
          },
        },
      ),
    );

    expect(detail.files).toEqual([
      {
        path: "/repo/src/same.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(detail.additions).toBe(1);
    expect(detail.deletions).toBe(1);
  });
});

describe("on-demand session detail reads", () => {
  test("a Warp commit that is still in the WAL is visible, and no read is retained", async () => {
    const path = join(tmpdir(), `warp-detail-${crypto.randomUUID()}.sqlite`);
    // The writer stays open, so SQLite does not checkpoint the WAL into the main file.
    const writer = new Database(path);
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("CREATE TABLE ai_queries (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL)");
    writer.run("CREATE TABLE agent_tasks (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, task BLOB NOT NULL, last_modified_at TIMESTAMP NOT NULL)");
    const ask = (startTs: string, text: string) =>
      writer.run("INSERT INTO ai_queries (conversation_id, start_ts, input) VALUES ('a', ?, ?)", [startTs, JSON.stringify([{ Query: { text } }])]);
    const previous = process.env.WARP_DB_PATH;
    process.env.WARP_DB_PATH = path;
    try {
      ask("2026-08-16 11:00:00", "first prompt");
      expect((await getSessionDetail("warp-a")).prompts.map((prompt) => prompt.text)).toEqual(["first prompt"]);
      expect(pendingSessionDetailReads()).toBe(0);

      ask("2026-08-16 11:01:00", "second prompt");
      expect((await getSessionDetail("warp-a")).prompts.map((prompt) => prompt.text)).toEqual(["first prompt", "second prompt"]);
      expect(pendingSessionDetailReads()).toBe(0);
    } finally {
      writer.close();
      if (previous === undefined) delete process.env.WARP_DB_PATH;
      else process.env.WARP_DB_PATH = previous;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

describe("Antigravity session detail", () => {
  async function withConversation(run: (context: { root: string; path: string; insert: (sourceFile: string) => void }) => Promise<void>) {
    const { db } = await import("./store");
    const { resetAntigravityCache } = await import("./antigravity");
    const { modelTurnPayload, userInputPayload, writeConversation } = await import("./antigravity-fixture");
    const { testAntigravityDirectory } = await import("./test-setup");
    const directory = mkdtempSync(join(tmpdir(), "antigravity-session-detail-"));
    const root = join(directory, "install/antigravity-acp");
    process.env.ANTIGRAVITY_DATA_DIRS = root;
    resetAntigravityCache();
    const at = Date.UTC(2026, 10, 21, 20, 0, 0);
    const path = writeConversation(root, "conv-detail", {
      steps: [
        { idx: 0, stepType: 14, at, payloadBytes: userInputPayload(["<user_request>Add a test</user_request>", "<runtime_info>x</runtime_info>"]) },
        {
          idx: 1, stepType: 15, at: at + 1000, usage: { input: 1, output: 1, messageId: "m1" },
          payloadBytes: modelTurnPayload({
            reply: "Added it.",
            thinking: "private",
            calls: [
              { name: "write_file", args: { Path: "/w/new.test.ts", Content: "a\nb\n" } },
              { name: "read_file", args: { Path: "/w/other.ts" } },
            ],
          }),
        },
      ],
    });
    const insert = (sourceFile: string) => db.query(`INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size)
      VALUES ('antigravity-conv-detail', 'antigravity', 'conv-detail', ?, '/w', 1, 1)`).run(sourceFile);
    try {
      await run({ root, path, insert });
    } finally {
      db.query("DELETE FROM session_paths WHERE session_id = 'antigravity-conv-detail'").run();
      process.env.ANTIGRAVITY_DATA_DIRS = testAntigravityDirectory;
      resetAntigravityCache();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test("reads prompts, replies, tools, and files on demand and keeps no read afterwards", async () => {
    await withConversation(async ({ path, insert }) => {
      insert(path);
      const [first, second] = await Promise.all([getSessionDetail("antigravity-conv-detail"), getSessionDetail("antigravity-conv-detail")]);
      // Concurrent requests for an unchanged file share one read.
      expect(second).toBe(first);
      expect(first).toMatchObject({
        available: true,
        prompts: [{ text: "Add a test" }],
        outputs: [{ text: "Added it.", truncated: false }],
        tools: [{ name: "read_file", count: 1 }, { name: "write_file", count: 1 }],
        files: [{ path: "/w/new.test.ts", status: "added", additions: 2, deletions: 0 }],
        additions: 2,
        deletions: 0,
        eventsRead: 2,
      });
      expect(JSON.stringify(first)).not.toContain("private");
      expect(pendingSessionDetailReads()).toBe(0);
    });
  });

  test("is unavailable with no row, a deleted file, a mismatched name, or a file outside the roots", async () => {
    await withConversation(async ({ root, path, insert }) => {
      expect((await getSessionDetail("antigravity-conv-detail")).available).toBe(false);
      insert(join(root, "conversations", "someone-else.db"));
      expect((await getSessionDetail("antigravity-conv-detail")).available).toBe(false);
      const outside = join(tmpdir(), `outside-${crypto.randomUUID()}`, "conv-detail.db");
      insert(outside);
      expect((await getSessionDetail("antigravity-conv-detail")).available).toBe(false);
      insert(path);
      expect((await getSessionDetail("antigravity-conv-detail")).available).toBe(true);
      rmSync(path);
      expect((await getSessionDetail("antigravity-conv-detail")).available).toBe(false);
      expect(pendingSessionDetailReads()).toBe(0);
    });
  });
});
