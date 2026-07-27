import { Activity, AlertTriangle } from "lucide-react";
import type { DashboardData } from "../../types";
import { EfficiencyFindings } from "./efficiency";
import { FacetBar } from "./facets";
import { type DataFacets, useInsights } from "./insights";
import { OutlierSessions } from "./outliers";
import { AllowanceProfiles } from "./profiles";
import { CacheComposition, InferenceVolume, ModelBreakdown } from "./signals";

export function UsageIntelligence({
  data,
  days,
  provider,
  pathTag,
  showCache,
  facets,
  onFacets,
  onOpenSession,
}: {
  data: DashboardData;
  days: string;
  provider: string;
  pathTag: string;
  showCache: boolean;
  facets: DataFacets;
  onFacets: (next: Partial<DataFacets>) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { insights, error } = useInsights({ days, provider, pathTag, showCache, collectedAt: data.collectedAt }, facets);

  if (error) {
    return (
      <section className="panel intelligence-empty">
        <AlertTriangle />
        <p>{error}</p>
      </section>
    );
  }
  if (!insights) {
    return (
      <section className="panel intelligence-empty">
        <Activity className="spin" />
        <p>Deriving local usage evidence…</p>
      </section>
    );
  }

  return (
    <>
      <section className="intelligence-heading">
        <span className="overline">USAGE INTELLIGENCE · LOCAL-FIRST · EXPERIMENTAL</span>
        <h2>Where your allowance goes, and where it leaks.</h2>
        <p>
          Everything below is derived from token counts already on this machine — no prompt, file, or
          command text is read or stored. The scores and findings are optimization lenses, not
          judgments of your work, and the heuristics are new enough to deserve scepticism. Each panel
          states the evidence it used and what it could not see.
        </p>
      </section>
      <AllowanceProfiles profiles={insights.profiles} />
      <FacetBar facets={facets} onChange={onFacets} insights={insights} provider={provider} days={days} pathTag={pathTag} showCache={showCache} />
      <EfficiencyFindings insights={insights} facets={facets} onChange={onFacets} onOpenSession={onOpenSession} />
      <section className="measure-grid">
        <InferenceVolume insights={insights} />
        <CacheComposition insights={insights} />
        <ModelBreakdown insights={insights} />
      </section>
      <OutlierSessions insights={insights} onOpenSession={onOpenSession} />
    </>
  );
}
