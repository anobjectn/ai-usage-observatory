import { useEffect, useState } from "react";
import type { BenchmarkSiteId, BenchmarkSiteStatus } from "../benchmark-sites";

type StatusMap = Partial<Record<BenchmarkSiteId, BenchmarkSiteStatus>>;

/** One request per page load, shared by every launcher. The server caches its own probe. A failed
 * status request leaves every icon as it is: unknown is never shown as unreachable. */
let pending: Promise<StatusMap> | null = null;

function loadStatus() {
  pending ??= fetch("/api/benchmarks/status")
    .then((response) => (response.ok ? (response.json() as Promise<BenchmarkSiteStatus[]>) : []))
    .then((rows) => Object.fromEntries(rows.map((row) => [row.id, row])) as StatusMap)
    .catch(() => ({}));
  return pending;
}

export function useBenchmarkStatus() {
  const [status, setStatus] = useState<StatusMap>({});
  useEffect(() => {
    let live = true;
    void loadStatus().then((value) => {
      if (live) setStatus(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/** Tooltip text for a site, saying why its icon is dimmed and that it still opens. */
export function benchmarkSiteTitle(label: string, status: BenchmarkSiteStatus | undefined) {
  if (status?.state !== "unreachable") return label;
  return `${label}: not loading right now (${status.reason ?? "unreachable"}). You can still open it.`;
}
