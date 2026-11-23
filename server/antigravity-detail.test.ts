import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTIGRAVITY_SQL, collectAntigravity, resetAntigravityCache } from "./antigravity";
import {
  ANTIGRAVITY_DETAIL_SQL,
  antigravityDetailSource,
  decodeAntigravitySteps,
  editLineCounts,
  lineCount,
  promptFromItems,
  readAntigravityDetail,
} from "./antigravity-detail";
import {
  modelTurnPayload,
  openLiveWriter,
  stepMetadata,
  userInputPayload,
  writeConversation,
  writeOrphanWal,
  type FixtureConversation,
  type FixtureStep,
  type FixtureToolCall,
} from "./antigravity-fixture";
import { detailOutputSampleCharacters, detailOutputSampleCount, detailPromptCharacters, detailPromptCount } from "./session-detail";
import { db } from "./store";
import { testAntigravityDirectory } from "./test-setup";

const t0 = Date.UTC(2026, 10, 21, 20, 0, 0);
const second = 1000;

let directory: string;
let base: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "antigravity-detail-test-"));
  base = join(directory, "install/antigravity-acp");
  mkdirSync(join(base, "conversations"), { recursive: true });
  process.env.ANTIGRAVITY_DATA_DIRS = base;
  resetAntigravityCache();
  db.query("DELETE FROM session_paths WHERE agent = 'antigravity'").run();
});

afterEach(() => {
  process.env.ANTIGRAVITY_DATA_DIRS = testAntigravityDirectory;
  rmSync(directory, { recursive: true, force: true });
  resetAntigravityCache();
  db.query("DELETE FROM session_paths WHERE agent = 'antigravity'").run();
});

const input = (idx: number, items: string[], options: { concatenated?: string } = {}): FixtureStep =>
  ({ idx, stepType: 14, at: t0 + idx * second, payloadBytes: userInputPayload(items, options) });
const turn = (idx: number, turnPayload: Parameters<typeof modelTurnPayload>[0]): FixtureStep =>
  ({ idx, stepType: 15, at: t0 + idx * second, usage: { input: 10, output: 5, messageId: `m${idx}` }, payloadBytes: modelTurnPayload(turnPayload) });

/** Decodes fixture steps directly, without a database. */
function decode(steps: FixtureStep[]) {
  return decodeAntigravitySteps(steps.map((step) => ({
    idx: step.idx,
    step_type: step.stepType ?? 14,
    metadata: step.metadata !== undefined ? step.metadata : stepMetadata(step),
    step_payload: step.payloadBytes ?? null,
  })))!;
}

function calls(...entries: FixtureToolCall[]) {
  return turn(1, { calls: entries });
}

describe("prompts", () => {
  test("one plain item is the prompt, with its step time", () => {
    const detail = decode([input(0, ["Fix the flaky test"])]);
    expect(detail.prompts).toEqual([{ text: "Fix the flaky test", timestamp: new Date(t0).toISOString() }]);
    expect(detail.eventsRead).toBe(1);
  });

  test("a wrapped request yields only its inner text; injected context and 19.2 never appear", () => {
    const harness = `CANARY-HARNESS-${crypto.randomUUID()}`;
    const concatenated = `CANARY-CONCAT-${crypto.randomUUID()}`;
    const detail = decode([input(0, [
      "<user_request>\nRename the helper <mention>utils.ts</mention>\n</user_request>",
      `<runtime_info>${harness}</runtime_info>`,
    ], { concatenated })]);
    expect(detail.prompts.map((prompt) => prompt.text)).toEqual(["Rename the helper <mention>utils.ts</mention>"]);
    expect(JSON.stringify(detail)).not.toContain(harness);
    expect(JSON.stringify(detail)).not.toContain(concatenated);
  });

  test("a lone harness block is no prompt, but a lone plain prompt that starts with a tag is kept", () => {
    expect(promptFromItems(["<runtime_info>context</runtime_info>"])).toBe("");
    expect(promptFromItems(["<environment_context>x</environment_context>"])).toBe("");
    expect(promptFromItems(["<div>why is this centered?</div>"])).toBe("<div>why is this centered?</div>");
    expect(promptFromItems(["<notes>a</notes>", "plain question"])).toBe("plain question");
  });

  test("duplicates collapse, only the newest prompts are kept, and long ones are cut", () => {
    const steps = [input(0, ["repeat"]), input(1, ["repeat"])];
    for (let index = 0; index < detailPromptCount + 2; index++) steps.push(input(2 + index, [`prompt ${index}`]));
    steps.push(input(40, ["y".repeat(detailPromptCharacters + 50)]));
    const detail = decode(steps);
    expect(detail.prompts).toHaveLength(detailPromptCount);
    expect(detail.prompts.at(-1)!.text).toHaveLength(detailPromptCharacters);
    expect(detail.prompts.map((prompt) => prompt.text)).not.toContain("repeat");
  });
});

