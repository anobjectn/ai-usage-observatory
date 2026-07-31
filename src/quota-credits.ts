import type { AnthropicWebCredits, CodexCredits, QuotaProvider } from "./types";

// Imported Claude Web observations never expire on their own, but their
// usefulness decays: an import from last week may no longer reflect the real
// balance. These thresholds only change how the age is *labeled* — the values
// stay visible regardless. Tuned as named constants so they can be revised
// after real use without hunting through render code.
export const CREDIT_AGING_MS = 24 * 60 * 60 * 1000;
export const CREDIT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export type CreditFreshness = "fresh" | "aging" | "stale";

/** Freshness of an *imported* observation, independent of live provider quota
 * freshness (which comes from provider status / dataAgeMs). */
export function creditFreshness(capturedAt: number | null, now = Date.now()): CreditFreshness | null {
  if (capturedAt === null || !Number.isFinite(capturedAt)) return null;
  const age = now - capturedAt;
  if (age >= CREDIT_STALE_MS) return "stale";
  if (age >= CREDIT_AGING_MS) return "aging";
  return "fresh";
}

export type UsageCreditView = {
  enabled: boolean;
  spent: number;
  limit: number | null;
  percent: number | null;
  currency: string;
  resetsAt: number | null;
};

export type PrepaidView = {
  balance: number;
  currency: string;
  capturedAt: number;
  freshness: CreditFreshness | null;
};

/** One grouped presentation object for the monetary Fable promotion — its
 * campaign and promotional tranche folded together so the Overview renders a
 * single bordered component, never scattered metrics. */
export type FableCreditView = {
  remaining: number;
  grant: number | null;
  currency: string;
  /** Canonical calendar-date string to render verbatim (no timezone math). */
  expiresOn: string | null;
  /** UTC-midnight epoch for countdown / expired math only. */
  expiresAt: number | null;
  expired: boolean;
  campaignId: string | null;
  campaignGranted: boolean | null;
};

export type AnthropicCreditView = {
  /** Live OAuth usage-credit spend, if the provider reports it. */
  usageCredit: UsageCreditView | null;
  /** Imported prepaid balance, if a Claude Web snapshot exists. */
  prepaid: PrepaidView | null;
  /** Grouped Fable transition credit, or null when it should vanish. */
  fable: FableCreditView | null;
  /** When the Claude Web snapshot was observed, or null when none imported. */
  importedAt: number | null;
  importFreshness: CreditFreshness | null;
};

export type CodexCreditView = CodexCredits | null;

export function buildCodexCreditView(report: QuotaProvider | undefined): CodexCreditView {
  const snapshot = report?.snapshot?.kind === "window" ? report.snapshot : null;
  return snapshot?.codexCredits ?? null;
}

function usageCreditView(report: QuotaProvider | undefined): UsageCreditView | null {
  const snapshot = report?.snapshot?.kind === "window" ? report.snapshot : null;
  const credits = snapshot?.usageCredits;
  if (!credits) return null;
  const percent =
    credits.limitAmount && credits.limitAmount > 0
      ? Math.max(0, Math.min(100, (credits.spentAmount / credits.limitAmount) * 100))
      : null;
  return {
    enabled: credits.enabled,
    spent: credits.spentAmount,
    limit: credits.limitAmount,
    percent,
    currency: credits.currency,
    resetsAt: credits.resetsAt,
  };
}

/** Fold campaign + promotional tranches into one Fable view. Returns null (the
 * component vanishes) unless the fable_transition campaign is present OR at
 * least one promotional tranche exists. */
function fableCreditView(web: AnthropicWebCredits | null | undefined, now: number): FableCreditView | null {
  if (!web) return null;
  const tranches = web.promotionalTranches ?? [];
  const isFable = web.campaign?.id === "fable_transition" || tranches.length > 0;
  if (!isFable) return null;
  const remaining = tranches.reduce((sum, tranche) => sum + tranche.remainingAmount, 0);
  const grantFromTranches = tranches.reduce<number | null>(
    (sum, tranche) => (tranche.grantedAmount === null ? sum : (sum ?? 0) + tranche.grantedAmount),
    null,
  );
  const grant = web.campaign?.amount ?? grantFromTranches;
  // Prefer the tranche's own expiry, then the campaign's, then the top-level
  // next-expiry. The three often carry the same imported date.
  const trancheWithExpiry = tranches.find((tranche) => tranche.expiresAt !== null);
  const expiresAt = trancheWithExpiry?.expiresAt ?? web.campaign?.expiresAt ?? web.nextExpiresAt ?? null;
  const expiresOn = trancheWithExpiry?.expiresOn ?? web.campaign?.expiresOn ?? web.nextExpiresOn ?? null;
  return {
    remaining,
    grant,
    currency: web.currency,
    expiresOn,
    expiresAt,
    expired: expiresAt !== null && expiresAt <= now,
    campaignId: web.campaign?.id ?? null,
    campaignGranted: web.campaign?.granted ?? null,
  };
}

/** Build the Overview credit view from the Anthropic provider report. Pure and
 * tolerant of older quota-service contracts: every credit source is optional
 * and missing fields simply produce null sub-views. */
export function buildAnthropicCreditView(
  report: QuotaProvider | undefined,
  now = Date.now(),
): AnthropicCreditView {
  const web = report?.anthropicWebCredits ?? null;
  return {
    usageCredit: usageCreditView(report),
    prepaid:
      web && web.currentBalance !== null
        ? {
            balance: web.currentBalance,
            currency: web.currency,
            capturedAt: web.capturedAt,
            freshness: creditFreshness(web.capturedAt, now),
          }
        : null,
    fable: fableCreditView(web, now),
    importedAt: web?.capturedAt ?? null,
    importFreshness: creditFreshness(web?.capturedAt ?? null, now),
  };
}

/** Format a major-unit amount using the object's own currency. Falls back to a
 * plain prefix for unknown ISO codes. */
export function formatCredit(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
