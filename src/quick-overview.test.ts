import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuickOverviewModal, benchmarkLoadedAtLabel } from "./components/app-modals";
import { condensedResetCopy, quickOverviewCards } from "./app/analytics";
import { quickOverviewModeStorageKey, savedQuickOverviewMode } from "./app/preferences";
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

test("savedQuickOverviewMode restores grid and defaults everything else to gauges", () => {
  const stored = new Map<string, string>();
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key: string) => stored.get(key) ?? null } as Storage;
  try {
    expect(savedQuickOverviewMode()).toBe("gauges");
    for (const value of ["grid", "bogus"]) {
      stored.set(quickOverviewModeStorageKey, value);
      expect(savedQuickOverviewMode()).toBe(value === "grid" ? "grid" : "gauges");
    }
  } finally {
    globalThis.localStorage = realStorage;
  }
  // Without storage at all (private mode, or this runtime) it still answers.
  expect(savedQuickOverviewMode()).toBe("gauges");
});

test("benchmarkLoadedAtLabel includes a full local date and time", () => {
  const loadedAt = new Date(2026, 8, 7, 15, 42).getTime();
  expect(benchmarkLoadedAtLabel(null, "DeepSWE")).toBe("Loading DeepSWE...");
  const label = benchmarkLoadedAtLabel(loadedAt, "DeepSWE");
  expect(label.startsWith("Loaded ")).toBe(true);
  expect(label).toContain("2026");
  expect(label).toContain(new Date(loadedAt).toLocaleString(undefined, { month: "short" }));
  expect(label).toContain("42");
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

test("gauges mode renders a headroom dial with a reset countdown per window", () => {
  const html = renderModal("gauges");
  // Buckets report 42% and 61% used; dials read out what is left.
  expect(html).toContain('aria-label="Anthropic 5-hour: 58% left"');
  expect(html).toContain('aria-label="Anthropic Weekly: 39% left"');
  expect(html).not.toContain("42%");
  expect(html).toContain("reset in");
  // The orrery legend names every provider; only the reported one gets a dial.
  expect(html).not.toContain('aria-label="OpenAI');
});

test("grid mode lists each window as a row with headroom and reset info", () => {
  const html = renderModal("grid");
  expect(html).toContain("58% left");
  expect(html).toContain('aria-label="Plenty remaining"');
  expect(html).toContain("resets in");
  expect(html).not.toContain('aria-label="Anthropic 5-hour: 58% left"');
});

test("the modal is named for assistive technology and keeps the layout toggle", () => {
  for (const mode of ["gauges", "grid"] as const) {
    const html = renderModal(mode);
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Quick quota overview"/);
    expect(html).toContain('role="group" aria-label="Overview layout"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
  }
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

test("a stale Claude Code token renders a next-step notice in both modes", () => {
  const quotas = {
    available: true,
    collectedAt: new Date().toISOString(),
    usage: {
      generatedAt: Date.now(),
      providers: [
        {
          provider: "anthropic",
          status: "stale",
          source: "anthropic_api",
          snapshot: null,
          error:
            "401 from oauth/usage — access token stale; will self-heal on next Claude Code use (no self-refresh by design)",
        },
      ],
    },
  } as DashboardData["quotas"];
  for (const mode of ["gauges", "grid"] as const) {
    const html = renderToStaticMarkup(
      createElement(QuickOverviewModal, {
        quotas,
        mode,
        onModeChange: () => {},
        accent: "#78a8ff",
        providerColors,
        sceneEffects,
        onClose: () => {},
      }),
    );
    expect(html).toContain("Run any prompt in Claude Code");
    // The compact variant omits the producer's raw wording.
    expect(html).not.toContain("401 from oauth/usage");
  }
});

test("a rate-limited provider keeps its last values under an aged stale label", () => {
  const quotas = {
    available: true,
    collectedAt: new Date().toISOString(),
    usage: {
      generatedAt: Date.now(),
      providers: [
        {
          provider: "anthropic",
          status: "stale",
          source: "anthropic_api",
          dataAgeMs: 18 * 60_000,
          servingLastGood: true,
          snapshot: {
            kind: "window",
            fiveHour: { usedPercent: 40, resetsAt: Date.now() + 3_600_000 },
            weekly: { usedPercent: 70, resetsAt: Date.now() + 86_400_000 },
          },
          error: "oauth/usage HTTP 429",
        },
      ],
    },
  } as DashboardData["quotas"];
  const [card] = quickOverviewCards(quotas);
  expect(card.state).toBe("stale");
  expect(card.stateLabel).toBe("stale · 18m");
  expect(card.buckets.map((bucket) => bucket.usedPercent)).toEqual([40, 70]);
  const html = renderToStaticMarkup(
    createElement(QuickOverviewModal, {
      quotas,
      mode: "gauges",
      onModeChange: () => {},
      accent: "#78a8ff",
      providerColors,
      sceneEffects,
      onClose: () => {},
    }),
  );
  expect(html).toContain("stale · 18m");
  expect(html).toContain("60%");
  expect(html).toContain("Showing the last reading, from 18m ago.");
});
