import type { DashboardData, ModelBreakdown } from "./types";

export type AggregatedModel = DashboardData["models"][number];

type ModelAggregateRow = {
  agent: string;
  modelBreakdowns: ModelBreakdown[];
  agents?: Array<{ agent: string; modelBreakdowns: ModelBreakdown[] }>;
};

const modelTokens = (model: ModelBreakdown) =>
  model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;

/** Aggregates authoritative daily model breakdowns for any already-selected calendar interval. */
export function aggregateModels(rows: ModelAggregateRow[], unpricedModels: string[] = []): AggregatedModel[] {
  const unpriced = new Set(unpricedModels);
  const models = new Map<string, AggregatedModel & { agents: string[] }>();
  for (const row of rows) {
    for (const agent of row.agents ?? [row]) {
      const isWarp = agent.agent.toLowerCase().includes("warp");
      for (const entry of agent.modelBreakdowns) {
        const current = models.get(entry.modelName) ?? {
          model: entry.modelName,
          tokens: 0,
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          agents: [],
          priced: !isWarp && !unpriced.has(entry.modelName),
        };
        // A model can appear in both Warp and ccusage. Only a ccusage-priced observation makes
        // the API-equivalent cost card meaningful; Warp's provider credits never become dollars.
        if (!isWarp && !unpriced.has(entry.modelName)) current.priced = true;
        current.tokens += modelTokens(entry);
        current.cost += entry.cost;
        current.inputTokens += entry.inputTokens;
        current.outputTokens += entry.outputTokens;
        current.cacheReadTokens += entry.cacheReadTokens;
        current.cacheCreationTokens += entry.cacheCreationTokens;
        if (!current.agents.includes(agent.agent)) current.agents.push(agent.agent);
        models.set(entry.modelName, current);
      }
    }
  }
  return [...models.values()].sort(
    (left, right) =>
      Number(left.priced) - Number(right.priced) ||
      right.cost - left.cost ||
      right.tokens - left.tokens,
  );
}
