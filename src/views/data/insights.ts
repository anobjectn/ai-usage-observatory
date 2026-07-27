import { useEffect, useMemo, useState } from "react";

export type Provider = "anthropic" | "codex";
export type ProfileCard = {
  id: string;
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
export type Insights = {
  profiles: ProfileCard[];
  volume: GroupSummary & { cacheCreationAvailable: boolean; providers: Array<GroupSummary & { provider: Provider }>; models: ModelRow[] };
  cacheComposition: {
    directInput: number; cacheRead: number; cacheCreation: number; output: number; cacheHitRate: number | null; amplification: number | null;
    providers: Array<{ provider: Provider; directInput: number; cacheRead: number; cacheCreation: number; output: number; cacheHitRate: number | null; amplification: number | null; cacheWritesReported: boolean; medianTurns: number | null; medianContextWritten: number | null; largestContextWritten: number | null }>;
  };
  outliers: { count: number; sessionShare: number; tokenShare: number; cohortsEvaluated: number; cohortsSkipped: number; sessions: OutlierRow[] };
  efficiency: { rules: RuleSummary[]; findings: FindingRow[]; truncated: number; totals: { findings: number; flaggedSessions: number; sessionShare: number | null; recoverable: number; recoverableShare: number | null } };
  facets: { modelFamilies: string[]; sessionsInScope: number; sessionsShown: number; outlierCount: number };
};

export type DataFacets = {
  outliers: "all" | "typical" | "only";
  modelFamily: string;
  finding: string;
};

export const compactTokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const percent = (value: number | null, digits = 0) => (value === null ? "N/A" : `${(value * 100).toFixed(digits)}%`);
export const providerLabel = (provider: Provider) => (provider === "anthropic" ? "Claude" : "Codex");
export const providerColor = (provider: Provider) => (provider === "anthropic" ? "var(--anthropic-color)" : "var(--openai-color)");
export const shortDate = (value: string | null) =>
  value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no timestamp";
/** Deep link to the Sessions view with the row expanded, matching `sessionHref` in App.tsx. */
export const sessionHref = (sessionId: string) => `?view=sessions&session=${encodeURIComponent(sessionId)}`;

export function useInsights(scope: { days: string; provider: string; pathTag: string; showCache: boolean; collectedAt: string }, facets: DataFacets) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => {
    const providerScope = /claude|anthropic/i.test(scope.provider) ? "anthropic" : /codex|openai/i.test(scope.provider) ? "codex" : "all";
    return new URLSearchParams({
      range: scope.days,
      provider: providerScope,
      pathTag: scope.pathTag,
      cache: scope.showCache ? "include" : "exclude",
      outliers: facets.outliers,
      modelFamily: facets.modelFamily,
      finding: facets.finding,
    }).toString();
  }, [scope.days, scope.provider, scope.pathTag, scope.showCache, facets.outliers, facets.modelFamily, facets.finding]);

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