describe("outputs", () => {
  test("the final reply is shown and the thinking never is", () => {
    const thinking = `CANARY-THINKING-${crypto.randomUUID()}`;
    const detail = decode([turn(3, { reply: "Done: the test is fixed.", thinking })]);
    expect(detail.outputs).toEqual([{ text: "Done: the test is fixed.", timestamp: new Date(t0 + 3 * second).toISOString(), truncated: false }]);
    expect(JSON.stringify(detail)).not.toContain(thinking);
  });

  test("a reply its mirror disagrees with is not shown; one without a mirror is", () => {
    expect(decode([turn(1, { reply: "first", mirror: "something else" })]).outputs).toEqual([]);
    expect(decode([turn(1, { reply: "unmirrored", mirror: null })]).outputs.map((output) => output.text)).toEqual(["unmirrored"]);
  });

  test("long replies are clipped and only the newest samples are kept", () => {
    const steps = Array.from({ length: detailOutputSampleCount + 3 }, (_, index) => turn(index, { reply: `reply ${index}` }));
    steps.push(turn(50, { reply: "z".repeat(detailOutputSampleCharacters + 1) }));
    const detail = decode(steps);
    expect(detail.outputs).toHaveLength(detailOutputSampleCount);
    expect(detail.outputs.at(-1)).toMatchObject({ truncated: true });
    expect(detail.outputs.at(-1)!.text).toHaveLength(detailOutputSampleCharacters);
  });
});

describe("tools", () => {
  test("counts calls by name and skips names that are not names", () => {
    const detail = decode([
      calls(
        { name: "read_file", args: { Path: "/w/a.ts" } },
        { name: "read_file", args: { Path: "/w/b.ts" } },
        { name: "mcp_t3-code_delegate_task", args: { toolSummary: "x" } },
        { name: "run\u0007command", args: {} },
        { name: "", args: {} },
      ),
    ]);
    expect(detail.tools).toEqual([{ name: "read_file", count: 2 }, { name: "mcp_t3-code_delegate_task", count: 1 }]);
    expect(detail.files).toEqual([]);
  });
});

