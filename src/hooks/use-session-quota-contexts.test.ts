import { describe, expect, test } from "bun:test";
import { quotaContextVersion, quotaContextsToFetch } from "./use-session-quota-contexts";

const session = (lastActivity: string, totalTokens = 100) => ({ totalTokens, metadata: { lastActivity } });

describe("session quota reading versions", () => {
  test("a session inside the closing tolerance changes version with every collection", () => {
    const active = session("2026-10-13T12:00:00.000Z");
    expect(quotaContextVersion(active, "2026-10-13T12:10:00.000Z"))
      .not.toBe(quotaContextVersion(active, "2026-10-13T12:11:00.000Z"));
  });

  test("an older session keeps one version until its activity changes", () => {
    const finished = session("2026-10-13T10:00:00.000Z");
    expect(quotaContextVersion(finished, "2026-10-13T12:10:00.000Z"))
      .toBe(quotaContextVersion(finished, "2026-10-13T12:11:00.000Z"));
    expect(quotaContextVersion(session("2026-10-13T10:00:00.000Z", 200), "2026-10-13T12:10:00.000Z"))
      .not.toBe(quotaContextVersion(finished, "2026-10-13T12:10:00.000Z"));
    expect(quotaContextVersion(session("2026-10-13T10:05:00.000Z"), "2026-10-13T12:10:00.000Z"))
      .not.toBe(quotaContextVersion(finished, "2026-10-13T12:10:00.000Z"));
  });
});

describe("choosing which readings to fetch", () => {
  const versionOf = (sessionId: string) => (sessionId === "b" ? "v2" : "v1");

  test("skips answered and in-flight versions, and asks again for a changed or failed one", () => {
    const settled = new Map([["a", "v1"], ["b", "v1"]]);
    const pending = new Map([["c", "v1"]]);
    // "b" changed version; "d" has no answer, which is also the state after a failed batch.
    expect(quotaContextsToFetch(["a", "b", "c", "d", ""], versionOf, settled, pending))
      .toEqual([{ sessionId: "b", version: "v2" }, { sessionId: "d", version: "v1" }]);
  });
});
