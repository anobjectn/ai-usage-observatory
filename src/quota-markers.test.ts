import { expect, test } from "bun:test";
import { dailyQuotaMarkers, hourlyQuotaMarkers, quotaMarkersAt } from "./quota-markers";
import type { QuotaHistory } from "./types";

const timeZone = "America/New_York";
const quotaAt = Date.parse("2026-07-18T14:15:00.000Z");
const weeklyAt = Date.parse("2026-07-18T18:20:00.000Z");
const resetAt = Date.parse("2026-07-18T20:40:00.000Z");
const history: QuotaHistory = {
  available: true,
  trackingSince: quotaAt,
  windows: [
    { provider: "codex", window: "fiveHour", reachedCount: 1, lastReachedAt: quotaAt, reachedAt: [quotaAt] },
    { provider: "codex", window: "weekly", reachedCount: 1, lastReachedAt: weeklyAt, reachedAt: [weeklyAt] },
  ],
  codexBankedResets: { usedCount: 1, used: [{ id: "reset-1", title: "Reset", usedAt: resetAt }] },
};

test("daily markers combine quota, weekly and reset events that share a day", () => {
  expect(dailyQuotaMarkers(history, ["2026-07-18"], null, timeZone)).toEqual([
    {
      key: "2026-07-18:codex:mixed",
      x: "2026-07-18",
      kind: "mixed",
      provider: "codex",
      label: "Codex 5h quota reached · Codex weekly quota reached · Codex reset applied",
      entries: [
        { kind: "quota", label: "5h quota reached", count: 1, timestamps: [quotaAt] },
        { kind: "weekly", label: "weekly quota reached", count: 1, timestamps: [weeklyAt] },
        { kind: "reset", label: "reset applied", count: 1, timestamps: [resetAt] },
      ],
    },
  ]);
});

test("hourly markers preserve separate event hours including weekly limits", () => {
  expect(hourlyQuotaMarkers(history, "2026-07-18", null, timeZone)).toEqual([
    {
      key: "10:codex:quota",
      x: "10",
      kind: "quota",
      provider: "codex",
      label: "Codex 5h quota reached",
      entries: [{ kind: "quota", label: "5h quota reached", count: 1, timestamps: [quotaAt] }],
    },
    {
      key: "14:codex:weekly",
      x: "14",
      kind: "weekly",
      provider: "codex",
      label: "Codex weekly quota reached",
      entries: [{ kind: "weekly", label: "weekly quota reached", count: 1, timestamps: [weeklyAt] }],
    },
    {
      key: "16:codex:reset",
      x: "16",
      kind: "reset",
      provider: "codex",
      label: "Codex reset applied",
      entries: [{ kind: "reset", label: "reset applied", count: 1, timestamps: [resetAt] }],
    },
  ]);
});

test("repeated reaches in one bucket count up and keep every instant in order", () => {
  const laterQuotaAt = quotaAt + 45 * 60_000;
  const repeated: QuotaHistory = {
    ...history,
    windows: [
      { provider: "anthropic", window: "fiveHour", reachedCount: 2, lastReachedAt: laterQuotaAt, reachedAt: [laterQuotaAt, quotaAt] },
    ],
    codexBankedResets: { usedCount: 0, used: [] },
  };

  const [marker] = dailyQuotaMarkers(repeated, ["2026-07-18"], "anthropic", timeZone);
  expect(marker?.label).toBe("Claude 5h quota reached ×2");
  expect(marker?.entries).toEqual([
    { kind: "quota", label: "5h quota reached", count: 2, timestamps: [quotaAt, laterQuotaAt] },
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
    {
      key: "2026-07-18:anthropic:quota",
      x: "2026-07-18",
      kind: "quota",
      provider: "anthropic",
      label: "Claude 5h quota reached",
      entries: [{ kind: "quota", label: "5h quota reached", count: 1, timestamps: [quotaAt] }],
    },
  ]);
  expect(dailyQuotaMarkers(mixedHistory, ["2026-07-18"], "warp", timeZone)).toEqual([]);
});

test("tooltip lookup takes only the markers standing at one chart point", () => {
  const markers = dailyQuotaMarkers(
    {
      ...history,
      windows: [
        ...history.windows,
        { provider: "anthropic", window: "fiveHour", reachedCount: 1, lastReachedAt: quotaAt, reachedAt: [quotaAt] },
      ],
    },
    ["2026-07-18"],
    null,
    timeZone,
  );

  expect(quotaMarkersAt(markers, "2026-07-18").map((marker) => marker.provider)).toEqual([
    "anthropic",
    "codex",
  ]);
  expect(quotaMarkersAt(markers, "2026-07-19")).toEqual([]);
  expect(quotaMarkersAt(markers, undefined)).toEqual([]);
  // Hourly buckets key on numeric hours, which Recharts hands back as numbers.
  expect(quotaMarkersAt(hourlyQuotaMarkers(history, "2026-07-18", null, timeZone), 10)).toHaveLength(1);
});
