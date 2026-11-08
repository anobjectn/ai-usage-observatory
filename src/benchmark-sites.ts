/** The external benchmark pages the comparison viewer frames. Plain data, so the server's
 * reachability probe and `bun run check:embeds` read the same list as the UI. */
export const BENCHMARK_SITES = [
  {
    id: "slopalytics",
    label: "Slopalytics",
    url: "https://slopalytics.com/",
    favicon: "/benchmarks/slopalytics.svg",
    description: "Compare AI models by intelligence, cost, speed, and thinking effort.",
  },
  {
    id: "aicharts",
    label: "AI Charts",
    url: "https://aicharts.io/coding",
    favicon: "/benchmarks/aicharts.ico",
    description: "Compare coding-agent setups by benchmark score, task cost, time, and token use.",
  },
] as const;

export type BenchmarkSiteId = (typeof BENCHMARK_SITES)[number]["id"];

/** One site's last probe. `unreachable` only dims the site's icon: the site still opens, since a
 * probe can fail where a browser would not. */
export type BenchmarkSiteStatus = {
  id: BenchmarkSiteId;
  state: "ok" | "unreachable";
  /** HTTP status of the final response, or null when the request itself failed. */
  httpStatus: number | null;
  /** Human-readable cause when unreachable. */
  reason: string | null;
  checkedAt: string;
};
