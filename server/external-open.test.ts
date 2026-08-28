import { describe, expect, test } from "bun:test";
import {
  ExternalOpenError,
  externalOpenCommand,
  externalOpenOriginAllowed,
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

  test("builds argv arrays without interpreting path text as shell input", () => {
    const path = "/tmp/a; touch /tmp/not-run.ts";
    expect(externalOpenCommand("reveal", path, false, "darwin")).toEqual([
      "/usr/bin/open",
      "-R",
      path,
    ]);
    expect(externalOpenCommand("vscode", path, false, "darwin")).toEqual([
      "/usr/bin/open",
      "-b",
      "com.microsoft.VSCode",
      path,
    ]);
    expect(
      externalOpenCommand("default-editor", path, false, "darwin"),
    ).toEqual(["/usr/bin/open", "-t", path]);
  });
});
