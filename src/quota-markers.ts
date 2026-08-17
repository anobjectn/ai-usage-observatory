import type { QuotaHistory } from "./types";
import { dateKeyInTimeZone, hourInTimeZone, systemTimeZone } from "./reporting-time";

export type QuotaMarker = {
  key: string;
  x: string;
  kind: MarkerKind | "mixed";
  provider: "anthropic" | "codex";
  label: string;
  /** One row per event kind in this bucket, so a tooltip can restate what the
   * in-chart marker label says and add the instants behind it. */
  entries: QuotaMarkerEntry[];
};

export type QuotaMarkerEntry = {
  kind: MarkerKind;
  /** Suffix shared with the marker label, e.g. "weekly quota reached". */
  label: string;
  count: number;
  /** Ascending; one instant per reach or applied reset. */
  timestamps: number[];
};

type MarkerKind = "quota" | "weekly" | "reset";
type MarkerProvider = "anthropic" | "codex";
type ProviderFilter = MarkerProvider | "warp" | null;
type MarkerEvent = {
  timestamp: number;
  kind: MarkerKind;
  provider: MarkerProvider;
};

const kindLabels: Record<MarkerKind, string> = {
  quota: "5h quota reached",
  weekly: "weekly quota reached",
  reset: "reset applied",
};

function events(history?: QuotaHistory): MarkerEvent[] {
  if (!history?.available) return [];
  const quotaEvents = history.windows.flatMap((window) =>
    window.reachedAt.map((timestamp) => ({
      timestamp,
      kind: window.window === "weekly" ? ("weekly" as const) : ("quota" as const),
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

function groupMarkers(
  history: QuotaHistory | undefined,
  bucketFor: (timestamp: number) => string | null,
  providerFilter: ProviderFilter,
): QuotaMarker[] {
  const buckets = new Map<string, Map<MarkerKind, number[]>>();
  for (const event of events(history)) {
    if (providerFilter !== null && event.provider !== providerFilter) continue;
    const x = bucketFor(event.timestamp);
    if (x === null) continue;
    const key = `${x}:${event.provider}`;
    const bucket = buckets.get(key) ?? new Map<MarkerKind, number[]>();
    bucket.set(event.kind, [...(bucket.get(event.kind) ?? []), event.timestamp]);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([bucketKey, kinds]) => {
    const separator = bucketKey.lastIndexOf(":");
    const x = bucketKey.slice(0, separator);
    const provider = bucketKey.slice(separator + 1) as MarkerProvider;
    const name = provider === "anthropic" ? "Claude" : "Codex";
    const entries = (["quota", "weekly", "reset"] as const)
      .filter((candidate) => kinds.get(candidate)?.length)
      .map((candidate) => {
        const timestamps = [...kinds.get(candidate)!].sort((left, right) => left - right);
        return { kind: candidate, label: kindLabels[candidate], count: timestamps.length, timestamps };
      });
    const kind = entries.length > 1 ? "mixed" : entries[0]?.kind ?? "quota";
    return {
      key: `${x}:${provider}:${kind}`,
      x,
      kind,
      provider,
      label: entries
        .map((entry) => `${name} ${entry.label}${entry.count > 1 ? ` ×${entry.count}` : ""}`)
        .join(" · "),
      entries,
    };
  });
}

/** Markers sharing one chart x value, so a tooltip opened over that point can
 * restate the marker labels its card covers. Claude first, then Codex. */
export function quotaMarkersAt(markers: QuotaMarker[], x: string | number | undefined) {
  if (x === undefined) return [];
  return markers
    .filter((marker) => marker.x === String(x))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

export function dailyQuotaMarkers(
  history: QuotaHistory | undefined,
  periods: string[],
  providerFilter: ProviderFilter = null,
  timeZone = systemTimeZone(),
) {
  const visible = new Set(periods);
  return groupMarkers(history, (timestamp) => {
    const day = dateKeyInTimeZone(new Date(timestamp), timeZone);
    return day !== null && visible.has(day) ? day : null;
  }, providerFilter);
}

export function hourlyQuotaMarkers(
  history: QuotaHistory | undefined,
  day: string,
  providerFilter: ProviderFilter = null,
  timeZone = systemTimeZone(),
) {
  return groupMarkers(history, (timestamp) => {
    const instant = new Date(timestamp);
    if (dateKeyInTimeZone(instant, timeZone) !== day) return null;
    const hour = hourInTimeZone(instant, timeZone);
    return hour === null ? null : String(hour);
  }, providerFilter);
}