describe("files and patches", () => {
  test("an edit counts only the lines that changed", () => {
    expect(editLineCounts("a\nb\nc\nd", "a\nB\nb2\nd")).toEqual({ additions: 2, deletions: 2 });
    expect(editLineCounts("keep\nold\nkeep", "keep\nnew one\nnew two\nkeep")).toEqual({ additions: 2, deletions: 1 });
    expect(editLineCounts("x", "x")).toEqual({ additions: 0, deletions: 0 });
    expect(editLineCounts("a\nb\nc", "c\nb\na")).toEqual({ additions: 2, deletions: 2 });
    expect(lineCount("")).toBe(0);
    expect(lineCount("one\ntwo\n")).toBe(2);
    expect(lineCount("one\ntwo")).toBe(2);
  });

  test("edits and writes become file changes that merge per path and add up", () => {
    const detail = decode([
      calls(
        { name: "edit_file", args: { Path: "/w/src/app.ts", Target: "keep\nold\nkeep", Replacement: "keep\nnew one\nnew two\nkeep" } },
        { name: "edit_file", args: { Path: "/w/src/app.ts", Target: "x", Replacement: "y" } },
        { name: "write_file", args: { Path: "file:///w/src/new.ts", Content: "one\ntwo\nthree\n" } },
        { name: "write_file", args: { Path: "/w/src/new.ts", Content: "replaced", Overwrite: true } },
        { name: "write_file", args: { Path: "/w/README.md", Content: "rewritten", Overwrite: true } },
        { name: "read_file", args: { Path: "/w/src/read.ts" } },
        { name: "run_command", args: { CommandLine: "rm -rf build" } },
        { name: "edit_file", args: "{not json" },
        { name: "edit_file", args: { Path: 7, Target: "a", Replacement: "b" } },
      ),
    ]);
    expect(detail.files).toEqual([
      { path: "/w/README.md", status: "modified", additions: null, deletions: null },
      { path: "/w/src/app.ts", status: "modified", additions: 3, deletions: 2 },
      { path: "/w/src/new.ts", status: "added", additions: 3, deletions: 0 },
    ]);
    expect([detail.additions, detail.deletions]).toEqual([6, 2]);
    // A call whose arguments do not parse is still a tool call.
    expect(detail.tools.find((tool) => tool.name === "edit_file")?.count).toBe(4);
  });
});

describe("fails closed", () => {
  test("bytes that are not the expected messages give an empty detail", () => {
    const junk = new Uint8Array([0xff, 0xff, 0xff, 0x07, 0x01]);
    const detail = decode([
      { idx: 0, stepType: 14, at: t0, payloadBytes: junk },
      { idx: 1, stepType: 15, at: t0, payloadBytes: junk },
      { idx: 2, stepType: 15, at: t0, payloadBytes: new Uint8Array([0x0a, 0x02, 0xc3, 0x28]) },
    ]);
    expect(detail).toMatchObject({ available: true, prompts: [], outputs: [], tools: [], files: [], eventsRead: 0 });
  });
});

function writeDetailConversation(id: string, steps: FixtureStep[], extra: Partial<FixtureConversation> = {}) {
  return writeConversation(base, id, { steps, ...extra });
}

