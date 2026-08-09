import type { EffortLevelBucket, EffortSummary } from "./types";

/** Canonical display order. Anything the providers add later sorts alphabetically after these,
 * so an unknown future value is still rendered rather than dropped. */
const canonicalOrder = ["low", "medium", "high", "xhigh"];

/** Trim and lowercase only. Effort is never inferred from model names, model catalogs,
 * reasoning-token counts, or token ratios. */
export function normalizeEffort(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function effortRank(effort: string) {
  const index = canonicalOrder.indexOf(effort);
  return index >= 0 ? index : canonicalOrder.length;
}

export function compareEffort(a: string, b: string) {
  return effortRank(a) - effortRank(b) || a.localeCompare(b);
}

export function sortEffortBuckets<T extends { effort: string }>(buckets: T[]) {
  return [...buckets].sort((a, b) => compareEffort(a.effort, b.effort));
}

/** Charts render at most five known values plus Other; storage and APIs retain every value.
 * Capping preserves totals: the remainder is summed into `Other`, never discarded. */
export function capEffortLevels<T extends EffortLevelBucket>(levels: T[], limit = 5) {
  const known = levels.filter((level) => level.effort !== "");
  if (known.length <= limit) return sortEffortBuckets(known).map((level) => ({ ...level }));
  const ranked = [...known].sort((a, b) => b.tokens - a.tokens || b.observations - a.observations);
  const kept = sortEffortBuckets(ranked.slice(0, limit)).map((level) => ({ ...level }));
  const rest = ranked.slice(limit);
  return [
    ...kept,
    {
      effort: "other",
      observations: rest.reduce((sum, level) => sum + level.observations, 0),
      tokens: rest.reduce((sum, level) => sum + level.tokens, 0),
    },
  ];
}

/** The one function that owns effort arithmetic. The server calls it on SQL-grouped rows; the
 * client may call it only on already-grouped rows, such as an Explorer brush subrange. */
export function foldEffort(
  knownBuckets: EffortLevelBucket[],
  context: {
    eligibleTokens: number;
    unknownObservations: number;
    quality: EffortSummary["quality"];
  },
): EffortSummary {
  const levels = sortEffortBuckets(knownBuckets.filter((bucket) => bucket.effort !== ""));
  const attributedTokens = levels.reduce((sum, level) => sum + level.tokens, 0);
  const observedObservations = levels.reduce((sum, level) => sum + level.observations, 0);
  const eligibleTokens = Math.max(0, context.eligibleTokens);
  const unknownObservations = Math.max(0, context.unknownObservations);

  // Attributed tokens above the authoritative ccusage denominator means the two sides disagree
  // about what happened. Report the exact delta instead of clamping it into a plausible chart.
  const overAttributed = attributedTokens > eligibleTokens;
  const reconciliationDeltaTokens = overAttributed ? attributedTokens - eligibleTokens : 0;
  const quality: EffortSummary["quality"] = overAttributed ? "degraded" : context.quality;
  const unknownTokens = overAttributed ? null : eligibleTokens - attributedTokens;

  const shareDenominator = overAttributed ? 0 : eligibleTokens;
  const withShares = levels.map((level) => ({
    ...level,
    tokenShare: shareDenominator > 0 ? level.tokens / shareDenominator : null,
  }));

  const observationDenominator = observedObservations + unknownObservations;
  const dominantSource = attributedTokens > 0 && !overAttributed
    ? { basis: "tokens" as const, pick: (level: EffortLevelBucket) => level.tokens }
    : observedObservations > 0
      ? { basis: "observations" as const, pick: (level: EffortLevelBucket) => level.observations }
      : null;
  const dominantLevel = dominantSource
    ? levels.reduce((best, level) => (dominantSource.pick(level) > dominantSource.pick(best) ? level : best), levels[0])
    : null;

  const coverageState: EffortSummary["coverageState"] = levels.length === 0
    ? "unavailable"
    : !overAttributed && unknownObservations === 0 && (unknownTokens ?? 0) === 0 && quality === "ok"
      ? "complete"
      : "partial";

  return {
    coverageState,
    quality,
    dominant: dominantLevel?.effort ?? null,
    dominantBasis: dominantLevel ? dominantSource!.basis : null,
    mixed: levels.length >= 2,
    levels: withShares,
    observedObservations,
    unknownObservations,
    observationCoverage: observationDenominator > 0 ? observedObservations / observationDenominator : null,
    eligibleTokens,
    attributedTokens,
    unknownTokens,
    tokenCoverage: overAttributed || eligibleTokens === 0 ? null : attributedTokens / eligibleTokens,
    reconciliationDeltaTokens,
  };
}

export type EffortDayPoint = {
  date: string;
  /** Reconciliation failed for this day, so no share may be drawn for it. */
  suppressed: boolean;
  total: number;
  values: Record<string, number>;
  summary: EffortSummary;
};

/** Turns one `group=day` response into a stackable series. The kept values are chosen once across
 * the whole range rather than per day, so a level does not change colour or disappear between
 * adjacent bars; the remainder collapses into `other` and totals are preserved. */
export function buildEffortDaySeries(
  rows: Array<{ key: string; summary: EffortSummary }>,
  basis: "tokens" | "observations",
  limit = 5,
): { keys: string[]; points: EffortDayPoint[]; suppressedDays: number } {
  const amountOf = (level: EffortLevelBucket) => (basis === "tokens" ? level.tokens : level.observations);
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.summary.reconciliationDeltaTokens > 0) continue;
    for (const level of row.summary.levels) totals.set(level.effort, (totals.get(level.effort) ?? 0) + amountOf(level));
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([effort]) => effort);
  const kept = new Set(sortEffortBuckets(ranked.slice(0, limit).map((effort) => ({ effort }))).map((bucket) => bucket.effort));
  const keys = [
    ...sortEffortBuckets([...kept].map((effort) => ({ effort }))).map((bucket) => bucket.effort),
    ...(ranked.length > limit ? ["other"] : []),
    "unknown",
  ];

  let suppressedDays = 0;
  const points = rows.map((row) => {
    const values = Object.fromEntries(keys.map((key) => [key, 0]));
    // A day whose reconciliation failed draws nothing rather than a plausible-looking zero stack.
    const suppressed = row.summary.reconciliationDeltaTokens > 0;
    if (suppressed) suppressedDays++;
    else {
      for (const level of row.summary.levels) {
        const key = kept.has(level.effort) ? level.effort : "other";
        values[key] += amountOf(level);
      }
      values.unknown = basis === "tokens" ? Math.max(0, row.summary.unknownTokens ?? 0) : row.summary.unknownObservations;
    }
    return {
      date: row.key,
      suppressed,
      total: Object.values(values).reduce((sum, value) => sum + value, 0),
      values,
      summary: row.summary,
    };
  });
  return { keys, points, suppressedDays };
}

export const emptyEffortSummary = (quality: EffortSummary["quality"] = "ok"): EffortSummary =>
  foldEffort([], { eligibleTokens: 0, unknownObservations: 0, quality });
