import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHead, sessionReportKeys } from "./path-indexer";

// `server/test-setup.ts` (preloaded via bunfig.toml) has already pinned the database to a
// throwaway path; this file only needs its own directory for transcript fixtures.
const workspace = mkdtempSync(join(tmpdir(), "path-indexer-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

test("parseHead finds cwd past an oversized early line", async () => {
  // A screenshot pasted into the first real message can run hundreds of KB to a few MB on its
  // own line; the header scan has to read past it rather than stop at a fixed byte offset.
  const oversizedLine = JSON.stringify({
    type: "user",
    sessionId: "queued-before-cwd",
    message: { role: "user", content: "x".repeat(300_000) },
  });
  const cwdLine = JSON.stringify({
    type: "user",
    sessionId: "abc-123",
    cwd: "/Users/example/project",
    message: { role: "user", content: "hi" },
  });
  const file = join(workspace, "oversized-head.jsonl");
  await writeFile(file, [oversizedLine, cwdLine].join("\n"));

  const { cwd, nativeKey } = await parseHead(file, "claude");

  expect(cwd).toBe("/Users/example/project");
  expect(nativeKey).toBe("abc-123");
});

test("parseHead resolves codex cwd from a session_meta payload", async () => {
  const line = JSON.stringify({
    type: "session_meta",
    payload: { id: "019fbc20-e7b5-7282-b1e9-3658072557df", cwd: "/Users/example/codex-project" },
  });
  const file = join(workspace, "codex-head.jsonl");
  await writeFile(file, line);

  const { cwd, nativeKey } = await parseHead(file, "codex");

  expect(cwd).toBe("/Users/example/codex-project");
  expect(nativeKey).toBe("019fbc20-e7b5-7282-b1e9-3658072557df");
});

test("sessionReportKeys matches a codex transcript by basename once it has no dated marker", () => {
  // Codex moves an aged-out session into a flat archived_sessions/ directory, with no
  // /.codex/sessions/<date>/ prefix left to extract a dated key from; the basename fallback,
  // shared with every agent, is what still has to line up with ccusage's own reported id.
  const archivedFile =
    "/Users/example/.codex/archived_sessions/rollout-2026-08-01T03-01-40-019fbc20-e7b5-7282-b1e9-3658072557df.jsonl";
  const keys = sessionReportKeys("codex", "019fbc20-e7b5-7282-b1e9-3658072557df", archivedFile);

  expect(keys).toContain("rollout-2026-08-01T03-01-40-019fbc20-e7b5-7282-b1e9-3658072557df");
});
