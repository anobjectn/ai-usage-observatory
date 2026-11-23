import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardData, QuotaProvider } from "../types";
import { QuotaDials } from "./quota-cards";

function renderGlance(
  status: QuotaProvider["status"],
  resetAt: number,
  dataAgeMs?: number,
  resets?: DashboardData["quotas"]["resets"],
) {
  const quotas: DashboardData["quotas"] = {
    available: true,
    collectedAt: new Date().toISOString(),
    usage: {
      generatedAt: Date.now(),
      providers: [{
        provider: "anthropic",
        status,
        source: "fixture",
        dataAgeMs,
        snapshot: {
          kind: "window",
          fiveHour: { usedPercent: 3, resetsAt: resetAt },
          weekly: { usedPercent: 25, resetsAt: Date.now() + 86_400_000 },
        },
      }],
    },
    resets,
  };
  const html = renderToStaticMarkup(createElement(QuotaDials, { quotas, timeZone: "UTC" }));
  // Inspect only the strip: labels in the collapsed cards cannot warn a narrow-screen reader.
  return html.slice(html.indexOf('<dl class="quota-glance">'), html.indexOf("</dl>"));
}

test("the quota strip names a stale reading and its age before provider details are opened", () => {
  const html = renderGlance("stale", Date.now() + 3_600_000, 18 * 60_000);
  expect(html).toContain("stale · 18m");
  expect(html).toContain("97%");
});

test("the quota strip still warns about staleness when the provider omits the age", () => {
  expect(renderGlance("stale", Date.now() + 3_600_000)).toContain(
    '<small class="quota-glance__state">stale</small>',
  );
});

test("an expired quota window cannot present its old percentage as current headroom", () => {
  const html = renderGlance("ok", Date.now() - 60_000);
  expect(html).toContain("<small>expired</small>");
  expect(html).not.toContain("97%");
  expect(html).toContain("75%");
});

test("a current quota reading keeps its headroom and reset countdown", () => {
  const html = renderGlance("ok", Date.now() + 3_600_000);
  expect(html).toContain("97%");
  expect(html).toContain("resets in");
  expect(html).not.toContain("quota-glance__state");
  expect(html).not.toContain("expired");
});

test("the quota strip shortens window names and countdowns", () => {
  const html = renderGlance("ok", Date.now() + 2 * 3_600_000 + 60_000);
  expect(html).toContain("<b>5h</b>");
  expect(html).toContain(">97%</span>");
  expect(html).toContain("<b>w</b>");
  expect(html).toContain("</svg>2h</small>");
  expect(html).toContain("</svg>1d</small>");
});

test("the quota strip lists upcoming banked reset expirations on their own line", () => {
  const credit = (id: string, hours: number) => ({
    id,
    title: `Reset ${id}`,
    status: "available",
    expiresAt: new Date(Date.now() + hours * 3_600_000 + 60_000).toISOString(),
  });
  const html = renderGlance("ok", Date.now() + 3_600_000, undefined, {
    codexBankedResetCredits: { credits: [credit("b", 53), credit("a", 5)] },
  } as unknown as DashboardData["quotas"]["resets"]);
  expect(html).toContain("quota-glance__resets");
  expect(html).toContain("<b>2</b><small>banked</small>");
  expect(html.indexOf("</svg>5h</small>")).toBeLessThan(html.indexOf("</svg>2d5h</small>"));
  expect(html).toContain("quota-glance__expiry is-lapsing");
  expect(html).not.toContain("quota-glance__expiry is-soon");
  expect(html).toContain("has-lapsing");
});

function antigravityQuotas(provider: Partial<QuotaProvider> | null, history?: DashboardData["quotas"]["history"]): DashboardData["quotas"] {
  const reset = Date.now() + 3_600_000;
  return {
    available: true,
    collectedAt: new Date().toISOString(),
    usage: {
      generatedAt: Date.now(),
      providers: provider === null ? [] : [{
        provider: "antigravity",
        status: "ok",
        source: "antigravity_local",
        snapshot: {
          kind: "window",
          fiveHour: { usedPercent: 28.5, resetsAt: reset },
          weekly: { usedPercent: 39.6, resetsAt: reset + 86_400_000 },
          modelWindows: {
            "Claude and GPT models (5h)": { usedPercent: 0, resetsAt: reset },
            "Claude and GPT models (weekly)": { usedPercent: 0, resetsAt: reset + 86_400_000 },
            "Gemini 4 Argon Weekly Limit": { usedPercent: 12, resetsAt: reset + 86_400_000 },
          },
          extra: {
            planType: "pro",
            rawPlanName: "Google AI Pro",
            modelWindowIdentity: {
              "Claude and GPT models (5h)": { model: null, family: null },
              "Claude and GPT models (weekly)": { model: null, family: null },
              "Gemini 4 Argon Weekly Limit": { model: "gemini-4-argon", family: "gemini" },
            },
          },
        },
        ...provider,
      }],
    },
    history,
  };
}

