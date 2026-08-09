import { expect, test } from "bun:test";
import { dailyQuotaMarkers, hourlyQuotaMarkers } from "./quota-markers";
import type { QuotaHistory } from "./types";

const timeZone = "America/New_York";
const quotaAt = Date.parse("2026-07-18T14:15:00.000Z");
const resetAt = Date.parse("2026-07-18T20:40:00.000Z");
const history: QuotaHistory = {
  available: true,
  trackingSince: quotaAt,
  windows: [
    { provider: "codex", window: "fiveHour", reachedCount: 1, lastReachedAt: quotaAt, reachedAt: [quotaAt] },
    { provider: "codex", window: "weekly", reachedCount: 1, lastReachedAt: quotaAt, reachedAt: [quotaAt] },
  ],
  codexBankedResets: { usedCount: 1, used: [{ id: "reset-1", title: "Reset", usedAt: resetAt }] },
};

test("daily markers combine quota and reset events that share a day", () => {
  expect(dailyQuotaMarkers(history, ["2026-07-18"], null, timeZone)).toEqual([
    { key: "2026-07-18:codex:mixed", x: "2026-07-18", kind: "mixed", provider: "codex", label: "Codex 5h quota reached · Codex reset applied" },
  ]);
});

test("hourly markers preserve separate event hours and ignore weekly limits", () => {
  expect(hourlyQuotaMarkers(history, "2026-07-18", null, timeZone)).toEqual([
    { key: "10:codex:quota", x: "10", kind: "quota", provider: "codex", label: "Codex 5h quota reached" },
    { key: "16:codex:reset", x: "16", kind: "reset", provider: "codex", label: "Codex reset applied" },
  ]);
});

test("agent filtering only returns events for the selected provider", () => {
  const mixedHistory: QuotaHistory = {
    ...history,
    windows: [
      ...history.windows,
      { provider: "anthropic", window: "fiveHour", reachedCount: 1, lastReachedAt: quotaAt, reachedAt: [quotaAt] },
    ],
  };

  expect(dailyQuotaMarkers(mixedHistory, ["2026-07-18"], "anthropic", timeZone)).toEqual([
    { key: "2026-07-18:anthropic:quota", x: "2026-07-18", kind: "quota", provider: "anthropic", label: "Claude 5h quota reached" },
  ]);
  expect(dailyQuotaMarkers(mixedHistory, ["2026-07-18"], "warp", timeZone)).toEqual([]);
});
