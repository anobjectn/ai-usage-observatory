import { describe, expect, test } from "bun:test";
import {
  buildAnthropicCreditView,
  buildCodexCreditView,
  creditFreshness,
  CREDIT_AGING_MS,
  CREDIT_STALE_MS,
} from "./quota-credits";
import type { AnthropicWebCredits, QuotaProvider } from "./types";

const NOW = Date.UTC(2026, 6, 25);

function webCredits(overrides: Partial<AnthropicWebCredits> = {}): AnthropicWebCredits {
  return {
    source: "claude_web_manual",
    capturedAt: NOW,
    updatedAt: NOW,
    currentBalance: 84.97,
    balanceCredits: null,
    currency: "USD",
    autoReloadEnabled: false,
    nextExpiresAt: Date.UTC(2026, 8, 19),
    nextExpiresOn: "2026-09-19",
    promotionalTranches: [
      { remainingAmount: 84.96, grantedAmount: 100, expiresAt: Date.UTC(2026, 8, 19), expiresOn: "2026-09-19" },
    ],
    campaign: { id: "fable_transition", granted: true, amount: 100, expiresAt: Date.UTC(2026, 8, 19), expiresOn: "2026-09-19" },
    purchases: null,
    ...overrides,
  };
}

function anthropicReport(overrides: Partial<QuotaProvider> = {}): QuotaProvider {
  return {
    provider: "anthropic",
    status: "ok",
    source: "anthropic_api",
    snapshot: {
      kind: "window",
      fiveHour: { usedPercent: 12, resetsAt: null },
      weekly: { usedPercent: 40, resetsAt: null },
      usageCredits: { enabled: true, spentAmount: 3.5, limitAmount: 50, currency: "USD", resetsAt: null },
    },
    anthropicWebCredits: webCredits(),
    ...overrides,
  };
}

describe("buildAnthropicCreditView", () => {
  test("groups the campaign and tranche into one Fable presentation object", () => {
    const view = buildAnthropicCreditView(anthropicReport(), NOW);
    expect(view.fable).not.toBeNull();
    expect(view.fable!.remaining).toBe(84.96);
    expect(view.fable!.grant).toBe(100);
    expect(view.fable!.campaignId).toBe("fable_transition");
    expect(view.fable!.expired).toBe(false);
  });

  test("renders the *ExpiresOn calendar string verbatim (no UTC/local drift)", () => {
    const view = buildAnthropicCreditView(anthropicReport(), NOW);
    expect(view.fable!.expiresOn).toBe("2026-09-19");
  });

  test("Fable credit is not emitted as a model quota bucket", () => {
    // The view intentionally has no notion of quota buckets; the Fable credit
    // lives only on view.fable, keeping it out of quotaCards' bucket list.
    const view = buildAnthropicCreditView(anthropicReport(), NOW);
    expect(view).not.toHaveProperty("buckets");
    expect(view.fable!.remaining).toBe(84.96);
  });

  test("vanishes when no fable_transition campaign and no tranche exist", () => {
    const view = buildAnthropicCreditView(
      anthropicReport({ anthropicWebCredits: webCredits({ campaign: null, promotionalTranches: [] }) }),
      NOW,
    );
    expect(view.fable).toBeNull();
  });

  test("still shows Fable when a tranche exists without a campaign", () => {
    const view = buildAnthropicCreditView(
      anthropicReport({ anthropicWebCredits: webCredits({ campaign: null }) }),
      NOW,
    );
    expect(view.fable).not.toBeNull();
    expect(view.fable!.remaining).toBe(84.96);
  });

  test("marks an expired promotion distinctly from stale", () => {
    const freshButExpired = webCredits({
      capturedAt: NOW,
      promotionalTranches: [
        { remainingAmount: 10, grantedAmount: 100, expiresAt: Date.UTC(2026, 0, 1), expiresOn: "2026-01-01" },
      ],
      campaign: null,
    });
    const view = buildAnthropicCreditView(anthropicReport({ anthropicWebCredits: freshButExpired }), NOW);
    expect(view.fable!.expired).toBe(true);
    expect(view.importFreshness).toBe("fresh");
  });

  test("uses currentBalance for prepaid, not the deprecated balanceCredits", () => {
    const view = buildAnthropicCreditView(anthropicReport(), NOW);
    expect(view.prepaid!.balance).toBe(84.97);
  });

  test("derives usage-credit percent from major-unit spend and limit", () => {
    const view = buildAnthropicCreditView(anthropicReport(), NOW);
    expect(view.usageCredit!.spent).toBe(3.5);
    expect(view.usageCredit!.percent).toBeCloseTo(7, 5);
  });

  test("imported freshness is independent of provider quota freshness", () => {
    const staleImport = webCredits({ capturedAt: NOW - CREDIT_STALE_MS - 1 });
    const view = buildAnthropicCreditView(
      anthropicReport({ status: "ok", anthropicWebCredits: staleImport }),
      NOW,
    );
    // Provider is fresh/ok, but the imported observation is stale.
    expect(view.importFreshness).toBe("stale");
  });

  test("tolerates an older quota-service contract with no credit fields", () => {
    const view = buildAnthropicCreditView(
      anthropicReport({ anthropicWebCredits: undefined, snapshot: { kind: "window", fiveHour: null, weekly: null } }),
      NOW,
    );
    expect(view.usageCredit).toBeNull();
    expect(view.prepaid).toBeNull();
    expect(view.fable).toBeNull();
    expect(view.importFreshness).toBeNull();
  });

  test("tolerates a missing provider report entirely", () => {
    const view = buildAnthropicCreditView(undefined, NOW);
    expect(view.usageCredit).toBeNull();
    expect(view.fable).toBeNull();
  });
});

describe("buildCodexCreditView", () => {
  test("preserves provider-defined Codex credit units", () => {
    const view = buildCodexCreditView({
      provider: "codex",
      status: "ok",
      source: "codex_api",
      snapshot: {
        kind: "window",
        fiveHour: null,
        weekly: null,
        codexCredits: { hasCredits: true, unlimited: false, balance: 1000 },
      },
    });
    expect(view).toEqual({ hasCredits: true, unlimited: false, balance: 1000 });
  });

  test("tolerates older quota-service responses", () => {
    expect(buildCodexCreditView(undefined)).toBeNull();
    expect(buildCodexCreditView({
      provider: "codex",
      status: "ok",
      source: "codex_api",
      snapshot: { kind: "window", fiveHour: null, weekly: null },
    })).toBeNull();
  });
});

describe("creditFreshness", () => {
  test("crosses aging then stale at the named thresholds", () => {
    expect(creditFreshness(NOW, NOW)).toBe("fresh");
    expect(creditFreshness(NOW - CREDIT_AGING_MS, NOW)).toBe("aging");
    expect(creditFreshness(NOW - CREDIT_STALE_MS, NOW)).toBe("stale");
    expect(creditFreshness(null, NOW)).toBeNull();
  });
});
