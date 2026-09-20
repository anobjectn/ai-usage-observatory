import { afterEach, describe, expect, test } from "bun:test";
import {
  clearUpstreamCache,
  ensureUpstream,
  parseRegistryReleases,
  refreshUpstream,
  setUpstreamState,
  upstreamHealth,
  type UpstreamState,
} from "./ccusage-upstream";

const registry = {
  time: {
    created: "2025-05-01T00:00:00.000Z",
    modified: "2026-09-18T12:41:48.924Z",
    "20.0.9": "2026-06-09T23:22:36.096Z",
    "20.0.17": "2026-07-10T09:38:21.487Z",
    "20.0.18": "2026-07-20T15:12:43.130Z",
    "20.0.23": "2026-09-18T12:41:48.924Z",
    "21.0.0-beta.1": "2026-09-19T00:00:00.000Z",
    "20.0.10": "2026-06-10T18:34:38.486Z",
  },
};

const releases = parseRegistryReleases(registry);
const known = (error: string | null = null): UpstreamState => ({ releases, fetchedAt: "2026-09-20T00:00:00.000Z", error });

afterEach(() => clearUpstreamCache());

describe("parseRegistryReleases", () => {
  test("keeps stable versions in version order, not publish or string order", () => {
    expect(releases.map((release) => release.version)).toEqual(["20.0.9", "20.0.10", "20.0.17", "20.0.18", "20.0.23"]);
  });

  test("returns nothing for a document without a time map", () => {
    expect(parseRegistryReleases({})).toEqual([]);
    expect(parseRegistryReleases(null)).toEqual([]);
  });
});

describe("upstreamHealth", () => {
  test("reports the latest pin as current", () => {
    expect(upstreamHealth(known(), "20.0.23")).toEqual({ stale: false, detail: "latest release" });
  });

  test("counts releases behind from the first one the pin missed", () => {
    const health = upstreamHealth(known(), "20.0.17", () => new Date("2026-08-01T00:00:00.000Z"));
    expect(health.stale).toBe(false);
    expect(health.detail).toContain("v20.0.23 available · 2 releases behind since 2026-07-20");
  });

  test("turns stale once the pin has trailed for more than 30 days", () => {
    expect(upstreamHealth(known(), "20.0.17", () => new Date("2026-09-20T00:00:00.000Z")).stale).toBe(true);
    const single = upstreamHealth(known(), "20.0.18", () => new Date("2026-09-20T00:00:00.000Z"));
    expect(single.stale).toBe(false);
    expect(single.detail).toContain("1 release behind since 2026-09-18");
  });

  test("an unknown upstream is never stale", () => {
    expect(upstreamHealth({ releases: [], fetchedAt: null, error: null }, "20.0.17")).toEqual({ stale: false, detail: null });
    expect(upstreamHealth({ releases: [], fetchedAt: null, error: "npm registry responded 503" }, "20.0.17").detail).toContain("503");
    expect(upstreamHealth(known(), "unknown").stale).toBe(false);
  });
});

describe("upstream loading", () => {
  test("a successful refresh caches the releases and later loads do not fetch", async () => {
    const fetcher = async () => new Response(JSON.stringify(registry), { status: 200 });
    const live = await refreshUpstream(fetcher, () => new Date("2026-09-20T12:00:00.000Z"));
    expect(live.fetchedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(live.releases).toHaveLength(5);

    setUpstreamState(null);
    const reloaded = ensureUpstream(async () => { throw new Error("must not fetch"); }, () => new Date("2026-09-20T13:00:00.000Z"));
    expect(reloaded.fetchedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(reloaded.releases).toHaveLength(5);
  });

  test("a failed refresh keeps the previous releases and records the error", async () => {
    setUpstreamState(known());
    const failed = await refreshUpstream(async () => new Response("nope", { status: 503 }));
    expect(failed.releases).toHaveLength(5);
    expect(failed.error).toContain("503");
  });
});
