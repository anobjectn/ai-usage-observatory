import type { AgentSelection } from "./agent-filter";
import { dateRangeLabel, type DateRange, type MetricRange } from "./time-range";

export type { MetricRange } from "./time-range";

const agentLabel = (entry: AgentSelection[number]) =>
  entry.replace(/^agent:/, "").replace(/^model:/, "");

export function filterEmptyMessage(
  selection: AgentSelection,
  range: MetricRange,
  pathTag: string,
  customRange: DateRange | null = null,
): string {
  const dimensions: string[] = [];
  if (selection.length > 0) {
    dimensions.push(`Agent: ${selection.map(agentLabel).join(" + ")}`);
  }
  if (range !== "all") {
    dimensions.push(
      `Range: ${range === "custom" ? dateRangeLabel(customRange) : range === "1" ? "1 day" : `${range} days`}`,
    );
  }
  if (pathTag !== "all") dimensions.push(`Path: ${pathTag}`);
  return dimensions.length > 0
    ? `No data matches ${dimensions.join(" · ")}.`
    : "No data is available for this widget.";
}
