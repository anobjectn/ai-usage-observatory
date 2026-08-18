import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { warpDatabasePath, warpTimestamp } from "./warp";
import { parseWarpQueryInput } from "./warp-prompts";
import { maxTaskBytes, mergeWarpTaskEvents } from "./warp-transcript";

/**
 * Everything a Warp session can show, read in one connection when the session is
 * opened. Nothing here runs during collection or for any other provider: this
 * module is imported only after a `warp-` session id reaches the detail route.
 *
 * Prompts come from `ai_queries`, which is the authoritative record of what was
 * typed. Responses come from the agent-run blobs in `agent_tasks`, which is the
 * only local copy of what the agent said back.
 */
export type WarpPrompt = { text: string; timestamp: string | null };
export type WarpOutput = { text: string; timestamp: string | null; truncated: boolean };
export type WarpSessionRecord = {
  prompts: WarpPrompt[];
  outputs: WarpOutput[];
  /** Reasoning summaries are counted but never returned, so the panel can say
   * they exist without importing them. */
  reasoningEvents: number;
  eventsRead: number;
};

/** Kept in step with the JSONL reader's caps so one provider's session panel
 * cannot quietly hold more of a transcript than another's. */
const maxPromptCharacters = 2_000;
const maxOutputCharacters = 4_000;
const maxPrompts = 8;
const maxOutputs = 8;

export function readWarpSession(conversationId: string): WarpSessionRecord | null {
  const databasePath = warpDatabasePath();
  if (!existsSync(databasePath)) return null;
  let database: Database;
  try {
    database = new Database(databasePath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const queryRows = database
      .query("SELECT start_ts, input FROM ai_queries WHERE conversation_id = ? ORDER BY start_ts, id")
      .all(conversationId) as Array<{ start_ts: string | null; input: string | null }>;
    const prompts: WarpPrompt[] = [];
    const seenPrompts = new Set<string>();
    for (const row of queryRows) {
      if (typeof row.input !== "string") continue;
      for (const text of parseWarpQueryInput(row.input)) {
        if (seenPrompts.has(text)) continue;
        seenPrompts.add(text);
        prompts.push({ text: text.slice(0, maxPromptCharacters), timestamp: warpTimestamp(row.start_ts) });
      }
    }

    // Filtered by conversation only. Adding `length(task) <= ?` to this statement
    // reads the blob of every row in the table to evaluate it, which turns a
    // two-row read into a scan of tens of megabytes; the size ceiling is applied
    // per row after the fetch instead.
    const taskRows = database
      .query("SELECT task FROM agent_tasks WHERE conversation_id = ? ORDER BY last_modified_at")
      .all(conversationId) as Array<{ task: Uint8Array | null }>;
    const events = mergeWarpTaskEvents(
      taskRows
        .map((row) => (row.task ? new Uint8Array(row.task) : new Uint8Array()))
        .filter((task) => task.length <= maxTaskBytes),
    );
    const outputs: WarpOutput[] = [];
    const seenOutputs = new Set<string>();
    let reasoningEvents = 0;
    for (const event of events) {
      if (event.kind === "reasoning") {
        reasoningEvents += 1;
        continue;
      }
      if (event.kind !== "assistant" || seenOutputs.has(event.text)) continue;
      seenOutputs.add(event.text);
      outputs.push({
        text: event.text.slice(0, maxOutputCharacters),
        timestamp: event.timestamp,
        truncated: event.text.length > maxOutputCharacters,
      });
    }
    return {
      prompts: prompts.slice(-maxPrompts),
      outputs: outputs.slice(-maxOutputs),
      reasoningEvents,
      eventsRead: queryRows.length + events.length,
    };
  } catch {
    return null;
  } finally {
    database.close();
  }
}
