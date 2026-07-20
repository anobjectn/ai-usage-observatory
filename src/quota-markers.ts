import type { QuotaHistory } from "./types";

export type QuotaMarker = {
  key: string;
  x: string;
  kind: "quota" | "reset" | "mixed";
  provider: "anthropic" | "codex";
  label: string;
};

type MarkerProvider = "anthropic" | "codex";
type ProviderFilter = MarkerProvider | "warp" | null;
type MarkerEvent = {
  timestamp: number;
  kind: "quota" | "reset";
  provider: MarkerProvider;
};

function events(history?: QuotaHistory): MarkerEvent[] {
  if (!history?.available) return [];
  const quotaEvents = history.windows
    .filter((window) => window.window === "fiveHour")
    .flatMap((window) =>
      window.reachedAt.map((timestamp) => ({
        timestamp,
        kind: "quota" as const,
        provider: window.provider,
      })),
    );
  const resetEvents = history.codexBankedResets.used.map((reset) => ({
    timestamp: reset.usedAt,
    kind: "reset" as const,
    provider: "codex" as const,
  }));
  return [...quotaEvents, ...resetEvents];
}

function localDay(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function groupMarkers(
  history: QuotaHistory | undefined,
  bucketFor: (timestamp: number) => string | null,
  providerFilter: ProviderFilter,
): QuotaMarker[] {
  const buckets = new Map<string, { quota: number; reset: number }>();
  for (const event of events(history)) {
    if (providerFilter !== null && event.provider !== providerFilter) continue;
    const x = bucketFor(event.timestamp);
    if (x === null) continue;
    const key = `${x}:${event.provider}`;
    const bucket = buckets.get(key) ?? { quota: 0, reset: 0 };
    bucket[event.kind]++;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([bucketKey, counts]) => {
    const separator = bucketKey.lastIndexOf(":");
    const x = bucketKey.slice(0, separator);
    const provider = bucketKey.slice(separator + 1) as MarkerProvider;
    const name = provider === "anthropic" ? "Claude" : "Codex";
    const kind = counts.quota && counts.reset ? "mixed" : counts.quota ? "quota" : "reset";
    const labels = [
      counts.quota
        ? `${name} 5h quota reached${counts.quota > 1 ? ` ×${counts.quota}` : ""}`
        : "",
      counts.reset
        ? `${name} reset applied${counts.reset > 1 ? ` ×${counts.reset}` : ""}`
        : "",
    ].filter(Boolean);
    return {
      key: `${x}:${provider}:${kind}`,
      x,
      kind,
      provider,
      label: labels.join(" · "),
    };
  });
}

export function dailyQuotaMarkers(
  history: QuotaHistory | undefined,
  periods: string[],
  providerFilter: ProviderFilter = null,
) {
  const visible = new Set(periods);
  return groupMarkers(history, (timestamp) => {
    const day = localDay(timestamp);
    return visible.has(day) ? day : null;
  }, providerFilter);
}

export function hourlyQuotaMarkers(
  history: QuotaHistory | undefined,
  day: string,
  providerFilter: ProviderFilter = null,
) {
  return groupMarkers(history, (timestamp) => {
    if (localDay(timestamp) !== day) return null;
    return String(new Date(timestamp).getHours());
  }, providerFilter);
}
