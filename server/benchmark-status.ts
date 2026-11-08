/** Reachability of the benchmark pages the comparison viewer frames. A browser cannot read a
 * cross-origin page's status, so the local server asks instead. The request carries no usage data:
 * it is the same page load the viewer would make, and it runs only when the app asks for status,
 * at most once per site every ten minutes. */
import { BENCHMARK_SITES, type BenchmarkSiteStatus } from "../src/benchmark-sites";

const cacheMs = 10 * 60_000;
const timeoutMs = 8_000;
const browserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function probe(site: (typeof BENCHMARK_SITES)[number], fetchImpl: Fetch, now: () => number): Promise<BenchmarkSiteStatus> {
  const checkedAt = new Date(now()).toISOString();
  try {
    const response = await fetchImpl(site.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": browserAgent },
    });
    await response.body?.cancel();
    if (response.status >= 400) {
      const text = response.statusText ? ` ${response.statusText}` : "";
      return { id: site.id, state: "unreachable", httpStatus: response.status, reason: `HTTP ${response.status}${text}`, checkedAt };
    }
    return { id: site.id, state: "ok", httpStatus: response.status, reason: null, checkedAt };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { id: site.id, state: "unreachable", httpStatus: null, reason: timedOut ? "No response within 8 seconds" : "Could not connect", checkedAt };
  }
}

/** Shares one in-flight probe between callers and reuses its result until it is stale. */
export function createBenchmarkStatus(fetchImpl: Fetch = fetch, now: () => number = Date.now) {
  let cached: { at: number; result: Promise<BenchmarkSiteStatus[]> } | null = null;
  return () => {
    if (!cached || now() - cached.at > cacheMs) {
      cached = { at: now(), result: Promise.all(BENCHMARK_SITES.map((site) => probe(site, fetchImpl, now))) };
    }
    return cached.result;
  };
}

export const benchmarkStatus = createBenchmarkStatus();
