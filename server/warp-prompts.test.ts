import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWarpQueryInput, readWarpPrompts } from "./warp-prompts";

const input = (...variants: unknown[]) => JSON.stringify(variants);

describe("Warp query input parsing", () => {
  test("reads the typed prompt out of a Query variant", () => {
    expect(
      parseWarpQueryInput(
        input({
          Query: {
            text: "  resolve the port conflict  ",
            context: [{ Directory: { pwd: "/Users/luis" } }],
          },
        }),
      ),
    ).toEqual(["resolve the port conflict"]);
  });

  test("reads a RefineUserQuery follow-up, which is also user-authored", () => {
    expect(parseWarpQueryInput(input({ RefineUserQuery: { query: "narrow it to tags" } }))).toEqual([
      "narrow it to tags",
    ]);
  });

  // ActionResult is the agent reporting a tool outcome to itself. Treating it as a
  // prompt would attribute the agent's own bookkeeping to the person.
  test("ignores ActionResult turns", () => {
    expect(
      parseWarpQueryInput(
        input(
          { ActionResult: { id: "abc", result: { SuggestCreatePlan: { result: "Proceed" } } } },
          { Query: { text: "and now deploy" } },
        ),
      ),
    ).toEqual(["and now deploy"]);
  });

  test("returns nothing for unparseable, empty, or unknown input", () => {
    expect(parseWarpQueryInput("not json at all")).toEqual([]);
    expect(parseWarpQueryInput(input({ Query: { text: "   " } }))).toEqual([]);
    expect(parseWarpQueryInput(input({ SomethingNew: { text: "later schema" } }))).toEqual([]);
  });

  test("accepts a bare object as well as the array Warp writes today", () => {
    expect(parseWarpQueryInput(JSON.stringify({ Query: { text: "bare" } }))).toEqual(["bare"]);
  });
});

describe("reading prompts out of a Warp database", () => {
  const fixture = (rows: Array<[string, string, string]>) => {
    const path = join(tmpdir(), `warp-prompts-${crypto.randomUUID()}.sqlite`);
    const database = new Database(path);
    database.run(
      "CREATE TABLE ai_queries (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL)",
    );
    for (const [conversationId, startTs, input] of rows) {
      database.run("INSERT INTO ai_queries (conversation_id, start_ts, input) VALUES (?, ?, ?)", [
        conversationId,
        startTs,
        input,
      ]);
    }
    database.close();
    return path;
  };
  const withDatabase = <T>(path: string, read: () => T) => {
    const previous = process.env.WARP_DB_PATH;
    process.env.WARP_DB_PATH = path;
    try {
      return read();
    } finally {
      if (previous === undefined) delete process.env.WARP_DB_PATH;
      else process.env.WARP_DB_PATH = previous;
      rmSync(path, { force: true });
    }
  };

  test("returns one conversation's prompts oldest first, ignoring other conversations", () => {
    const path = fixture([
      ["a", "2026-08-16 12:00:00", input({ Query: { text: "second" } })],
      ["a", "2026-08-16 11:00:00", input({ Query: { text: "first" } })],
      ["b", "2026-08-16 11:30:00", input({ Query: { text: "other conversation" } })],
    ]);
    const prompts = withDatabase(path, () => readWarpPrompts("a"));
    expect(prompts?.map((prompt) => prompt.text)).toEqual(["first", "second"]);
    // Warp stores local wall-clock strings; they are normalized to instants.
    expect(prompts?.[0]?.timestamp).toBe(new Date("2026-08-16T11:00:00").toISOString());
  });

  test("keeps the most recent prompts and drops repeats", () => {
    const path = fixture([
      ...Array.from({ length: 10 }, (_, index): [string, string, string] => [
        "a",
        `2026-08-16 10:${String(index).padStart(2, "0")}:00`,
        input({ Query: { text: `prompt ${index}` } }),
      ]),
      ["a", "2026-08-16 10:59:00", input({ Query: { text: "prompt 9" } })],
    ]);
    const prompts = withDatabase(path, () => readWarpPrompts("a"));
    expect(prompts?.map((prompt) => prompt.text)).toEqual([
      "prompt 2",
      "prompt 3",
      "prompt 4",
      "prompt 5",
      "prompt 6",
      "prompt 7",
      "prompt 8",
      "prompt 9",
    ]);
  });

  test("clips a very long prompt rather than holding the whole thing", () => {
    const path = fixture([["a", "2026-08-16 10:00:00", input({ Query: { text: "x".repeat(5_000) } })]]);
    expect(withDatabase(path, () => readWarpPrompts("a"))?.[0]?.text.length).toBe(2_000);
  });

  // A missing database is not the same fact as a conversation with no typed prompt.
  test("reports null when the database is absent", () => {
    const missing = join(tmpdir(), `warp-prompts-missing-${crypto.randomUUID()}.sqlite`);
    expect(withDatabase(missing, () => readWarpPrompts("a"))).toBeNull();
  });

  test("reports an empty list for a conversation whose turns carry no prompt", () => {
    const path = fixture([["a", "2026-08-16 10:00:00", input({ ActionResult: { id: "1" } })]]);
    expect(withDatabase(path, () => readWarpPrompts("a"))).toEqual([]);
  });
});
