import type { QuotaProvider } from "./types";

export type WarpQuotaSummary = {
  remainingRequests: number | null;
  dataAgeMs: number | null;
  capturedAt: number | null;
  addonCredits: number | null;
  addonCreditNote: string | null;
  addonCreditUpdatedAt: number | null;
  voiceRequestsUsed: number | null;
  voiceRequestLimit: number | null;
  voiceUnlimited: boolean | null;
  codebaseIndicesLimit: number | null;
  codebaseIndicesUnlimited: boolean | null;
  maxFilesPerRepo: number | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function manualNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function warpQuotaSummary(report: QuotaProvider | undefined): WarpQuotaSummary {
  const snapshot = report?.provider === "warp" && report.snapshot?.kind === "pool" ? report.snapshot : null;
  const pool = snapshot?.pool;
  const extra = snapshot?.extra;
  const addonEntry = report?.manualEntries?.find(
    (entry) => entry.provider === "warp" && entry.field === "addon_credits",
  );

  return {
    remainingRequests:
      pool && Number.isFinite(pool.used) && Number.isFinite(pool.limit)
        ? Math.max(0, Math.round(pool.limit - pool.used))
        : null,
    dataAgeMs: finiteNumber(report?.dataAgeMs),
    capturedAt: finiteNumber(report?.capturedAt),
    addonCredits: manualNumber(addonEntry?.value),
    addonCreditNote: addonEntry?.note ?? null,
    addonCreditUpdatedAt: addonEntry?.updatedAt ?? null,
    voiceRequestsUsed: finiteNumber(extra?.voiceRequestsUsed),
    voiceRequestLimit: finiteNumber(extra?.voiceRequestLimit),
    voiceUnlimited: extra?.isUnlimitedVoice ?? null,
    codebaseIndicesLimit: finiteNumber(extra?.maxCodebaseIndices),
    codebaseIndicesUnlimited: extra?.isUnlimitedCodebaseIndices ?? null,
    maxFilesPerRepo: finiteNumber(extra?.maxFilesPerRepo),
  };
}
