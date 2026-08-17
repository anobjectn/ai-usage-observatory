import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { warpDatabasePath, warpTimestamp } from "./warp";

/**
 * Warp keeps the typed prompt for every agent turn in `ai_queries.input`, as a
 * JSON array of tagged variants. Only the two user-authored variants are read
 * here: `Query` is a fresh prompt and `RefineUserQuery` is a follow-up
 * refinement. `ActionResult` rows are the agent reporting a tool outcome back
 * to itself, not something the person wrote, so they are skipped.
 *
 * Assistant responses are deliberately absent. They are not in this table, and
 * `agent_conversations.conversation_data` carries only usage metadata — the
 * message history itself lives on Warp's server behind a conversation token.
 */
export type WarpPrompt = { text: string; timestamp: string | null };

const maxPromptCharacters = 2_000;
const maxPrompts = 8;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(variant: unknown) {
  if (!record(variant)) return "";
  const value = variant.text ?? variant.query;
  return typeof value === "string" ? value.trim() : "";
}

/** Exported for tests: the parse is pure, so it needs no database. */
export function parseWarpQueryInput(input: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (!record(item)) return [];
    return ["Query", "RefineUserQuery"]
      .map((variant) => textOf(item[variant]))
      .filter(Boolean);
  });
}

/** Null means the database could not be read at all, which is a different fact
 * from a conversation whose turns carry no typed prompt. */
export function readWarpPrompts(conversationId: string): WarpPrompt[] | null {
  const databasePath = warpDatabasePath();
  if (!existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true });
  try {
    const rows = database
      .query(
        "SELECT start_ts, input FROM ai_queries WHERE conversation_id = ? ORDER BY start_ts, id",
      )
      .all(conversationId) as Array<{ start_ts: string | null; input: string | null }>;
    const prompts: WarpPrompt[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row.input !== "string") continue;
      for (const text of parseWarpQueryInput(row.input)) {
        if (seen.has(text)) continue;
        seen.add(text);
        prompts.push({
          text: text.slice(0, maxPromptCharacters),
          timestamp: warpTimestamp(row.start_ts),
        });
      }
    }
    // The newest prompts are the ones worth showing, matching the JSONL reader.
    return prompts.slice(-maxPrompts);
  } catch {
    return null;
  } finally {
    database.close();
  }
}
