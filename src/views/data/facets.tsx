import { SlidersHorizontal } from "lucide-react";
import { Segmented } from "../chrome";
import type { DataFacets, Insights } from "./insights";
import { effortLabel } from "../../components/effort";

export function FacetBar({
  facets,
  onChange,
  insights,
  provider,
  days,
  pathTag,
  showCache,
}: {
  facets: DataFacets;
  onChange: (next: Partial<DataFacets>) => void;
  insights: Insights;
  provider: string;
  days: string;
  pathTag: string;
  showCache: boolean;
}) {
  const { sessionsInScope, sessionsShown, modelFamilies, outlierCount, effortLevels } = insights.facets;
  const scopeParts = [
    `${days === "all" ? "all history" : `${days} days`}`,
    provider === "all" ? "both providers" : provider,
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
          <span>Model family</span>
          <select value={facets.modelFamily} onChange={(event) => onChange({ modelFamily: event.target.value })}>
            <option value="all">All families</option>
            {modelFamilies.map((family) => (
              <option key={family} value={family}>{family}</option>
            ))}
          </select>
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
        <label>
          <span>Finding</span>
          <select value={facets.finding} onChange={(event) => onChange({ finding: event.target.value })}>
            <option value="all">All findings</option>
            {insights.efficiency.rules.map((rule) => (
              <option key={rule.id} value={rule.id} disabled={rule.count === 0}>
                {rule.label} ({rule.count})
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
