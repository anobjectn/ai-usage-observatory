import { useEffect, useMemo, useState } from "react";
import type { DateRange } from "../../time-range";

export type Provider = "anthropic" | "codex";
export type AllowancePolicy = "capture" | "headroom";
export type ProfileCard = {
  id: string;
  policy: AllowancePolicy;
  score: number | null;
  band: "on-target" | "drifting" | "off-target" | null;
  confidence: string;
  explanation: string;
  rubricVersion: string;
  components: Array<{ id: string; label: string; weight: number; value: number | null; normalized: number | null; unavailableReason?: string }>;
};
export type GroupSummary = {
  processed: number; raw: number; input: number; output: number; cacheRead: number; cacheCreation: number; cost: number;
  sessions: number; medianSession: number; p90Session: number; largestSession: number;
  outputShare: number | null; contextCarry: number | null; cacheHitRate: number | null; amplification: number | null;
  cacheWritesReported: boolean; medianTurns: number | null; medianContextWritten: number | null; largestContextWritten: number | null;
};
export type ModelRow = {
  model: string; family: string; provider: Provider; sessions: number; dominantIn: number;
  processed: number; input: number; output: number; cacheRead: number; cacheCreation: number; cost: number;
  ratePerMillion: number | null; priced: boolean; outputShare: number | null; contextCarry: number | null;
  cacheHitRate: number | null; medianSession: number; outliers: number;
};
export type OutlierRow = {
  sessionId: string; provider: Provider; agent: string; date: string | null; project: string; model: string; family: string;
  reasons: string[]; processed: number; input: number; output: number; cacheRead: number; cacheCreation: number;
  cost: number; cohortMedian: number; timesCohortMedian: number | null; estimatedTurns: number | null;
};
export type FindingRow = {
  ruleId: string; severity: "notice" | "opportunity" | "urgent"; sessionId: string; provider: Provider; agent: string;
  date: string | null; project: string; model: string; headline: string;
  metrics: Array<{ label: string; value: string }>; recoverable: number | null; cost: number; processed: number;
};
export type RuleSummary = { id: string; label: string; severity: FindingRow["severity"]; question: string; basis: string; count: number; recoverable: number };
export type FindingGroup = {
  sessionId: string; provider: Provider; agent: string; date: string | null; project: string; model: string;
  cost: number; processed: number;
  /** Largest single recoverable estimate — rules can price the same cache reads. */
  recoverable: number;
  findings: Array<Pick<FindingRow, "ruleId" | "severity" | "headline" | "metrics" | "recoverable">>;
};
export type Insights = {
  profiles: ProfileCard[];
  volume: GroupSummary & { cacheCreationAvailable: boolean; providers: Array<GroupSummary & { provider: Provider }>; models: ModelRow[] };
  cacheComposition: {
    directInput: number; cacheRead: number; cacheCreation: number; output: number; cacheHitRate: number | null; amplification: number | null;
    providers: Array<{ provider: Provider; directInput: number; cacheRead: number; cacheCreation: number; output: number; cacheHitRate: number | null; amplification: number | null; cacheWritesReported: boolean; medianTurns: number | null; medianContextWritten: number | null; largestContextWritten: number | null }>;
  };
  outliers: { count: number; sessionShare: number; tokenShare: number; cohortsEvaluated: number; cohortsSkipped: number; sessions: OutlierRow[] };
  efficiency: { rules: RuleSummary[]; groups: FindingGroup[]; groupPage: number; groupPages: number; groupPageSize: number; totals: { findings: number; flaggedSessions: number; sessionShare: number | null; recoverable: number; recoverableShare: number | null } };
  facets: {
    modelFamilies: string[]; sessionsInScope: number; sessionsShown: number; outlierCount: number;
    effortLevels: string[];
    /** Observed family × effort pairs only; never a synthetic cross-product. */
    effortCombos: Array<{ family: string; effort: string; kind: "interactive" | "automated" | "synthetic" | "unknown" }>;
  };
};

/** Model family is deliberately absent: it moved into the global Agent filter, so there is one
 * control for "which agent or model" rather than two that could disagree. */
export type DataFacets = {
  outliers: "all" | "typical" | "only";
  finding: string;
  effort: string;
  /** 1-based page of grouped efficiency findings; server-paginated. */
  findingPage: number;
  /** Target policy for the allowance rubric — a preference, not a session facet. */
  policy: AllowancePolicy;
};

export const compactTokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const percent = (value: number | null, digits = 0) => (value === null ? "N/A" : `${(value * 100).toFixed(digits)}%`);
export const providerLabel = (provider: Provider) => (provider === "anthropic" ? "Claude" : "Codex");
export const providerColor = (provider: Provider) => (provider === "anthropic" ? "var(--anthropic-color)" : "var(--openai-color)");
export const shortDate = (value: string | null) =>
  value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no timestamp";
/** Deep link to the Sessions view with the row expanded, matching `sessionHref` in App.tsx. */
export const sessionHref = (sessionId: string) => `?view=sessions&session=${encodeURIComponent(sessionId)}`;

export function useInsights(
  scope: { days: string; dateRange: DateRange | null; providers: string[]; modelFamilies: string[]; pathTag: string; showCache: boolean; collectedAt: string },
  facets: DataFacets,
) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerKey = scope.providers.join(",");
  const familyKey = scope.modelFamilies.join(",");
  const query = useMemo(() => {
    const params = new URLSearchParams({
      range: scope.days,
      providers: providerKey,
      modelFamilies: familyKey,
      pathTag: scope.pathTag,
      cache: scope.showCache ? "include" : "exclude",
      outliers: facets.outliers,
      finding: facets.finding,
      effort: facets.effort,
      findingPage: String(facets.findingPage),
      policy: facets.policy,
    });
    if (scope.dateRange) {
      params.set("from", scope.dateRange.from);
      params.set("to", scope.dateRange.to);
    }
    return params.toString();
  }, [scope.days, scope.dateRange, providerKey, familyKey, scope.pathTag, scope.showCache, facets.outliers, facets.finding, facets.effort, facets.findingPage, facets.policy]);

  useEffect(() => {
    let active = true;
    fetch(`/api/insights?${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Insights are unavailable");
        return (await response.json()) as Insights;
      })
      .then((value) => { if (active) { setInsights(value); setError(null); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Insights are unavailable"); });
    return () => { active = false; };
  }, [query, scope.collectedAt]);

  return { insights, error };
}
