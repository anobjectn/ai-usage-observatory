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

const measureValue = (model: SlopeInputModel, measure: SlopeMeasure) =>
  measure === "tokens" ? model.tokens : measure === "cost" ? model.cost : model.output;

/** The slope chart's data: the top `limit` models by tokens, each carrying its
 * rank and share on every measure so a line can connect its standings. Ranks
 * are computed within the shown set — the chart compares the models it draws,
 * not ghosts it dropped. */
export function modelSignalSlopes<T extends SlopeInputModel>(
  models: T[],
  limit = 8,
): SlopeModel<T>[] {
  const shown = [...models]
    .sort((a, b) => b.tokens - a.tokens)
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
      (a, b) => measureValue(b, measure) - measureValue(a, measure),
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
