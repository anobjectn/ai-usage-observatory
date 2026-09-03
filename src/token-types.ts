import { providerFromAgent, type ActivityProvider } from "./provider";
import type { ModelBreakdown, ModelRate, RateCardSummary } from "./types";

/** The four API token types, in the order the table shows them. */
export type TokenType = "cacheRead" | "cacheWrite" | "output" | "input";
export const tokenTypeOrder: TokenType[] = ["cacheRead", "cacheWrite", "output", "input"];
export const tokenTypeLabels: Record<TokenType, string> = {
  cacheRead: "Cache reads",
  cacheWrite: "Cache writes",
  output: "Generated output",
  input: "Uncached input",
};

export type TokenTypeRow = {
  type: TokenType;
  label: string;
  tokens: number;
  /** 0–1 over the four displayed rows; null when the scope moved no tokens. */
  tokenShare: number | null;
  /** USD; null when cost is withheld for the scope. */
  cost: number | null;
  costShare: number | null;
};

export type ModelRowInput = { agent: string; breakdown: ModelBreakdown };

export type WithheldReason = "unpriced" | "no-rate" | "mismatch";

export type ModelDecomposition = {
  model: string;
  provider: ActivityProvider | null;
  tokens: Record<TokenType, number>;
  totalTokens: number;
  /** ccusage's own figure for this model row. */
  cost: number;
  /** Per-type split of `cost`; null when it did not reconcile. */
  costs: Record<TokenType, number> | null;
  reconciled: boolean;
  reason: WithheldReason | null;
  /** Share of cache-write tokens priced at the 1-hour rate, implied by the residual. Null when
   * the model has no 1-hour tier or wrote nothing. */
  impliedOneHourShare: number | null;
};

export type TokenTypeSummary = {
  rows: TokenTypeRow[];
  totalTokens: number;
  /** Sum of reconciled per-model costs; null when any contributor withheld. */
  totalCost: number | null;
  costAvailable: boolean;
  withheld: Array<{ model: string; reason: WithheldReason }>;
  /** Tokens from Warp rows, which carry no token-type detail and are left out of the rows. */
  warpTokensExcluded: number;
  /** Token-weighted across Anthropic rows with cache writes; null when none. */
  impliedOneHourShare: number | null;
  providers: ActivityProvider[];
  models: ModelDecomposition[];
};

/** Relative tolerance for "these four parts sum to ccusage's cost". Rounding inside ccusage
 * and the rate table stays far below this; a rate change or a pricing tier does not. */
const relativeTolerance = 0.005;
/** Absolute floor so a fraction-of-a-cent row is not failed on floating-point noise. */
const absoluteTolerance = 0.0005;

const tokensOf = (breakdown: ModelBreakdown): Record<TokenType, number> => ({
  cacheRead: breakdown.cacheReadTokens,
  cacheWrite: breakdown.cacheCreationTokens,
  output: breakdown.outputTokens,
  input: breakdown.inputTokens,
});

const sumTokens = (tokens: Record<TokenType, number>) => tokenTypeOrder.reduce((sum, type) => sum + tokens[type], 0);

/** Splits one ccusage model row's cost into the four types. Input, output, and cache-read cost
 * come from the rate card; cache-write cost is whatever ccusage's cost leaves over, which is the
 * only way to honour the 5-minute / 1-hour write mix ccusage priced without re-deriving it. The
 * residual must land where the rate card says a cache write can cost, or the row is withheld. */
export function decomposeModelRow(breakdown: ModelBreakdown, rate: ModelRate | null, unpriced: boolean, agent = ""): ModelDecomposition {
  const tokens = tokensOf(breakdown);
  const totalTokens = sumTokens(tokens);
  const base: Omit<ModelDecomposition, "costs" | "reconciled" | "reason" | "impliedOneHourShare"> = {
    model: breakdown.modelName,
    provider: providerFromAgent(agent),
    tokens,
    totalTokens,
    cost: breakdown.cost,
  };
  const withheld = (reason: WithheldReason): ModelDecomposition => ({ ...base, costs: null, reconciled: false, reason, impliedOneHourShare: null });
  if (totalTokens === 0) {
    const zero = { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 };
    return { ...base, costs: zero, reconciled: true, reason: null, impliedOneHourShare: null };
  }
  if (unpriced || breakdown.cost <= 0) return withheld("unpriced");
  if (!rate) return withheld("no-rate");

  const costs = {
    input: tokens.input * rate.input,
    output: tokens.output * rate.output,
    cacheRead: tokens.cacheRead * rate.cacheRead,
    cacheWrite: 0,
  };
  const residual = breakdown.cost - costs.input - costs.output - costs.cacheRead;
  const tolerance = Math.max(breakdown.cost * relativeTolerance, absoluteTolerance);
  const low = tokens.cacheWrite * rate.cacheWrite5m;
  const high = tokens.cacheWrite * (rate.cacheWrite1h ?? rate.cacheWrite5m);
  if (residual < low - tolerance || residual > high + tolerance) return withheld("mismatch");
  // With no write tokens the residual is floating-point dust, not a cost.
  costs.cacheWrite = tokens.cacheWrite === 0 ? 0 : Math.max(0, residual);

  let impliedOneHourShare: number | null = null;
  if (tokens.cacheWrite > 0 && rate.cacheWrite1h !== null && rate.cacheWrite1h !== rate.cacheWrite5m) {
    impliedOneHourShare = Math.min(1, Math.max(0, (residual - low) / (high - low)));
  }
  return { ...base, costs, reconciled: true, reason: null, impliedOneHourShare };
}

