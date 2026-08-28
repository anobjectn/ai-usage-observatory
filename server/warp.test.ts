import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionEpisodes } from "./session-evidence";
import { collectWarp, WARP_QUERY_ACTIVITY_SQL, WARP_TASK_ACTIVITY_SQL } from "./warp";

test("Warp activity collection uses timestamp columns and retains minimal evidence", async () => {
  expect(WARP_QUERY_ACTIVITY_SQL).not.toContain("input");
  expect(WARP_TASK_ACTIVITY_SQL).not.toContain("task,");
  expect(WARP_TASK_ACTIVITY_SQL).not.toMatch(/\btask\s+FROM/i);

  const path = join(tmpdir(), `warp-activity-${crypto.randomUUID()}.sqlite`);
  const conversationId = `activity-${crypto.randomUUID()}`;
  const database = new Database(path);
  database.exec(`
    CREATE TABLE agent_conversations (
      id INTEGER PRIMARY KEY, conversation_id TEXT, last_modified_at TEXT, conversation_data TEXT
    );
    CREATE TABLE ai_queries (
      id INTEGER PRIMARY KEY, conversation_id TEXT, start_ts TEXT, working_directory TEXT,
      output_status TEXT, model_id TEXT
    );
    CREATE TABLE agent_tasks (
      id INTEGER PRIMARY KEY, conversation_id TEXT, last_modified_at TEXT, task BLOB
    );
    CREATE TABLE blocks (id INTEGER PRIMARY KEY, ai_metadata TEXT, pwd TEXT, exit_code INTEGER, did_execute INTEGER);
  `);
  database.run(
    "INSERT INTO agent_conversations (conversation_id, last_modified_at, conversation_data) VALUES (?, ?, ?)",
    [conversationId, "2026-08-20 10:12:00", JSON.stringify({ conversation_usage_metadata: { credits_spent: 2 } })],
  );
  database.run(
    "INSERT INTO ai_queries (conversation_id, start_ts, working_directory, output_status, model_id) VALUES (?, ?, ?, ?, ?)",
    [conversationId, "2026-08-20 10:00:00", "/tmp/project", "completed", "gpt-5.5"],
  );
  database.run(
    "INSERT INTO agent_tasks (conversation_id, last_modified_at, task) VALUES (?, ?, ?)",
    [conversationId, "2026-08-20 10:08:00", new Uint8Array(2_000_000)],
  );
  database.close();

  const prior = process.env.WARP_DB_PATH;
  process.env.WARP_DB_PATH = path;
  try {
    const collected = await collectWarp();
    const session = collected.sessions.find((row) => row.sessionId === `warp-${conversationId}`);
    expect(session?.activityIntervals).toEqual([{
      startAt: Date.parse(new Date("2026-08-20T10:00:00").toISOString()),
      endAt: Date.parse(new Date("2026-08-20T10:08:00").toISOString()),
    }]);
    expect(getSessionEpisodes(`warp-${conversationId}`)).toEqual(session?.activityIntervals ?? []);

    const mutate = new Database(path);
    mutate.run("DELETE FROM agent_conversations WHERE conversation_id = ?", [conversationId]);
    mutate.close();
    await collectWarp();
    expect(getSessionEpisodes(`warp-${conversationId}`)).toEqual(session?.activityIntervals ?? []);
  } finally {
    if (prior === undefined) delete process.env.WARP_DB_PATH;
    else process.env.WARP_DB_PATH = prior;
    rmSync(path, { force: true });
  }
});
