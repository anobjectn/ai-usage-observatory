import { join } from "node:path";
import { blocksReportSchema, unifiedReportSchema, type UnifiedReport, type UsageRow } from "./schema";

const binary = join(process.cwd(), "node_modules", ".bin", "ccusage");

async function invoke(args: string[]) {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `ccusage exited with ${code}`);
  return JSON.parse(stdout);
}

export async function ccusageVersion() {
  const child = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
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

/** The two invocations the collector depends on. Exported so the upstream audit compares a
 * candidate release with exactly these flags, never with a copy that can drift. */
export const unifiedArgs = (timeZone: string) => ["daily", "--sections", "daily,weekly,monthly,session", "--by-agent", "--timezone", timeZone, "--json"];
export const blocksArgs = (timeZone: string) => ["blocks", "--recent", "--timezone", timeZone, "--json"];

export async function collectCcusage(timeZone: string) {
  const [unified, blocks, version] = await Promise.all([
    invoke(unifiedArgs(timeZone)).then((value) => unifiedReportSchema.parse(value)),
    invoke(blocksArgs(timeZone)).then((value) => blocksReportSchema.parse(value)),
    ccusageVersion(),
  ]);
  return { unified, blocks, version, unpricedModels: findUnpricedModels(unified) };
}
