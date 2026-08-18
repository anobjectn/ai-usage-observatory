import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warpEvent, warpTask } from "./warp-fixture";
import { readWarpSession } from "./warp-session";

const query = (...variants: unknown[]) => JSON.stringify(variants);
const userEvent = (id: string, seconds: number, text: string) =>
  warpEvent({ id, seconds, payloadField: 2, text });
const assistantEvent = (id: string, seconds: number, text: string) =>
  warpEvent({ id, seconds, payloadField: 3, text });
const reasoningEvent = (id: string, seconds: number, text: string) =>
  warpEvent({ id, seconds, payloadField: 15, text });

type Fixture = {
  queries?: Array<[conversationId: string, startTs: string, input: string]>;
  tasks?: Array<[conversationId: string, modifiedAt: string, task: Uint8Array]>;
};

function withWarpDatabase<T>(fixture: Fixture, read: () => T): T {
  const path = join(tmpdir(), `warp-session-${crypto.randomUUID()}.sqlite`);
  const database = new Database(path);
  database.run(
    "CREATE TABLE ai_queries (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL)",
  );
  database.run(
    "CREATE TABLE agent_tasks (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, task BLOB NOT NULL, last_modified_at TIMESTAMP NOT NULL)",
  );
  for (const [conversationId, startTs, input] of fixture.queries ?? [])
    database.run("INSERT INTO ai_queries (conversation_id, start_ts, input) VALUES (?, ?, ?)", [conversationId, startTs, input]);
  for (const [conversationId, modifiedAt, task] of fixture.tasks ?? [])
    database.run("INSERT INTO agent_tasks (conversation_id, task, last_modified_at) VALUES (?, ?, ?)", [conversationId, task, modifiedAt]);
  database.close();

  const previous = process.env.WARP_DB_PATH;
  process.env.WARP_DB_PATH = path;
  try {
    return read();
  } finally {
    if (previous === undefined) delete process.env.WARP_DB_PATH;
    else process.env.WARP_DB_PATH = previous;
    rmSync(path, { force: true });
  }
}

describe("reading one Warp session", () => {
  test("returns the prompts typed and the responses that came back", () => {
    const record = withWarpDatabase(
      {
        queries: [
          ["a", "2026-08-16 11:00:00", query({ Query: { text: "fix the build" } })],
          ["b", "2026-08-16 11:05:00", query({ Query: { text: "other conversation" } })],
        ],
        tasks: [
          ["a", "2026-08-16 11:02:00", warpTask(userEvent("1", 100, "fix the build"), assistantEvent("2", 101, "Reading the failing job."))],
          ["b", "2026-08-16 11:06:00", warpTask(assistantEvent("9", 102, "Not this conversation."))],
        ],
      },
      () => readWarpSession("a"),
    );
    expect(record?.prompts.map((prompt) => prompt.text)).toEqual(["fix the build"]);
    expect(record?.outputs.map((output) => output.text)).toEqual(["Reading the failing job."]);
    expect(record?.prompts[0]?.timestamp).toBe(new Date("2026-08-16T11:00:00").toISOString());
    expect(record?.outputs[0]?.timestamp).toBe(new Date(1970, 0, 1, 0, 1, 41).toISOString());
  });

  // Reasoning is the agent talking to itself. It is counted so the panel can say it
  // exists, and excluded so Warp matches what the other providers sample.
  test("counts reasoning without returning it", () => {
    const record = withWarpDatabase(
      { tasks: [["a", "2026-08-16 11:00:00", warpTask(reasoningEvent("1", 100, "private"), assistantEvent("2", 101, "public"))]] },
      () => readWarpSession("a"),
    );
    expect(record?.outputs.map((output) => output.text)).toEqual(["public"]);
    expect(record?.reasoningEvents).toBe(1);
  });

  test("keeps the most recent responses and flags one that was clipped", () => {
    const record = withWarpDatabase(
      {
        tasks: [
          [
            "a",
            "2026-08-16 11:00:00",
            warpTask(
              ...Array.from({ length: 9 }, (_, index) => assistantEvent(`${index}`, 100 + index, `reply ${index}`)),
              assistantEvent("long", 200, "x".repeat(5_000)),
            ),
          ],
        ],
      },
      () => readWarpSession("a"),
    );
    expect(record?.outputs).toHaveLength(8);
    expect(record?.outputs[0]?.text).toBe("reply 2");
    expect(record?.outputs.at(-1)?.truncated).toBe(true);
    expect(record?.outputs.at(-1)?.text.length).toBe(4_000);
  });

  test("reports a conversation with a prompt but no recorded run", () => {
    const record = withWarpDatabase(
      { queries: [["a", "2026-08-16 11:00:00", query({ Query: { text: "just asking" } })]] },
      () => readWarpSession("a"),
    );
    expect(record?.prompts).toHaveLength(1);
    expect(record?.outputs).toEqual([]);
  });

  // A database that cannot be read is a different fact from a session with nothing in it.
  test("reports null when the database is absent", () => {
    const previous = process.env.WARP_DB_PATH;
    process.env.WARP_DB_PATH = join(tmpdir(), `warp-missing-${crypto.randomUUID()}.sqlite`);
    try {
      expect(readWarpSession("a")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.WARP_DB_PATH;
      else process.env.WARP_DB_PATH = previous;
    }
  });

  test("survives a database whose schema no longer matches", () => {
    const path = join(tmpdir(), `warp-schema-${crypto.randomUUID()}.sqlite`);
    const database = new Database(path);
    database.run("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
    database.close();
    const previous = process.env.WARP_DB_PATH;
    process.env.WARP_DB_PATH = path;
    try {
      expect(readWarpSession("a")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.WARP_DB_PATH;
      else process.env.WARP_DB_PATH = previous;
      rmSync(path, { force: true });
    }
  });
});
