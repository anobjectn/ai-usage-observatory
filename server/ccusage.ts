import { join } from "node:path";
import { providerFromAgent } from "../src/provider";
import { antigravityCcusageDataDir } from "./antigravity";
import { blocksReportSchema, unifiedReportSchema, type UnifiedReport, type UsageRow } from "./schema";
import { runCommand } from "./subprocess";

const binary = join(process.cwd(), "node_modules", ".bin", "ccusage");

/** ccusage finds Antigravity's IDE and CLI directories by itself, but not T3 Code's driver
 * directory. `ANTIGRAVITY_DATA_DIR` replaces its search, so it carries every root. */
export function ccusageEnvironment(base: Record<string, string | undefined> = process.env) {
  const antigravity = antigravityCcusageDataDir();
  return antigravity === undefined ? { ...base } : { ...base, ANTIGRAVITY_DATA_DIR: antigravity };
}

async function invoke(args: string[]) {
  return JSON.parse(await runCommand([binary, ...args], { env: ccusageEnvironment() }));
}

export async function ccusageVersion() {
  const output = await runCommand([binary, "--version"]);
  return output.trim().replace(/^ccusage\s+/, "");
}

/**
 * ccusage prices a model it has no rate card for at exactly 0 rather than erroring, so a model
 * missing from the pricing data is indistinguishable from a free one by cost alone. It does this
 * silently in two situations: `--offline` (the bundled table lags new model releases) and a failed
 * live pricing fetch (it falls back to that same bundled table and still exits 0). Either way the
 * dashboard would rank a heavily-used model as free and understate every total containing it.
 *
 * Any real rate card produces a non-zero float for non-zero tokens, so tokens-without-cost is a
 * reliable signal that the price is missing rather than genuinely zero.
 *
 * ccusage 20.0.21 and later also report the fact themselves: `missingPricing` on a model
 * breakdown and `totals.unpricedModels`. Both are read, and the inference stays. The native flag
 * catches a model that is only partly priced, whose stored costs keep its total above zero. The
 * inference covers an older binary, and the weekly, monthly, and session sections, which
 * `totals.unpricedModels` does not describe (it covers the invoked section only).
 */
export function findUnpricedModels(unified: UnifiedReport) {
  const unpriced = new Set<string>();
  const scan = (rows: UsageRow[]) => {
    for (const row of rows) {
      for (const source of [row, ...(row.agents ?? [])]) {
        for (const model of source.modelBreakdowns) {
          const tokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
          if (model.missingPricing || (tokens > 0 && model.cost === 0)) unpriced.add(model.modelName);
        }
      }
    }
  };
  scan(unified.daily);
  scan(unified.weekly);
  scan(unified.monthly);
  scan(unified.session);
  for (const model of unified.totals.unpricedModels ?? []) unpriced.add(model);
  return [...unpriced].sort();
}

type TokenRow = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number };
type TokenModel = UsageRow["modelBreakdowns"][number];

function bucketSum(row: Omit<TokenRow, "totalTokens">) {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
}

/** Splits `gap` over the models by their output tokens, in whole tokens that sum to it exactly.
 * A one-model row (every Antigravity row observed so far) takes the whole gap. */
function allocate(models: TokenModel[], gap: number) {
  if (!models.length) return [];
  const weights = models.map((model) => model.outputTokens);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = models.map((_, index) => total > 0 ? gap * weights[index]! / total : index === 0 ? gap : 0);
  const whole = shares.map(Math.floor);
  let rest = gap - whole.reduce((sum, value) => sum + value, 0);
  const order = shares.map((share, index) => ({ index, fraction: share - whole[index]! })).sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) {
    if (rest <= 0) break;
    whole[index]! += 1;
    rest--;
  }
  return models.map((model, index) => ({ modelName: model.modelName, tokens: whole[index]! }));
}

/**
 * ccusage counts Antigravity's thinking tokens in `totalTokens` but leaves them out of
 * `outputTokens`, so an Antigravity row's four buckets fall short of its total by exactly the
 * thinking. Every other agent's buckets add up to its total.
 *
 * The gap is folded into output. That is what Codex already reports (OpenAI counts reasoning
 * inside output tokens) and what ccusage already prices (thinking at the output rate), so after
 * this every row, agent sub-row, session, model breakdown, and the totals add up to their
 * `totalTokens`, and "output" means generated output including reasoning for every provider. The
 * thinking itself stays visible through the metadata reader's reasoning count, as Codex's does.
 *
 * ccusage gives model breakdowns no total of their own, so a row that ran several models has its
 * gap split by each model's output tokens. That split is an estimate; the row totals are exact.
 */
export function foldAntigravityThinking(unified: UnifiedReport) {
  const isAntigravity = (agent: string) => providerFromAgent(agent) === "antigravity";
  const fold = (row: TokenRow & { modelBreakdowns: TokenModel[] }) => {
    const gap = row.totalTokens - bucketSum(row);
    if (gap <= 0) return [];
    row.outputTokens += gap;
    const added = allocate(row.modelBreakdowns, gap);
    added.forEach(({ tokens }, index) => { row.modelBreakdowns[index]!.outputTokens += tokens; });
    return added;
  };
  let daily = 0;
  for (const [section, rows] of [["daily", unified.daily], ["weekly", unified.weekly], ["monthly", unified.monthly], ["session", unified.session]] as const) {
    for (const row of rows) {
      if (row.agents?.length) {
        for (const agent of row.agents) {
          if (!isAntigravity(agent.agent)) continue;
          const before = agent.outputTokens;
          const added = fold(agent);
          const gap = agent.outputTokens - before;
          if (!gap) continue;
          row.outputTokens += gap;
          if (section === "daily") daily += gap;
          for (const { modelName, tokens } of added) {
            const model = row.modelBreakdowns.find((entry) => entry.modelName === modelName);
            if (model) model.outputTokens += tokens;
          }
        }
      } else if (isAntigravity(row.agent)) {
        const before = row.outputTokens;
        fold(row);
        if (section === "daily") daily += row.outputTokens - before;
      }
    }
  }
  // `totals` describes the daily section, so it takes the daily rows' thinking.
  unified.totals.outputTokens += daily;
  return unified;
}

/** The two invocations the collector depends on. Exported so the upstream audit compares a
 * candidate release with exactly these flags, never with a copy that can drift. */
export const unifiedArgs = (timeZone: string) => ["daily", "--sections", "daily,weekly,monthly,session", "--by-agent", "--timezone", timeZone, "--json"];
export const blocksArgs = (timeZone: string) => ["blocks", "--recent", "--timezone", timeZone, "--json"];

export async function collectCcusage(timeZone: string) {
  const [unified, blocks, version] = await Promise.all([
    invoke(unifiedArgs(timeZone)).then((value) => foldAntigravityThinking(unifiedReportSchema.parse(value))),
    invoke(blocksArgs(timeZone)).then((value) => blocksReportSchema.parse(value)),
    ccusageVersion(),
  ]);
  return { unified, blocks, version, unpricedModels: findUnpricedModels(unified) };
}
