import { afterEach, describe, expect, test } from "bun:test";
import { collectQuota, collectRawQuotaHistory, importAnthropicWebCredits, summarizeQuotaHistory } from "./quota";

const realFetch = globalThis.fetch;
const realEnabled = process.env.QUOTA_SERVICE_ENABLED;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnabled === undefined) delete process.env.QUOTA_SERVICE_ENABLED;
  else process.env.QUOTA_SERVICE_ENABLED = realEnabled;
});

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("collectQuota field preservation", () => {
  test("passes usageCredits, codexCredits, anthropicWebCredits, timestamps, and rawLimits through untouched", async () => {
    const usage = {
      generatedAt: 1000,
      providers: [
        {
          provider: "anthropic",
          status: "ok",
          source: "anthropic_api",
          dataAgeMs: 42,
          capturedAt: 999,
          snapshot: {
            kind: "window",
            fiveHour: { usedPercent: 10, resetsAt: null },
            weekly: null,
            usageCredits: { enabled: true, spentAmount: 3.5, limitAmount: 50, currency: "USD", resetsAt: null },
            codexCredits: { hasCredits: true, unlimited: false, balance: 1000 },
            extra: { rawLimits: [{ kind: "weekly", percent: 10 }] },
          },
          manualEntries: [],
          anthropicWebCredits: { source: "claude_web_manual", capturedAt: 5, updatedAt: 6, currentBalance: 84.97, currency: "USD", nextExpiresOn: "2026-09-19", promotionalTranches: [] },
        },
      ],
    };
    stubFetch((url) => {
      if (url.endsWith("/usage")) return { body: usage };
      if (url.endsWith("/resets")) return { body: {} };
      return { body: {} };
    });
    const result = await collectQuota();
    const provider = (result.usage as typeof usage).providers[0];
    expect(provider.dataAgeMs).toBe(42);
    expect(provider.capturedAt).toBe(999);
    expect(provider.snapshot.usageCredits).toEqual(usage.providers[0].snapshot.usageCredits);
    expect(provider.snapshot.codexCredits).toEqual(usage.providers[0].snapshot.codexCredits);
    expect(provider.snapshot.extra.rawLimits).toEqual([{ kind: "weekly", percent: 10 }]);
    expect(provider.anthropicWebCredits.nextExpiresOn).toBe("2026-09-19");
  });

  test("keeps successful endpoints and the last valid provider when usage later fails", async () => {
    stubFetch((url) => {
      if (url.endsWith("/usage")) return { status: 503, body: {} };
      if (url.endsWith("/resets")) return { body: { codexBankedResetCredits: { credits: [] } } };
      return { body: { ok: true } };
    });
    const result = await collectQuota();
    expect(result.available).toBe(true);
    expect(result.sourceState).toBe("degraded");
    expect(result.resets).toBeDefined();
    expect((result.usage as { providers: unknown[] }).providers).toHaveLength(1);
    expect(result.error).toContain("/usage returned 503");
  });

  test("stays quiet when optional quota collection is explicitly disabled", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    process.env.QUOTA_SERVICE_ENABLED = "0";
    const result = await collectQuota();
    expect(result.sourceState).toBe("disabled");
    expect(calls).toBe(0);
  });
});

test("raw history adapter prefers the paginated normalized API", async () => {
  stubFetch((url) => {
    expect(url).toContain("/history?");
    return { body: {
      provider: "anthropic",
      earliestObservationAt: 100,
      historyVersion: 7,
      retentionDays: null,
      retentionMode: "forever",
      nextCursor: null,
      observations: [{
        schemaVersion: 1, provider: "anthropic", capturedAt: 200, observedAt: 150,
        timeSource: "provider", status: "ok", source: "anthropic_api",
        plan: { id: null, label: null, source: "unknown", effectiveFrom: null },
        quota: { kind: "windows", windows: [{ id: "fiveHour", usedPercent: 20, resetsAt: 500, cycleId: "reset:480" }] },
      }],
    } };
  });
  const result = await collectRawQuotaHistory("anthropic", 0, 1_000);
  expect(result).toMatchObject({
    available: true, sourceState: "connected", historyVersion: 7, earliestObservationAt: 100,
  });
  expect(result.observations[0]?.observedAt).toBe(150);
});

describe("importAnthropicWebCredits proxy", () => {
  test("forwards a valid import and returns the producer's 2xx body", async () => {
    stubFetch((url, init) => {
      expect(url.endsWith("/anthropic-web-import")).toBe(true);
      expect(init?.method).toBe("POST");
      return { status: 200, body: { ok: true, snapshot: { schemaVersion: 1 } } };
    });
    const result = await importAnthropicWebCredits({ currentBalance: 84.97 });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ ok: true, snapshot: { schemaVersion: 1 } });
  });

  test("reports a producer non-2xx verbatim without throwing", async () => {
    stubFetch(() => ({ status: 400, body: { ok: false, error: "promoRemaining must be a non-negative number" } }));
    const result = await importAnthropicWebCredits({ promoRemaining: -1 });
    expect(result.status).toBe(400);
    expect(result.data).toEqual({ ok: false, error: "promoRemaining must be a non-negative number" });
  });
});

describe("quota history summary", () => {
  test("counts a reached window once per reset cycle despite timestamp jitter", () => {
    const snapshots = [
      { provider: "anthropic", capturedAt: 1, snapshotJson: JSON.stringify({kind:"window",fiveHour:{usedPercent:100,resetsAt:3_600_001},weekly:{usedPercent:20,resetsAt:604_800_000}}) },
      { provider: "anthropic", capturedAt: 2, snapshotJson: JSON.stringify({kind:"window",fiveHour:{usedPercent:100,resetsAt:3_599_700},weekly:{usedPercent:20,resetsAt:604_800_000}}) },
      { provider: "anthropic", capturedAt: 3, snapshotJson: JSON.stringify({kind:"window",fiveHour:{usedPercent:100,resetsAt:21_600_000},weekly:{usedPercent:100,resetsAt:604_800_000}}) },
    ];
    const summary = summarizeQuotaHistory(snapshots, []);
    const fiveHour = summary.windows.find((item) => item.provider === "anthropic" && item.window === "fiveHour");
    const weekly = summary.windows.find((item) => item.provider === "anthropic" && item.window === "weekly");
    expect(fiveHour?.reachedCount).toBe(2);
    expect(fiveHour?.lastReachedAt).toBe(3);
    expect(fiveHour?.reachedAt).toEqual([3, 1]);
    expect(weekly?.reachedCount).toBe(1);
    expect(weekly?.lastReachedAt).toBe(3);
    expect(weekly?.reachedAt).toEqual([3]);
  });

  test("counts an available reset credit that disappears before expiry as used", () => {
    const expiry = new Date(10_000).toISOString();
    const resets = [
      { capturedAt: 1_000, creditsJson: JSON.stringify([{id:"credit-1",title:"Extra reset",status:"available",expiresAt:expiry}]) },
      { capturedAt: 2_000, creditsJson: "[]" },
    ];
    expect(summarizeQuotaHistory([], resets).codexBankedResets).toEqual({
      usedCount: 1,
      used: [{ id: "credit-1", title: "Extra reset", usedAt: 2_000 }],
    });
  });

  test("records reset credits explicitly reported as used", () => {
    const resets = [
      { capturedAt: 3_000, creditsJson: JSON.stringify([{id:"credit-2",title:"Weekly reset",status:"used"}]) },
    ];
    expect(summarizeQuotaHistory([], resets).codexBankedResets.used).toEqual([
      { id: "credit-2", title: "Weekly reset", usedAt: 3_000 },
    ]);
  });
});
