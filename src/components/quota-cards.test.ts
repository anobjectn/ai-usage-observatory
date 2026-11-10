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
