import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompressedTranscript, openTranscriptReader, plainTranscriptPath, readTranscriptHead, transcriptStem } from "./transcript-file";

const workspace = mkdtempSync(join(tmpdir(), "transcript-file-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const text = Array.from({ length: 2000 }, (_, line) => JSON.stringify({ line, note: "é".repeat(line % 7) })).join("\n") + "\n";

async function both(name: string) {
  const plain = join(workspace, `${name}.jsonl`);
  await writeFile(plain, text);
  await writeFile(`${plain}.zst`, Bun.zstdCompressSync(Buffer.from(text)));
  return { plain, compressed: `${plain}.zst` };
}

describe("transcript paths", () => {
  test("a compressed log keeps its plain path and stem", () => {
    const file = "/home/u/.codex/sessions/2026/02/03/rollout-2026-02-03T10-00-00-abc.jsonl.zst";
    expect(isCompressedTranscript(file)).toBe(true);
    expect(plainTranscriptPath(file)).toBe(file.slice(0, -4));
    expect(transcriptStem(file)).toBe("rollout-2026-02-03T10-00-00-abc");
    expect(transcriptStem(file.slice(0, -4))).toBe("rollout-2026-02-03T10-00-00-abc");
    expect(plainTranscriptPath("/a/b.jsonl")).toBe("/a/b.jsonl");
  });
});

describe("transcript reads", () => {
  test("the head window is the same text from either form", async () => {
    const { plain, compressed } = await both("head");
    expect(await readTranscriptHead(compressed, 5_000)).toBe(await readTranscriptHead(plain, 5_000));
    expect(await readTranscriptHead(compressed, Number.MAX_SAFE_INTEGER)).toBe(text);
  });

  test("a forward reader returns the plain file's bytes, then an empty read at the end", async () => {
    const { plain, compressed } = await both("reader");
    const reader = openTranscriptReader(compressed, 0);
    expect(reader.size).toBe(Number.POSITIVE_INFINITY);
    const plainBytes = await Bun.file(plain).bytes();
    const pieces: Uint8Array[] = [];
    for (let at = 0; ; at += 777) {
      const piece = await reader.read(at, at + 777);
      if (piece.length === 0) break;
      pieces.push(piece);
    }
    expect(Buffer.concat(pieces).equals(Buffer.from(plainBytes))).toBe(true);
    await expect(reader.read(0, 10)).rejects.toThrow("backwards");
    await reader.close();
  });
});