test("no Antigravity card appears until quota-service reports the provider", async () => {
  const { quotaCards } = await import("../app/analytics");
  expect(quotaCards(antigravityQuotas(null)).map((card) => card.provider)).toEqual(["anthropic", "codex", "warp"]);
  const history = { available: true, trackingSince: 1, windows: [{ provider: "antigravity" as const, window: "fiveHour" as const, reachedCount: 1, lastReachedAt: 5, reachedAt: [5] }], codexBankedResets: { usedCount: 0, used: [] } };
  expect(quotaCards(antigravityQuotas(null, history)).map((card) => card.provider)).toContain("antigravity");
});

test("the Antigravity card lists its primary windows, then each model window by name and scope", async () => {
  const { quotaCards } = await import("../app/analytics");
  const card = quotaCards(antigravityQuotas({})).find((entry) => entry.provider === "antigravity")!;
  expect(card).toMatchObject({ providerLabel: "Antigravity", planLabel: "Google AI Pro", state: "ok" });
  expect(card.buckets.map((bucket) => [bucket.windowLabel, bucket.scope, bucket.compactLabel ?? null])).toEqual([
    ["5-hour", "Limits: all Gemini models", null],
    ["Weekly", "Limits: all Gemini models", null],
    ["Claude and GPT models (5h)", "Limits: partner models", "Partner 5h"],
    ["Claude and GPT models (weekly)", "Limits: partner models", "Partner w"],
    ["Gemini 4 Argon Weekly Limit", "Limits: Gemini 4 Argon", "Argon w"],
  ]);
  expect(card.buckets.filter((bucket) => bucket.historyWindow).map((bucket) => bucket.historyWindow)).toEqual(["fiveHour", "weekly"]);
});

test("the plan falls back to the plan id, and a last-good reading says it is stale", async () => {
  const { quotaCards } = await import("../app/analytics");
  const quotas = antigravityQuotas({ status: "stale", servingLastGood: true, dataAgeMs: 18 * 60_000, error: "local probe budget exhausted" });
  const snapshot = quotas.usage!.providers[0]!.snapshot as import("../types").WindowQuotaSnapshot;
  delete snapshot.extra!.rawPlanName;
  const card = quotaCards(quotas).find((entry) => entry.provider === "antigravity")!;
  expect(card.planLabel).toBe("Pro");
  expect(card.stateLabel).toBe("stale · 18m");
  expect(card.notice).toMatchObject({ kind: "wait" });
});

test("the glance strip shows Antigravity's windows with readable short names", () => {
  const html = renderToStaticMarkup(createElement(QuotaDials, { quotas: antigravityQuotas({}), timeZone: "UTC" }));
  const glance = html.slice(html.indexOf('<dl class="quota-glance">'), html.indexOf("</dl>"));
  expect(glance).toContain('class="quota-glance__provider antigravity"');
  expect(glance).toContain("<b>Partner 5h</b>");
  expect(glance).toContain("<b>Argon w</b>");
  expect(glance).toContain("72%");
  expect(html).toContain("Google AI Pro");
  expect(html).toContain("Limits: Gemini 4 Argon");
});

test("capacity and headroom read Antigravity's primary windows only", async () => {
  const { providerCapacityRows } = await import("../app/analytics");
  const { providerHeadroom } = await import("../quota-headroom");
  const quotas = antigravityQuotas({});
  const row = providerCapacityRows([], quotas).find((entry) => entry.provider === "antigravity")!;
  expect(row.windows.map((window) => window.label)).toEqual(["5-hour", "Weekly"]);
  expect(row.highestUsedPercent).toBe(39.6);
  expect(providerHeadroom(quotas).find((entry) => entry.provider === "antigravity")?.percent).toBeCloseTo(60.4, 5);
  expect(providerHeadroom(antigravityQuotas(null)).map((entry) => entry.provider)).toEqual(["anthropic", "openai", "warp"]);
});
