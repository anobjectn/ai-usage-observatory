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
import type { DateRange } from "../../time-range";

function agentSummary(providers: string[], modelFamilies: string[]) {
  if (providers.length === 0 && modelFamilies.length === 0) return "all agents";
  return [...providers, ...modelFamilies].join(" + ");
}

export function UsageIntelligence({
  data,
  days,
  dateRange,
  agent,
  pathTag,
  showCache,
  facets,
  onFacets,
  onOpenSession,
}: {
  data: DashboardData;
  days: string;
  dateRange: DateRange | null;
  agent: AgentSelection;
  pathTag: string;
  showCache: boolean;
  facets: DataFacets;
  onFacets: (next: Partial<DataFacets>) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { providers, modelFamilies } = useMemo(() => agentSelectionParams(agent), [agent]);
  const { insights, error } = useInsights(
    { days, dateRange, providers, modelFamilies, pathTag, showCache, collectedAt: data.collectedAt },
    facets,
  );
  const effort = useReasoningEffort({ days, dateRange, providers, modelFamilies, pathTag, facets });
  // Ordered by volume so the projects worth comparing are first, and disambiguated: two distinct
  // working directories can share a last path segment, and a duplicated option is unusable.
  const projectOptions = useMemo(() => {
    const ranked = [...data.projects].sort((a, b) => b.tokens - a.tokens);
    const shortOf = (id: string) => id.split("/").filter(Boolean).at(-1) ?? id;
    const counts = new Map<string, number>();
    for (const project of ranked) counts.set(shortOf(project.name), (counts.get(shortOf(project.name)) ?? 0) + 1);
    return ranked.map((project) => {
      const parts = project.name.split("/").filter(Boolean);
      const short = shortOf(project.name);
      return {
        id: project.name,
        label: (counts.get(short) ?? 0) > 1 ? parts.slice(-2).join("/") : short,
      };
    });
  }, [data.projects]);
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
      <AllowanceProfiles
        profiles={insights.profiles}
        modelEffort={modelEffort.data}
        policy={facets.policy}
        onPolicyChange={(policy) => onFacets({ policy })}
      />
      <FacetBar
        facets={facets}
        onChange={onFacets}
        insights={insights}
        agentSummary={agentSummary(providers, modelFamilies)}
        days={days}
        dateRange={dateRange}
        pathTag={pathTag}
        showCache={showCache}
      />
      <EfficiencyFindings
        insights={insights}
        facets={facets}
        onChange={onFacets}
        onOpenSession={onOpenSession}
        effortBySession={effort.decoded}
        aside={<ReasoningEffortAnalysis effort={effort} projects={projectOptions} />}
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
