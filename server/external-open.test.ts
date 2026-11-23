import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExternalOpenError,
  externalOpenCommand,
  externalOpenOriginAllowed,
  nearestExistingParent,
  resolveListedFilePath,
} from "./external-open";

describe("external-open request boundary", () => {
  test("allows local browser origins and rejects cross-site callers", () => {
    expect(
      externalOpenOriginAllowed(
        new Headers({ origin: "http://127.0.0.1:5173" }),
      ),
    ).toBe(true);
    expect(
      externalOpenOriginAllowed(new Headers({ origin: "http://localhost:4318" })),
    ).toBe(true);
    expect(
      externalOpenOriginAllowed(
        new Headers({ origin: "https://mac.tailnet.ts.net" }),
        ["mac.tailnet.ts.net"],
      ),
    ).toBe(true);
    expect(
      externalOpenOriginAllowed(new Headers({ host: "127.0.0.1:4318" })),
    ).toBe(true);
    expect(
      externalOpenOriginAllowed(
        new Headers({ host: "mac.tailnet.ts.net" }),
        ["mac.tailnet.ts.net"],
      ),
    ).toBe(false);
    expect(
      externalOpenOriginAllowed(
        new Headers({
          origin: "https://example.com",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toBe(false);
  });

  test("resolves listed relative paths against the indexed working directory", () => {
    expect(resolveListedFilePath("/work/project", "src/App.tsx")).toBe(
      "/work/project/src/App.tsx",
    );
    expect(resolveListedFilePath("/ignored", "/work/shared/file.ts")).toBe(
      "/work/shared/file.ts",
    );
    expect(() => resolveListedFilePath(null, "src/App.tsx")).toThrow(
      ExternalOpenError,
    );
  });

  test("a missing file falls back to the nearest folder, never to a file in its place", async () => {
    const directory = mkdtempSync(join(tmpdir(), "external-open-"));
    try {
      writeFileSync(join(directory, "tool.command"), "#!/bin/sh\n");
      expect(await nearestExistingParent(join(directory, "tool.command", "notes.md"))).toBe(directory);
      expect(await nearestExistingParent(join(directory, "gone", "notes.md"))).toBe(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("builds argv arrays without interpreting path text as shell input", () => {
    const path = "/tmp/a; touch /tmp/not-run.ts";
    expect(externalOpenCommand("reveal", path, "darwin")).toEqual([
      "/usr/bin/open",
      "-R",
      path,
    ]);
    expect(externalOpenCommand("vscode", path, "darwin")).toEqual([
      "/usr/bin/open",
      "-b",
      "com.microsoft.VSCode",
      path,
    ]);
    expect(
      externalOpenCommand("default-editor", path, "darwin"),
    ).toEqual(["/usr/bin/open", "-t", path]);
  });
});

describe("Antigravity sessions", () => {
  test("have no transcript to open: the provider database is refused", async () => {
    const { db } = await import("./store");
    const { openSessionExternalTarget } = await import("./external-open");
    db.query(`INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size)
      VALUES ('antigravity-open', 'antigravity', 'open', '/tmp/antigravity-open.db', '/tmp', 1, 1)`).run();
    try {
      const attempt = openSessionExternalTarget("antigravity-open", "reveal", { kind: "transcript" });
      await expect(attempt).rejects.toBeInstanceOf(ExternalOpenError);
      await expect(openSessionExternalTarget("antigravity-open", "vscode", { kind: "transcript" })).rejects.toMatchObject({ status: 409 });
    } finally {
      db.query("DELETE FROM session_paths WHERE session_id = 'antigravity-open'").run();
    }
  });

  test("open only the files their edit and write tools changed", async () => {
    const { db } = await import("./store");
    const { openSessionExternalTarget } = await import("./external-open");
    const { resetAntigravityCache } = await import("./antigravity");
    const { modelTurnPayload, writeConversation } = await import("./antigravity-fixture");
    const { testAntigravityDirectory } = await import("./test-setup");
    const directory = mkdtempSync(join(tmpdir(), "antigravity-open-"));
    const root = join(directory, "install/antigravity-acp");
    process.env.ANTIGRAVITY_DATA_DIRS = root;
    resetAntigravityCache();
    const listed = join(directory, "workspace", "gone.ts");
    const path = writeConversation(root, "files", {
      steps: [{
        idx: 0, stepType: 15, at: Date.UTC(2026, 10, 21), usage: { input: 1, output: 1 },
        payloadBytes: modelTurnPayload({ calls: [{ name: "edit_file", args: { Path: listed, Target: "a", Replacement: "b" } }] }),
      }],
    });
    db.query(`INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size)
      VALUES ('antigravity-files', 'antigravity', 'files', ?, ?, 1, 1)`).run(path, directory);
    try {
      await expect(openSessionExternalTarget("antigravity-files", "vscode", { kind: "transcript" })).rejects.toMatchObject({ status: 409 });
      await expect(openSessionExternalTarget("antigravity-files", "vscode", { kind: "file", path: join(directory, "unlisted.ts") })).rejects.toMatchObject({ status: 403 });
      // A listed path passes the listing check; this one no longer exists, so nothing is launched.
      await expect(openSessionExternalTarget("antigravity-files", "vscode", { kind: "file", path: listed })).rejects.toMatchObject({ status: 404, message: "That file no longer exists locally." });
      await expect(openSessionExternalTarget("antigravity-unknown", "vscode", { kind: "file", path: listed })).rejects.toMatchObject({ status: 404 });
    } finally {
      db.query("DELETE FROM session_paths WHERE session_id = 'antigravity-files'").run();
      process.env.ANTIGRAVITY_DATA_DIRS = testAntigravityDirectory;
      resetAntigravityCache();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
