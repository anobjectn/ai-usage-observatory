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
  const effort = useReasoningEffort({
    days,
    dateRange,
    providers,
    modelFamilies,
    agentSummary: agentSummary(providers, modelFamilies),
    pathTag,
    facets,
  });
  // Only projects with effort evidence in the current scope, ordered by in-scope volume so the
  // projects worth comparing are first. The dashboard's project list is all-time and ignores the
  // range, agent, and path-tag filters, so most of its entries would open an empty board.
  // The evidence rows are keyed by each observation's own working directory, but the board filters
  // by the session's, so a session that moved into a subdirectory adds a key the board can never
  // match; intersecting with the session-keyed project list drops it. Labels are disambiguated:
  // two working directories can share a last path segment.
  const projectOptions = useMemo(() => {
    const sessionProjects = new Set(data.projects.map((project) => project.name));
    const ranked = (effort.projectRows ?? [])
      .filter((row) => sessionProjects.has(row.key) && row.summary.observedObservations + row.summary.unknownObservations > 0)
      .sort((a, b) => b.summary.eligibleTokens - a.summary.eligibleTokens)
      .map((row) => row.key);
    // A selection that falls out of scope stays listed, so the picker never misstates the board.
    if (effort.project !== "all" && !ranked.includes(effort.project)) ranked.push(effort.project);
    const shortOf = (id: string) => id.split("/").filter(Boolean).at(-1) ?? id;
    const counts = new Map<string, number>();
    for (const id of ranked) counts.set(shortOf(id), (counts.get(shortOf(id)) ?? 0) + 1);
    return ranked.map((id) => {
      const parts = id.split("/").filter(Boolean);
      const short = shortOf(id);
      return {
        id,
        label: (counts.get(short) ?? 0) > 1 ? parts.slice(-2).join("/") : short,
      };
    });
  }, [data.projects, effort.projectRows, effort.project]);
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