function hash(path: string) {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

describe("reading a conversation database", () => {
  test("reads a closed database immutably, leaves it byte-identical, and creates no sidecar", () => {
    const path = writeDetailConversation("closed", [input(0, ["hello"]), turn(1, { reply: "hi", calls: [{ name: "read_file", args: { Path: "/w/a" } }] })]);
    const before = hash(path);
    const detail = readAntigravityDetail(path)!;
    expect(detail.prompts.map((prompt) => prompt.text)).toEqual(["hello"]);
    expect(detail.outputs.map((output) => output.text)).toEqual(["hi"]);
    expect(detail.tools).toEqual([{ name: "read_file", count: 1 }]);
    expect(detail.eventsRead).toBe(2);
    expect(hash(path)).toBe(before);
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  });

  test("step type 132 rows and oversized payloads are never read", () => {
    const canary = `CANARY-RESULT-${crypto.randomUUID()}`;
    const oversized = new Uint8Array(8_000_001);
    oversized.set(new TextEncoder().encode(canary));
    const path = writeDetailConversation("skips", [
      input(0, ["ask"]),
      { idx: 1, stepType: 132, at: t0, payloadBytes: modelTurnPayload({ reply: canary }) },
      { idx: 2, stepType: 15, at: t0, payloadBytes: oversized },
    ]);
    const detail = readAntigravityDetail(path)!;
    expect(JSON.stringify(detail)).not.toContain(canary);
    expect(detail.eventsRead).toBe(1);
  });

  test("a steps table without its payload column is unavailable", () => {
    const path = writeDetailConversation("drift", [{ idx: 0, stepType: 14, at: t0 }], { stepColumns: ["idx INTEGER", "step_type INTEGER", "status INTEGER", "metadata BLOB"] });
    expect(readAntigravityDetail(path)).toBeNull();
  });

  test("a live writer's rows still in its log are read", () => {
    const path = writeDetailConversation("live", [input(0, ["first"])]);
    const writer = openLiveWriter(path, { steps: [turn(1, { reply: "from the log" })] });
    try {
      expect(readAntigravityDetail(path)!.outputs.map((output) => output.text)).toEqual(["from the log"]);
    } finally {
      writer.close();
    }
  });

  test("a log without its index is refused and no index is created", () => {
    const path = writeOrphanWal(base, "orphan", { steps: [input(0, ["base"])] }, { steps: [turn(1, { reply: "late" })] });
    expect(readAntigravityDetail(path)).toBeNull();
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test("a missing database is unavailable", () => {
    expect(readAntigravityDetail(join(base, "conversations", "gone.db"))).toBeNull();
  });
});

describe("finding the conversation", () => {
  test("uses the collection's chosen file, then the stored row, and only inside a configured root", () => {
    const path = writeDetailConversation("found", [input(0, ["q"]), turn(1, { reply: "a", calls: [{ name: "edit_file", args: { Path: "/w/x.ts", Target: "a", Replacement: "b" } }] })]);
    expect(antigravityDetailSource("antigravity-found")).toBeNull();
    collectAntigravity("UTC");
    expect(antigravityDetailSource("antigravity-found")).toEqual({ sourceFile: path, cwd: null });

    resetAntigravityCache();
    const insert = db.query(`INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size)
      VALUES (?, ?, ?, ?, '/w', 1, 1)`);
    insert.run("antigravity-found", "antigravity", "found", path);
    expect(antigravityDetailSource("antigravity-found")).toEqual({ sourceFile: path, cwd: "/w" });
    // A row for another agent, a basename that is not the id, and a file outside every root.
    insert.run("antigravity-found", "codex", "found", path);
    expect(antigravityDetailSource("antigravity-found")).toBeNull();
    insert.run("antigravity-found", "antigravity", "found", join(base, "conversations", "other.db"));
    expect(antigravityDetailSource("antigravity-found")).toBeNull();
    insert.run("antigravity-found", "antigravity", "found", join(directory, "elsewhere", "found.db"));
    expect(antigravityDetailSource("antigravity-found")).toBeNull();
    expect(antigravityDetailSource("antigravity-..")).toBeNull();
    expect(antigravityDetailSource("antigravity-a/b")).toBeNull();
  });
});

describe("privacy boundary", () => {
  test("the collection never loads the detail reader and none of its SQL selects content", () => {
    for (const sql of ANTIGRAVITY_SQL) expect(sql).not.toBe(ANTIGRAVITY_DETAIL_SQL);
    const source = readFileSync(join(import.meta.dir, "antigravity.ts"), "utf8");
    expect(source).not.toMatch(/(from\s+|import\()\s*["']\.\/antigravity-detail["']/);
    // The detail read selects payloads of user-input and model-turn steps only.
    expect(ANTIGRAVITY_DETAIL_SQL).toMatch(/WHERE step_type IN \(14, 15\)/);
    expect(ANTIGRAVITY_DETAIL_SQL).not.toMatch(/\b(title|preview|raw_summary|fts|gen_metadata)\b|\*/i);
  });

  test("the detail reader keeps no copy of what it read", () => {
    const path = writeDetailConversation("forget", [input(0, ["remember me"])]);
    readAntigravityDetail(path);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of tables) expect(JSON.stringify(db.query(`SELECT * FROM "${table}"`).all())).not.toContain("remember me");
  });
});
