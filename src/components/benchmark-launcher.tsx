import { BENCHMARK_SITES, type BenchmarkSiteId } from "../benchmark-sites";
import { benchmarkSiteTitle, useBenchmarkStatus } from "../hooks/use-benchmark-status";

export { BENCHMARK_SITES, type BenchmarkSiteId } from "../benchmark-sites";

/** `is-unreachable` dims a site whose page answered with an error or not at all. It stays
 * clickable: the probe runs from the server, and the browser may still load what it could not. */
export function benchmarkFaviconClass(id: BenchmarkSiteId, unreachable: boolean) {
  return `benchmark-favicon benchmark-favicon--${id}${unreachable ? " is-unreachable" : ""}`;
}

export function BenchmarkTriggerIcons({ className }: { className?: string }) {
  const status = useBenchmarkStatus();
  return (
    <span className={className ? `benchmark-trigger-icons ${className}` : "benchmark-trigger-icons"}>
      {BENCHMARK_SITES.map((entry) => {
        const unreachable = status[entry.id]?.state === "unreachable";
        return (
          <img
            key={entry.id}
            className={benchmarkFaviconClass(entry.id, unreachable)}
            src={entry.favicon}
            alt=""
            title={unreachable ? benchmarkSiteTitle(entry.label, status[entry.id]) : undefined}
            loading="lazy"
          />
        );
      })}
    </span>
  );
}

export function BenchmarkSplitLauncher({ onOpen }: { onOpen: (siteId: BenchmarkSiteId) => void }) {
  const status = useBenchmarkStatus();
  return (
    <div className="benchmark-split-pill" aria-label="Open benchmark comparison">
      {BENCHMARK_SITES.map((entry) => {
        const unreachable = status[entry.id]?.state === "unreachable";
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onOpen(entry.id)}
            aria-label={`Open ${entry.label} benchmark${unreachable ? " (may not load right now)" : ""}`}
            title={benchmarkSiteTitle(entry.label, status[entry.id])}
          >
            <img className={benchmarkFaviconClass(entry.id, unreachable)} src={entry.favicon} alt="" loading="lazy" />
          </button>
        );
      })}
    </div>
  );
}
