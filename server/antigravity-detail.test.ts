import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTIGRAVITY_SQL, DATABASE_CHANGED_WHILE_READ, collectAntigravity, readProviderDatabase, resetAntigravityCache } from "./antigravity";
import {
  ANTIGRAVITY_DETAIL_SQL,
  MAX_DETAIL_PAYLOAD_BYTES,
  MAX_DETAIL_STEPS,
  MAX_STEP_METADATA_BYTES,
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

describe("prompt structure", () => {
  test("a request nested inside injected context is never the prompt", () => {
    const canary = `CANARY-NESTED-${crypto.randomUUID()}`;
    const nested = `<runtime_info><user_request>${canary}</user_request></runtime_info>`;
    expect(promptFromItems([nested, "<user_request>Actual question</user_request>"])).toBe("Actual question");
    expect(promptFromItems([nested, "ordinary prompt"])).toBe("ordinary prompt");
    const detail = decode([input(0, [nested, "ordinary prompt"])]);
    expect(detail.prompts.map((prompt) => prompt.text)).toEqual(["ordinary prompt"]);
    expect(JSON.stringify(detail)).not.toContain(canary);
  });

  test("harness blocks at an item's edges are removed, and blocks only of harness context are dropped", () => {
    expect(promptFromItems(["<runtime_info>SECRET</runtime_info>\nhello"])).toBe("hello");
    expect(promptFromItems(["hello\n<environment_context>E</environment_context>"])).toBe("hello");
    expect(promptFromItems(["plain ask", "<runtime_info>R</runtime_info><environment_context>E</environment_context>"])).toBe("plain ask");
  });

  test("a wrapped request keeps only its user_request blocks; a question that quotes or is markup stays as written", () => {
    expect(promptFromItems(['<meta a="1">m</meta>\n<user_request>\nreal <b>bold</b> ask\n</user_request>', "<runtime_info>rt</runtime_info>"])).toBe("real <b>bold</b> ask");
    expect(promptFromItems(["how do I parse <user_request>x</user_request> here"])).toBe("how do I parse <user_request>x</user_request> here");
    expect(promptFromItems(["<div>plain html question</div>"])).toBe("<div>plain html question</div>");
  });
});

describe("outputs", () => {
  test("the final reply is shown and the thinking never is", () => {
    const thinking = `CANARY-THINKING-${crypto.randomUUID()}`;
    const detail = decode([turn(3, { reply: "Done: the test is fixed.", thinking })]);
    expect(detail.outputs).toEqual([{ text: "Done: the test is fixed.", timestamp: new Date(t0 + 3 * second).toISOString(), truncated: false }]);
    expect(JSON.stringify(detail)).not.toContain(thinking);
  });

  test("a reply is shown only while its mirror is present and agrees", () => {
    expect(decode([turn(1, { reply: "first", mirror: "something else" })]).outputs).toEqual([]);
    // A renumbered turn: the thinking moved into field 1 and the mirror is gone. No reply, never
    // the thinking.
    const thinking = `CANARY-RENUMBERED-${crypto.randomUUID()}`;
    const renumbered = decode([turn(1, { reply: thinking, mirror: null })]);
    expect(renumbered.outputs).toEqual([]);
    expect(JSON.stringify(renumbered)).not.toContain(thinking);
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
      // Created, then overwritten in the same session: still new, with the overwrite's one line.
      { path: "/w/src/new.ts", status: "added", additions: 1, deletions: 0 },
    ]);
    expect([detail.additions, detail.deletions]).toEqual([7, 2]);
    // A call whose arguments do not parse is still a tool call.
    expect(detail.tools.find((tool) => tool.name === "edit_file")?.count).toBe(4);
  });
});

describe("file ledger", () => {
  test("two files that share a name stay two rows", () => {
    const detail = decode([calls(
      { name: "write_file", args: { Path: "/w/README.md", Content: "one\n" } },
      { name: "write_file", args: { Path: "/w/docs/README.md", Content: "one\n" } },
    )]);
    expect(detail.files.map((file) => [file.path, file.status, file.additions, file.deletions]).sort()).toEqual([
      ["/w/README.md", "added", 1, 0],
      ["/w/docs/README.md", "added", 1, 0],
    ]);
  });

  test("a file overwritten with unknown counts keeps unknown counts after a later edit", () => {
    const detail = decode([calls(
      { name: "write_file", args: { Path: "/w/b.ts", Content: "replaced", Overwrite: true } },
      { name: "edit_file", args: { Path: "/w/b.ts", Target: "x", Replacement: "y" } },
    )]);
    expect(detail.files).toEqual([{ path: "/w/b.ts", status: "modified", additions: null, deletions: null }]);
    // The edit's own lines still count toward the session total.
    expect([detail.additions, detail.deletions]).toEqual([1, 1]);
  });

  test("many distinct paths stay linear", () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ name: "write_file", args: { Path: `/w/dir${index}/file${index}.ts`, Content: "x\n" } }));
    const started = performance.now();
    const detail = decode([calls(...entries)]);
    expect(detail.files).toHaveLength(10_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("an edit too large to compare line by line counts every changed line", () => {
    const before = Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n");
    expect(editLineCounts(before, after)).toEqual({ additions: 600, deletions: 600 });
  });
});

describe("budgets", () => {
  const row = (idx: number, payload: Uint8Array | null, metadata: Uint8Array | null = null) => ({ idx, step_type: 14, metadata, step_payload: payload });

  test("more than the step limit is unavailable, not partial", () => {
    function* steps() { for (let idx = 0; idx <= MAX_DETAIL_STEPS; idx++) yield row(idx, null); }
    expect(decodeAntigravitySteps(steps())).toBeNull();
  });

  test("payload and metadata bytes together past the byte budget are unavailable", () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const count = Math.ceil(MAX_DETAIL_PAYLOAD_BYTES / (2 * chunk.length)) + 1;
    function* steps() { for (let idx = 0; idx < count; idx++) yield row(idx, chunk, chunk); }
    expect(decodeAntigravitySteps(steps())).toBeNull();
    function* metadataOnly() { for (let idx = 0; idx < 2 * count; idx++) yield row(idx, null, chunk); }
    expect(decodeAntigravitySteps(metadataOnly())).toBeNull();
  });

  test("oversized step metadata is not read, and the step keeps its prompt without a time", () => {
    const path = writeDetailConversation("big-metadata", [{ ...input(0, ["ask"]), metadata: new Uint8Array(MAX_STEP_METADATA_BYTES + 1) }]);
    const detail = readAntigravityDetail(path)!;
    expect(detail.prompts).toEqual([{ text: "ask", timestamp: null }]);
  });

  test("a file that changed during the read is retried once, then unavailable", () => {
    const path = writeDetailConversation("changing", [input(0, ["ask"])]);
    let calls = 0;
    const changedOnce: typeof readProviderDatabase = (file, read) => (++calls === 1 ? { ok: false, reason: DATABASE_CHANGED_WHILE_READ } : readProviderDatabase(file, read));
    expect(readAntigravityDetail(path, changedOnce)?.prompts.map((prompt) => prompt.text)).toEqual(["ask"]);
    expect(calls).toBe(2);
    calls = 0;
    const alwaysChanged: typeof readProviderDatabase = () => (++calls, { ok: false, reason: DATABASE_CHANGED_WHILE_READ });
    expect(readAntigravityDetail(path, alwaysChanged)).toBeNull();
    expect(calls).toBe(2);
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
