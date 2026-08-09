import { SlidersHorizontal } from "lucide-react";
import { Segmented } from "../chrome";
import type { DataFacets, Insights } from "./insights";
import { effortLabel } from "../../components/effort";
import { dateRangeLabel, type DateRange } from "../../time-range";

export function FacetBar({
  facets,
  onChange,
  insights,
  agentSummary,
  days,
  dateRange,
  pathTag,
  showCache,
}: {
  facets: DataFacets;
  onChange: (next: Partial<DataFacets>) => void;
  insights: Insights;
  /** Read-only echo of the global Agent filter, so this row still states its full scope without
   * offering a second control that could disagree with the one in the topbar. */
  agentSummary: string;
  days: string;
  dateRange: DateRange | null;
  pathTag: string;
  showCache: boolean;
}) {
  const { sessionsInScope, sessionsShown, outlierCount, effortLevels } = insights.facets;
  const scopeParts = [
    `${days === "all" ? "all history" : days === "custom" ? dateRangeLabel(dateRange) : `${days} days`}`,
    agentSummary,
    pathTag === "all" ? "all path tags" : pathTag,
    showCache ? "cache included" : "cache excluded",
  ];
  return (
    <section className="data-facets" aria-label="Session analysis facets">
      <div className="data-facets__lead">
        <SlidersHorizontal />
        <div>
          <b>{sessionsShown.toLocaleString()}</b> of {sessionsInScope.toLocaleString()} sessions
          <small>{scopeParts.join(" · ")}</small>
        </div>
      </div>
      <div className="data-facets__controls">
        <label>
          <span>Session type</span>
          <Segmented
            label="Session type"
            value={facets.outliers}
            onChange={(value) => onChange({ outliers: value as DataFacets["outliers"] })}
            options={[
              { value: "all", label: "All" },
              { value: "typical", label: "Typical" },
              { value: "only", label: `Outliers (${outlierCount})` },
            ]}
          />
        </label>
        <label>
          <span>Effort</span>
          <select value={facets.effort} onChange={(event) => onChange({ effort: event.target.value })}>
            <option value="all">All effort</option>
            {effortLevels.map((effort) => (
              <option key={effort} value={`value:${effort}`}>{effortLabel(effort)}</option>
            ))}
            <option value="mixed">Mixed</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      </div>
    </section>
  );
}
