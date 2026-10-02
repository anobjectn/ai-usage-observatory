


export const BENCHMARK_SITES = [
  {
    id: "deepswe",
    label: "DeepSWE",
    url: "https://deepswe.datacurve.ai/#leaderboard",
    favicon: "https://deepswe.datacurve.ai/favicon.ico",
    description: "Cost-vs-performance leaderboard across coding agents — the primary reference for this comparison.",
  },
  {
    id: "artificialanalysis",
    label: "Artificial Analysis",
    url: "https://artificialanalysis.ai/",
    favicon: "https://artificialanalysis.ai/favicon.ico",
    description: "Broader model metrics: quality, speed, latency, and price across providers.",
  },
] as const;

export type BenchmarkSiteId = (typeof BENCHMARK_SITES)[number]["id"];

export function BenchmarkTriggerIcons({ className }: { className?: string }) {
  return (
    <span className={className ? `benchmark-trigger-icons ${className}` : "benchmark-trigger-icons"}>
      {BENCHMARK_SITES.map((entry) => (
        <img
          key={entry.id}
          className={`benchmark-favicon benchmark-favicon--${entry.id}`}
          src={entry.favicon}
          alt=""
          loading="lazy"
        />
      ))}
    </span>
  );
}

export function BenchmarkSplitLauncher({ onOpen }: { onOpen: (siteId: BenchmarkSiteId) => void }) {
  return (
    <div className="benchmark-split-pill" aria-label="Open benchmark comparison">
      {BENCHMARK_SITES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onOpen(entry.id)}
          aria-label={`Open ${entry.label} benchmark`}
          title={entry.label}
        >
          <img className={`benchmark-favicon benchmark-favicon--${entry.id}`} src={entry.favicon} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
}
