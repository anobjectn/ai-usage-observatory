import type { AgentEntry, AgentSelection } from "./agent-filter";
import { validDateRange, type DateRange, type MetricRange } from "./time-range";

/** The global selections a bookmark must reproduce. View, session, and model keep their own
 * parameters; these keys ride along beside them. */
export type UrlFilters = {
  range: MetricRange;
  customRange: DateRange | null;
  agent: AgentSelection;
  pathTag: string;
  showCache: boolean;
};

export const defaultUrlFilters: UrlFilters = {
  range: "30",
  customRange: null,
  agent: [],
  pathTag: "all",
  showCache: true,
};

const filterKeys = ["range", "from", "to", "agent", "path", "cache"] as const;
const presetRanges = new Set<string>(["1", "3", "7", "14", "30", "120", "all"]);
const isAgentEntry = (value: string): value is AgentEntry =>
  /^(agent|model):.+/.test(value);

/** Unknown or malformed values fall back to the default, so a hand-edited URL never breaks the app. */
export function parseUrlFilters(search: string | URLSearchParams): UrlFilters {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const range = params.get("range");
  const custom = { from: params.get("from") ?? "", to: params.get("to") ?? "" };
  const customValid = range === "custom" && validDateRange(custom);
  return {
    range: customValid
      ? "custom"
      : range && presetRanges.has(range)
        ? (range as MetricRange)
        : defaultUrlFilters.range,
    customRange: customValid ? custom : null,
    agent: [...new Set(params.getAll("agent").filter(isAgentEntry))],
    pathTag: params.get("path") || defaultUrlFilters.pathTag,
    showCache: params.get("cache") !== "0",
  };
}

/** Replaces the filter keys in `params`. A default value writes nothing, so the plain URL stays
 * the default analysis. */
export function writeUrlFilters(params: URLSearchParams, filters: UrlFilters) {
  for (const key of filterKeys) params.delete(key);
  if (filters.range === "custom" && validDateRange(filters.customRange)) {
    params.set("range", "custom");
    params.set("from", filters.customRange.from);
    params.set("to", filters.customRange.to);
  } else if (filters.range !== "custom" && filters.range !== defaultUrlFilters.range) {
    params.set("range", filters.range);
  }
  for (const entry of filters.agent) params.append("agent", entry);
  if (filters.pathTag !== defaultUrlFilters.pathTag) params.set("path", filters.pathTag);
  if (!filters.showCache) params.set("cache", "0");
}

/** Copies only the filter keys, for links that rebuild the rest of the query string. */
export function carryUrlFilters(from: URLSearchParams, to: URLSearchParams) {
  writeUrlFilters(to, parseUrlFilters(from));
}
