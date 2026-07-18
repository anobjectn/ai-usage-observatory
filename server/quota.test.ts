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
    expect(summary.windows.find((item) => item.provider === "anthropic" && item.window === "fiveHour")?.reachedCount).toBe(2);
    expect(summary.windows.find((item) => item.provider === "anthropic" && item.window === "weekly")?.reachedCount).toBe(1);
  });

  test("counts an available reset credit that disappears before expiry as used", () => {
    const expiry = new Date(10_000).toISOString();
    const resets = [
      { capturedAt: 1_000, creditsJson: JSON.stringify([{id:"credit-1",status:"available",expiresAt:expiry}]) },
      { capturedAt: 2_000, creditsJson: "[]" },
    ];
    expect(summarizeQuotaHistory([], resets).codexBankedResets.usedCount).toBe(1);
  });
});
