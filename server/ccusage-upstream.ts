import { offlinePricing } from "./rate-card";
import { db } from "./store";

/** The pin only moves when someone audits upstream, and a stale pin has silently lost usage
 * before (20.0.17 dropped every Fable 5.1 entry). This check puts the distance to the latest
 * stable release on the ccusage source-health entry. It never upgrades anything. */
export const CCUSAGE_REGISTRY_URL = "https://registry.npmjs.org/ccusage";

export type UpstreamRelease = { version: string; publishedAt: string };
export type UpstreamState = { releases: UpstreamRelease[]; fetchedAt: string | null; error: string | null };

const cacheTtlMs = 24 * 60 * 60 * 1000;
const fetchTimeoutMs = 10_000;
/** A pin may trail upstream this long before the source reads as degraded: ccusage can ship
 * several releases a week, so "behind at all" would keep the entry permanently amber. */
const graceDays = 30;
/** The registry document lists every version ever published; only the tail can be ahead of a pin. */
const keepReleases = 50;

const stable = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(left: string, right: string) {
  const a = stable.exec(left);
  const b = stable.exec(right);
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Stable releases in ascending version order. Prereleases are skipped: the pin never tracks them. */
export function parseRegistryReleases(json: unknown): UpstreamRelease[] {
  const time = (json as { time?: unknown } | null)?.time;
  if (!time || typeof time !== "object") return [];
  return Object.entries(time as Record<string, unknown>)
    .filter((entry): entry is [string, string] => stable.test(entry[0]) && typeof entry[1] === "string" && !Number.isNaN(Date.parse(entry[1])))
    .map(([version, publishedAt]) => ({ version, publishedAt }))
    .sort((left, right) => compareVersions(left.version, right.version))
    .slice(-keepReleases);
}

type CachedReleases = { fetchedAt: string; releases: UpstreamRelease[] };

function readCache(): CachedReleases | null {
  const row = db.query("SELECT fetched_at, releases_json FROM ccusage_upstream_cache WHERE id = 1").get() as { fetched_at: string; releases_json: string } | null;
  if (!row) return null;
  try {
    const releases = JSON.parse(row.releases_json) as UpstreamRelease[];
    return Array.isArray(releases) ? { fetchedAt: row.fetched_at, releases } : null;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedReleases) {
  db.query(`INSERT INTO ccusage_upstream_cache (id, fetched_at, releases_json) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, releases_json = excluded.releases_json`)
    .run(entry.fetchedAt, JSON.stringify(entry.releases));
}

export function clearUpstreamCache() {
  db.query("DELETE FROM ccusage_upstream_cache").run();
  state = null;
}

let state: UpstreamState | null = null;
let refreshing: Promise<UpstreamState> | null = null;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function load(): UpstreamState {
  if (!state) {
    const cached = readCache();
    state = cached ? { releases: cached.releases, fetchedAt: cached.fetchedAt, error: null } : { releases: [], fetchedAt: null, error: null };
  }
  return state;
}

/** Fetches the release list and replaces the cache. Never throws: a failed fetch keeps whatever
 * state was current and records the error for the source-health entry. */
export async function refreshUpstream(fetcher: Fetcher = fetch, now = () => new Date()): Promise<UpstreamState> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = load();
    try {
      const response = await fetcher(CCUSAGE_REGISTRY_URL, { signal: AbortSignal.timeout(fetchTimeoutMs) });
      if (!response.ok) throw new Error(`npm registry responded ${response.status}`);
      const releases = parseRegistryReleases(await response.json());
      if (releases.length === 0) throw new Error("npm registry listed no stable ccusage releases");
      const entry = { fetchedAt: now().toISOString(), releases };
      writeCache(entry);
      state = { releases, fetchedAt: entry.fetchedAt, error: null };
    } catch (error) {
      state = { ...current, error: error instanceof Error ? error.message : String(error) };
    }
    return state;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Current release list without waiting on the network. Kicks off a background refresh when the
 * cache is stale and the app is not pinned offline, so a collection tick never waits on npm. */
export function ensureUpstream(fetcher: Fetcher = fetch, now = () => new Date()): UpstreamState {
  const current = load();
  const age = current.fetchedAt ? now().getTime() - Date.parse(current.fetchedAt) : Number.POSITIVE_INFINITY;
  if (!offlinePricing() && age > cacheTtlMs && !refreshing) void refreshUpstream(fetcher, now);
  return current;
}

/** Test seam. */
export function setUpstreamState(next: UpstreamState | null) {
  state = next;
}

/** The source-health fragment for the pinned version. `stale` turns the ccusage entry degraded;
 * an unknown upstream (never fetched, offline, unparseable pin) is never stale. */
export function upstreamHealth(current: UpstreamState, pinned: string, now = () => new Date()) {
  if (!stable.test(pinned) || current.releases.length === 0) {
    return { stale: false, detail: current.error ? `upstream check failed: ${current.error}` : null };
  }
  const newer = current.releases.filter((release) => compareVersions(release.version, pinned) > 0);
  if (newer.length === 0) return { stale: false, detail: "latest release" };
  const latest = newer[newer.length - 1];
  const behindDays = Math.floor((now().getTime() - Date.parse(newer[0].publishedAt)) / 86_400_000);
  const count = `${newer.length} ${newer.length === 1 ? "release" : "releases"}`;
  return {
    stale: behindDays > graceDays,
    detail: `v${latest.version} available · ${count} behind since ${newer[0].publishedAt.slice(0, 10)} — run the audit-ccusage-upstream skill`,
  };
}
