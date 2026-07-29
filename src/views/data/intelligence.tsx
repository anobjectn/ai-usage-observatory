import { Activity, AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import type { DashboardData } from "../../types";
import { agentSelectionParams, type AgentSelection } from "../../agent-filter";
import { useEffortAggregate, useEffortRefreshOnIndexChange } from "../../hooks/use-effort";
import { EfficiencyFindings } from "./efficiency";
import { FacetBar } from "./facets";
import { type DataFacets, useInsights } from "./insights";
import { OutlierSessions } from "./outliers";
import { AllowanceProfiles } from "./profiles";
import { CacheComposition, InferenceVolume, ModelBreakdown } from "./signals";
import { EffortProvenance, ReasoningEffortAnalysis, useReasoningEffort } from "./effort";

function agentSummary(providers: string[], modelFamilies: string[]) {
  if (providers.length === 0 && modelFamilies.length === 0) return "all agents";
  return [...providers, ...modelFamilies].join(" + ");
}

export function UsageIntelligence({
  data,
  days,
  agent,
  pathTag,
  showCache,
  facets,
  onFacets,
  onOpenSession,
}: {
  data: DashboardData;
  days: string;
  agent: AgentSelection;
  pathTag: string;
  showCache: boolean;
  facets: DataFacets;
  onFacets: (next: Partial<DataFacets>) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { providers, modelFamilies } = useMemo(() => agentSelectionParams(agent), [agent]);
  const { insights, error } = useInsights(
    { days, providers, modelFamilies, pathTag, showCache, collectedAt: data.collectedAt },
    facets,
  );
  const effort = useReasoningEffort({ days, providers, modelFamilies, pathTag, facets });
  const modelEffort = useEffortAggregate("model", {});
  useEffortRefreshOnIndexChange(effort.status?.indexVersion, [modelEffort.load]);

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
      <AllowanceProfiles profiles={insights.profiles} modelEffort={modelEffort.data} />
      <FacetBar
        facets={facets}
        onChange={onFacets}
        insights={insights}
        agentSummary={agentSummary(providers, modelFamilies)}
        days={days}
        pathTag={pathTag}
        showCache={showCache}
      />
      <EfficiencyFindings
        insights={insights}
        facets={facets}
        onChange={onFacets}
        onOpenSession={onOpenSession}
        effortBySession={effort.decoded}
        aside={<ReasoningEffortAnalysis effort={effort} />}
      />
      <section className="measure-grid">
        <InferenceVolume insights={insights} />
        <CacheComposition insights={insights} />
        <ModelBreakdown insights={insights} />
      </section>
      <OutlierSessions insights={insights} onOpenSession={onOpenSession} />
      <EffortProvenance effort={effort} />
    </>
  );
}
