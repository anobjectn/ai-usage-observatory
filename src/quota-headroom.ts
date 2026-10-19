import { dateKeyInTimeZone, systemTimeZone } from "./reporting-time";
import type { DashboardData, QuotaHistory, QuotaProvider, WindowQuotaSnapshot } from "./types";

export type ProviderHeadroom = {
  provider: "anthropic" | "openai" | "warp";
  percent: number | null;
  state: "current" | "stale" | "unknown";
};

function constrainedHeadroom(provider: QuotaProvider | undefined) {
  if (!provider?.snapshot || !["ok", "stale"].includes(provider.status)) return null;
  if (provider.snapshot.kind === "pool") {
    return Math.max(0, Math.min(100, 100 - provider.snapshot.pool.usedPercent));
  }
  const snapshot = provider.snapshot as WindowQuotaSnapshot;
  const windows = [snapshot.fiveHour, snapshot.weekly, ...Object.values(snapshot.modelWindows ?? {})]
    .filter((window): window is NonNullable<typeof window> => window !== null);
  if (!windows.length) return null;
  const highestUsage = Math.max(...windows.map((window) => window.usedPercent));
  return Math.max(0, Math.min(100, 100 - highestUsage));
}

export type DailyHeadroom = { anthropic: number | null; codex: number | null };

/** Window headroom (100 − used%) per calendar day in the reporting timezone.
 * Weekly headroom is the day's last observation. Five-hour headroom is the
 * day's lowest observation: the window cycles several times inside one daily
 * bucket, so its last reading would alias badly, but its low point shows how
 * close the day came to the short limit. Days without an observation stay
 * absent — the chart bridges gaps visually rather than inventing readings. */
export function dailyHeadroomSeries(
  history: QuotaHistory | undefined,
  periods: string[],
  timeZone = systemTimeZone(),
  window: "weekly" | "fiveHour" = "weekly",
): Map<string, DailyHeadroom> {
  const result = new Map<string, DailyHeadroom>();
  if (!history?.series?.length || periods.length === 0) return result;
  const wanted = new Set(periods);
  const chosen = new Map<string, { capturedAt: number; usedPercent: number }>();
  for (const point of history.series) {
    if (point.window !== window) continue;
    const day = dateKeyInTimeZone(new Date(point.capturedAt).toISOString(), timeZone);
    if (!day || !wanted.has(day)) continue;
    const key = `${point.provider}\0${day}`;
    const current = chosen.get(key);
    const replaces = !current
      || (window === "weekly"
        ? point.capturedAt > current.capturedAt
        : point.usedPercent > current.usedPercent);
    if (replaces) {
      chosen.set(key, { capturedAt: point.capturedAt, usedPercent: point.usedPercent });
    }
  }
  for (const [key, point] of chosen) {
    const [provider, day] = key.split("\0") as ["anthropic" | "codex", string];
    const entry = result.get(day) ?? { anthropic: null, codex: null };
    entry[provider] = Math.max(0, Math.min(100, 100 - point.usedPercent));
    result.set(day, entry);
  }
  return result;
}

export function providerHeadroom(quotas: DashboardData["quotas"]): ProviderHeadroom[] {
  const providers = new Map(quotas.usage?.providers.map((provider) => [provider.provider, provider]) ?? []);
  return ([
    ["anthropic", "anthropic"],
    ["openai", "codex"],
    ["warp", "warp"],
  ] as const).map(([provider, quotaKey]) => {
    const quota = providers.get(quotaKey);
    const percent = constrainedHeadroom(quota);
    return {
      provider,
      percent,
      state: percent === null ? "unknown" : quota?.status === "stale" ? "stale" : "current",
    };
  });
}