const emptyRows = (): TokenTypeRow[] =>
  tokenTypeOrder.map((type) => ({ type, label: tokenTypeLabels[type], tokens: 0, tokenShare: null, cost: null, costShare: null }));

/** Builds the table for any scope: one model over a date range, one session, or a whole project.
 * Tokens always sum. Cost sums only when every non-Warp contributor with traffic reconciled, so a
 * mixed-model project is a sum of validated per-model components and never a blended rate. */
export function summarizeTokenTypes(inputs: ModelRowInput[], rateCard: Pick<RateCardSummary, "models"> | null, unpricedModels: string[] = []): TokenTypeSummary {
  const unpriced = new Set(unpricedModels);
  const models: ModelDecomposition[] = [];
  const providers = new Set<ActivityProvider>();
  let warpTokensExcluded = 0;
  for (const { agent, breakdown } of inputs) {
    const provider = providerFromAgent(agent);
    if (provider === "warp") {
      warpTokensExcluded += sumTokens(tokensOf(breakdown));
      continue;
    }
    if (provider) providers.add(provider);
    const rate = rateCard?.models[breakdown.modelName] ?? null;
    models.push(decomposeModelRow(breakdown, rate, unpriced.has(breakdown.modelName), agent));
  }

  const tokens = { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 };
  const costs = { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 };
  const withheldByModel = new Map<string, WithheldReason>();
  let weightedShare = 0;
  let shareWeight = 0;
  for (const model of models) {
    for (const type of tokenTypeOrder) tokens[type] += model.tokens[type];
    if (model.totalTokens === 0) continue;
    if (model.costs) {
      for (const type of tokenTypeOrder) costs[type] += model.costs[type];
    } else if (model.reason && !withheldByModel.has(model.model)) {
      withheldByModel.set(model.model, model.reason);
    }
    if (model.impliedOneHourShare !== null) {
      weightedShare += model.impliedOneHourShare * model.tokens.cacheWrite;
      shareWeight += model.tokens.cacheWrite;
    }
  }
  const totalTokens = sumTokens(tokens);
  const costAvailable = withheldByModel.size === 0 && models.some((model) => model.totalTokens > 0);
  const totalCost = costAvailable ? tokenTypeOrder.reduce((sum, type) => sum + costs[type], 0) : null;
  const rows = totalTokens === 0
    ? emptyRows()
    : tokenTypeOrder.map((type) => ({
        type,
        label: tokenTypeLabels[type],
        tokens: tokens[type],
        tokenShare: tokens[type] / totalTokens,
        cost: costAvailable ? costs[type] : null,
        costShare: costAvailable && totalCost ? costs[type] / totalCost : null,
      }));
  return {
    rows,
    totalTokens,
    totalCost,
    costAvailable,
    withheld: [...withheldByModel].map(([model, reason]) => ({ model, reason })),
    warpTokensExcluded,
    impliedOneHourShare: shareWeight > 0 ? weightedShare / shareWeight : null,
    providers: [...providers],
    models,
  };
}

export type ReasoningEvidence = { outputTokens: number; reasoningOutputTokens: number; reportedEvents: number } | null;

export type FootnoteContext = {
  reasoning?: ReasoningEvidence;
  /** False when the optional effort index is off, so the reasoning line can say why. */
  effortIndexEnabled?: boolean;
  rateCard?: Pick<RateCardSummary, "status" | "fetchedAt"> | null;
};

const withheldReasonText: Record<WithheldReason, string> = {
  unpriced: "has no rate card in ccusage",
  "no-rate": "has no LiteLLM rate to split with",
  mismatch: "did not reconcile with its ccusage cost",
};

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Every line states evidence the scope actually carries; nothing is inferred from an absent
 * field. */
export function footnotesFor(summary: TokenTypeSummary, context: FootnoteContext = {}): string[] {
  const lines: string[] = [];
  const anthropicWrites = summary.models.some((model) => model.provider === "anthropic" && model.tokens.cacheWrite > 0);
  if (summary.costAvailable && anthropicWrites) {
    lines.push(
      summary.impliedOneHourShare === null
        ? "Cache-write cost is the ccusage residual after input, output, and cache-read rates."
        : `Cache-write cost is the ccusage residual after input, output, and cache-read rates; about ${percent(summary.impliedOneHourShare)} of write tokens were priced at the 1-hour rate.`,
    );
  }
  if (summary.providers.includes("codex")) lines.push("Codex reports cache writes as zero.");
  if (context.reasoning && context.reasoning.reportedEvents > 0) {
    lines.push(`Generated output includes reasoning tokens; Codex reported ${context.reasoning.reasoningOutputTokens.toLocaleString()} reasoning tokens inside output.`);
  } else if (context.effortIndexEnabled === false) {
    lines.push("Generated output includes reasoning tokens; no separate reasoning count is available while the effort index is off.");
  } else {
    lines.push("Generated output includes reasoning tokens; Claude does not report a separate count.");
  }
  lines.push("Cache reads count repeated reads, not unique text.");
  if (summary.withheld.length) {
    lines.push(`Cost withheld: ${summary.withheld.map((entry) => `${entry.model} ${withheldReasonText[entry.reason]}`).join("; ")}.`);
  }
  if (summary.warpTokensExcluded > 0) {
    lines.push(`${summary.warpTokensExcluded.toLocaleString()} Warp tokens excluded (no token-type detail).`);
  }
  if (summary.costAvailable && context.rateCard) {
    lines.push(
      context.rateCard.status === "fallback" || !context.rateCard.fetchedAt
        ? "Rates: bundled LiteLLM fallback."
        : `Rates: LiteLLM, fetched ${context.rateCard.fetchedAt.slice(0, 10)}.`,
    );
  }
  return lines;
}
