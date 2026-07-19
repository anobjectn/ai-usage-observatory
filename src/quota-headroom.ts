import type { DashboardData, QuotaProvider, WindowQuotaSnapshot } from "./types";

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
