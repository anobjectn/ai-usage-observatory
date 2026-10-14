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
