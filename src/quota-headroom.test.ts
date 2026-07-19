import { describe, expect, test } from "bun:test";
import type { DashboardData, QuotaProvider } from "./types";
import { providerHeadroom } from "./quota-headroom";

function quotas(providers: QuotaProvider[]): DashboardData["quotas"] {
  return { available: true, usage: { generatedAt: 0, providers }, collectedAt: "2026-07-19T00:00:00Z" };
}

function provider(provider: "anthropic" | "codex", status: QuotaProvider["status"], fiveHour: number | null, weekly: number | null, model?: number): QuotaProvider {
  return {
    provider,
    status,
    source: "test",
    snapshot: {
      kind: "window",
      fiveHour: fiveHour === null ? null : { usedPercent: fiveHour, resetsAt: null },
      weekly: weekly === null ? null : { usedPercent: weekly, resetsAt: null },
      modelWindows: model === undefined ? undefined : { model: { usedPercent: model, resetsAt: null } },
    },
  };
}

function warpProvider(status: QuotaProvider["status"], usedPercent: number): QuotaProvider {
  return {
    provider: "warp",
    status,
    source: "test",
    snapshot: { kind: "pool", pool: { used: usedPercent, limit: 100, usedPercent, refreshesAt: null } },
  };
}

describe("providerHeadroom", () => {
  test("uses the most constrained provider window", () => {
    const result = providerHeadroom(quotas([provider("anthropic", "ok", 25, 60, 80)]));
    expect(result[0]).toEqual({ provider: "anthropic", percent: 20, state: "current" });
  });

  test("clamps exhausted and over-quota providers to zero", () => {
    const result = providerHeadroom(quotas([provider("codex", "ok", 101, 45)]));
    expect(result[1].percent).toBe(0);
  });

  test("preserves stale headroom while marking its state", () => {
    const result = providerHeadroom(quotas([provider("codex", "stale", 40, 55)]));
    expect(result[1]).toEqual({ provider: "openai", percent: 45, state: "stale" });
  });

  test("derives Warp headroom from its request pool", () => {
    const result = providerHeadroom(quotas([warpProvider("ok", 72)]));
    expect(result[2]).toEqual({ provider: "warp", percent: 28, state: "current" });
  });

  test("does not interpret unavailable data as exhaustion", () => {
    const unavailable = provider("anthropic", "unavailable", 100, 100);
    const result = providerHeadroom(quotas([unavailable]));
    expect(result).toEqual([
      { provider: "anthropic", percent: null, state: "unknown" },
      { provider: "openai", percent: null, state: "unknown" },
      { provider: "warp", percent: null, state: "unknown" },
    ]);
  });
});
