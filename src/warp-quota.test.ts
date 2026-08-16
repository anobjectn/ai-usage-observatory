import { expect, test } from "bun:test";
import { warpQuotaSummary } from "./warp-quota";
import type { QuotaProvider } from "./types";

const report = {
  provider: "warp",
  status: "ok",
  source: "warp_plist",
  dataAgeMs: 480_000,
  capturedAt: 1_000,
  snapshot: {
    kind: "pool",
    pool: { used: 138, limit: 1_500, usedPercent: 9.2, refreshesAt: 2_000 },
    extra: {
      isUnlimitedVoice: false,
      voiceRequestLimit: 999_999,
      voiceRequestsUsed: 0,
      isUnlimitedCodebaseIndices: false,
      maxCodebaseIndices: 40,
      maxFilesPerRepo: 100_000,
    },
  },
  manualEntries: [
    { provider: "warp", field: "addon_credits", value: "1,010", note: "2026-07-12", updatedAt: 900 },
  ],
} satisfies QuotaProvider;

test("Warp quota summary keeps pool, freshness, manual credit, and feature limits separate", () => {
  expect(warpQuotaSummary(report)).toEqual({
    remainingRequests: 1_362,
    dataAgeMs: 480_000,
    capturedAt: 1_000,
    addonCredits: 1_010,
    addonCreditNote: "2026-07-12",
    addonCreditUpdatedAt: 900,
    voiceRequestsUsed: 0,
    voiceRequestLimit: 999_999,
    voiceUnlimited: false,
    codebaseIndicesLimit: 40,
    codebaseIndicesUnlimited: false,
    maxFilesPerRepo: 100_000,
  });
});

test("Warp quota summary does not infer unavailable values", () => {
  expect(warpQuotaSummary({ ...report, provider: "codex", manualEntries: [] })).toMatchObject({
    remainingRequests: null,
    addonCredits: null,
    voiceRequestsUsed: null,
    codebaseIndicesLimit: null,
  });
});
