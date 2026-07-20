import { describe, expect, test } from "bun:test";
import { summarizeQuotaHistory } from "./quota";

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
