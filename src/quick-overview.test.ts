import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QuickOverviewModal,
  condensedResetCopy,
  quickOverviewCards,
  savedQuickOverviewMode,
} from "./App";
import type { SceneEffects, ProviderColors } from "./scene";
import type { DashboardData } from "./types";

const sceneEffects: SceneEffects = {
  starfield: false,
  parallax: false,
  twinkle: false,
  tesseract: false,
  speed: 3,
  starDensity: 4,
};

const providerColors: ProviderColors = {
  anthropic: "#d97757",
  openai: "#7d8fff",
  warp: "#58d9cf",
};

function quotasFixture(): DashboardData["quotas"] {
  const later = Date.now() + 3_600_000;
  return {
    available: true,
    collectedAt: new Date().toISOString(),
    usage: {
      generatedAt: Date.now(),
      providers: [
        {
          provider: "anthropic",
          status: "ok",
          source: "quota-service",
          snapshot: {
            kind: "window",
            fiveHour: { usedPercent: 42, resetsAt: later },
            weekly: { usedPercent: 61, resetsAt: later },
          },
        },
        {
          provider: "codex",
          status: "unavailable",
          source: null,
          snapshot: null,
          error: "not configured",
        },
      ],
    },
  } as DashboardData["quotas"];
}

function renderModal(
  mode: "gauges" | "grid",
  effects: SceneEffects = sceneEffects,
) {
  return renderToStaticMarkup(
    createElement(QuickOverviewModal, {
      quotas: quotasFixture(),
      mode,
      onModeChange: () => {},
      accent: "#78a8ff",
      providerColors,
      sceneEffects: effects,
      onClose: () => {},
    }),
  );
}

test("savedQuickOverviewMode defaults to gauges without a stored choice", () => {
  expect(savedQuickOverviewMode()).toBe("gauges");
});

test("quickOverviewCards keeps only providers with reported windows", () => {
  const cards = quickOverviewCards(quotasFixture());
  expect(cards.map((card) => card.provider)).toEqual(["anthropic"]);
});

test("quota card details match the remaining percentage shown by the dial", () => {
  const buckets = quickOverviewCards(quotasFixture())[0]!.buckets;
  expect(buckets.map((bucket) => bucket.detail)).toEqual(["58% left", "39% left"]);
});

test("a stale provider without a snapshot is still shown", () => {
  const quotas = {
    available: true,
    collectedAt: new Date().toISOString(),
    usage: {
      generatedAt: Date.now(),
      providers: [
        {
          provider: "anthropic",
          status: "stale",
          source: "quota-service",
          snapshot: null,
          error: "401 from oauth/usage — access token stale",
        },
      ],
    },
  } as DashboardData["quotas"];
  const cards = quickOverviewCards(quotas);
  expect(cards.map((card) => card.provider)).toEqual(["anthropic"]);
  expect(cards[0].state).toBe("stale");
  expect(cards[0].buckets.every((b) => b.usedPercent === null)).toBe(true);
});

test("condensedResetCopy formats a live countdown with a short stamp", () => {
  const resetAt = new Date(2026, 7, 28, 19, 40, 0).getTime();
  const now = resetAt - (3 * 3600 + 12 * 60 + 10) * 1000;
  expect(condensedResetCopy(resetAt, "resets", now, true)).toBe(
    "resets in 3h 12m 10s · 8/28 7:40p",
  );
  expect(condensedResetCopy(resetAt, "resets", now, false)).toBe(
    "resets in 3h 12m · 8/28 7:40p",
  );
});

test("condensedResetCopy covers days, morning stamps, and elapsed resets", () => {
  const resetAt = new Date(2026, 8, 2, 4, 0, 0).getTime();
  const now = resetAt - ((4 * 86400 + 11 * 3600 + 22 * 60) * 1000 + 5000);
  expect(condensedResetCopy(resetAt, "renews", now, true)).toBe(
    "renews in 4d 11h 22m 5s · 9/2 4:00a",
  );
  expect(condensedResetCopy(resetAt, "resets", resetAt + 1000, true)).toBe(
    "resets now",
  );
});

test("gauges mode renders headroom dials with stacked reset countdowns per window", () => {
  const html = renderModal("gauges");
  expect(html).toContain("quota-dial");
  // Buckets report 42% and 61% used; dials read out what is left.
  expect(html).toContain("58%");
  expect(html).toContain("39%");
  expect(html).toContain("% left");
  expect(html).not.toContain("42%");
  expect(html).toContain("quick-overview__reset--stacked");
  expect(html).toContain("reset in");
  expect(html).not.toContain("·");
  expect(html).not.toContain("quick-overview__row");
  // The orrery legend names every provider; only the card for the reported one exists.
  expect(html).not.toContain("quick-overview__provider codex");
});

test("grid mode groups rows under one provider header with reset info", () => {
  const html = renderModal("grid");
  expect(html).toContain("quick-overview__group");
  expect(html).toContain("quick-overview__row");
  expect(html).toContain("58% left");
  expect(html).toContain("resets in");
  expect(html).not.toContain("quota-dial");
  expect(html.match(/quick-overview__group /g)?.length).toBe(1);
});

test("the modal has no heading text and keeps the layout toggle", () => {
  const html = renderModal("gauges");
  expect(html).not.toContain("QUICK OVERVIEW");
  expect(html).not.toContain("Subscription windows at a glance");
  expect(html).toContain("quick-overview__mode");
});

test("the orrery always shows; tesseract only swaps its core icon", () => {
  const withoutTesseract = renderModal("gauges");
  expect(withoutTesseract).toContain("headroom-orrery");
  expect(withoutTesseract).toContain("headroom-orrery--static");
  expect(withoutTesseract).toContain("<canvas");
  expect(withoutTesseract).toContain("scene-icon");
  const withTesseract = renderModal("gauges", {
    ...sceneEffects,
    tesseract: true,
  });
  expect(withTesseract).toContain("headroom-orrery");
  expect(withTesseract).not.toContain("scene-icon");
});
