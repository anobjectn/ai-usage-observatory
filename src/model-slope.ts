export type SlopeMeasure = "tokens" | "cost" | "output";

export type SlopeInputModel = {
  rawName: string;
  name: string;
  tokens: number;
  cost: number;
  output: number;
};

export type SlopeModel<T extends SlopeInputModel = SlopeInputModel> = T & {
  /** 1-based standing among the shown models, per measure. Ties keep input order. */
  ranks: Record<SlopeMeasure, number>;
  /** Share of the shown models' total per measure, 0–100. */
  shares: Record<SlopeMeasure, number>;
};

export const SLOPE_MEASURES: SlopeMeasure[] = ["tokens", "cost", "output"];

/** Column order of the slope chart, primary sort first. The primary picks the
 * shown models and their row order; each later measure breaks ties in the one
 * before it. Direction only flips how the chart is drawn, never the selection. */
export type SlopeSort = {
  order: SlopeMeasure[];
  direction: "asc" | "desc";
};

export const DEFAULT_SLOPE_SORT: SlopeSort = {
  order: ["tokens", "cost", "output"],
  direction: "desc",
};

/** Clicking a heading promotes it to primary and demotes the old primary to
 * the tie-break slot; clicking the primary again flips the direction. */
export function nextSlopeSort(current: SlopeSort, measure: SlopeMeasure): SlopeSort {
  if (current.order[0] === measure)
    return {
      order: current.order,
      direction: current.direction === "desc" ? "asc" : "desc",
    };
  return {
    order: [measure, ...current.order.filter((entry) => entry !== measure)],
    direction: "desc",
  };
}

const measureValue = (model: SlopeInputModel, measure: SlopeMeasure) =>
  measure === "tokens" ? model.tokens : measure === "cost" ? model.cost : model.output;

const compareBy =
  (measures: SlopeMeasure[]) =>
  (a: SlopeInputModel, b: SlopeInputModel) => {
    for (const measure of measures) {
      const difference = measureValue(b, measure) - measureValue(a, measure);
      if (difference !== 0) return difference;
    }
    return 0;
  };

/** The slope chart's data: the top `limit` models by the primary measure, each
 * carrying its rank and share on every measure so a line can connect its
 * standings. Ranks are computed within the shown set — the chart compares the
 * models it draws, not ghosts it dropped. Ties on any column fall back to the
 * remaining measures in `order`, so the primary's tie-break is the secondary. */
export function modelSignalSlopes<T extends SlopeInputModel>(
  models: T[],
  limit = 8,
  order: SlopeMeasure[] = DEFAULT_SLOPE_SORT.order,
): SlopeModel<T>[] {
  const measures = [
    ...order,
    ...SLOPE_MEASURES.filter((measure) => !order.includes(measure)),
  ];
  const shown = [...models]
    .sort(compareBy(measures))
    .slice(0, Math.max(0, limit));
  const totals = Object.fromEntries(
    SLOPE_MEASURES.map((measure) => [
      measure,
      shown.reduce((sum, model) => sum + measureValue(model, measure), 0),
    ]),
  ) as Record<SlopeMeasure, number>;
  // Keyed by entry identity: the same model name can appear once per agent
  // (e.g. via Codex and again via Warp) and each row ranks on its own.
  const rankLookup = new Map<T, Record<SlopeMeasure, number>>();
  for (const measure of SLOPE_MEASURES) {
    const ordered = [...shown].sort(
      compareBy([measure, ...measures.filter((entry) => entry !== measure)]),
    );
    ordered.forEach((model, index) => {
      const entry = rankLookup.get(model) ?? ({} as Record<SlopeMeasure, number>);
      entry[measure] = index + 1;
      rankLookup.set(model, entry);
    });
  }
  return shown.map((model) => ({
    ...model,
    ranks: rankLookup.get(model)!,
    shares: Object.fromEntries(
      SLOPE_MEASURES.map((measure) => [
        measure,
        totals[measure]
          ? (measureValue(model, measure) / totals[measure]) * 100
          : 0,
      ]),
    ) as Record<SlopeMeasure, number>,
  }));
}
