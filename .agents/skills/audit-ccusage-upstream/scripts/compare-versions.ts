#!/usr/bin/env bun
/** Run the pinned ccusage and a candidate release over the same local transcripts, with the exact
 * flags the collector uses, and report what changes: JSON shape, Zod validity, cost and token
 * totals by agent, model, and month, session identity, agent labels, and unpriced models.
 *
 * Writes a `data_impact` object for evidence.json. It holds totals and labels only, never session
 * content. The candidate runs through `bunx` from a temporary directory, so the project's
 * dependencies, lockfile, and database are not touched. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { blocksArgs, findUnpricedModels, unifiedArgs } from "../../../../server/ccusage";
import { blocksReportSchema, unifiedReportSchema, type UnifiedReport } from "../../../../server/schema";
import { providerFromAgent } from "../../../../src/provider";
import { systemTimeZone } from "../../../../src/reporting-time";

const repository = resolve(import.meta.dir, "../../../..");
/** Deltas below these are rounding noise from live pricing, not a behavior change. */
const COST_NOISE = 0.01;

type Json = Record<string, unknown>;
type Totals = { cost: number; tokens: number };

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}: ${stderr.trim().slice(-400)}`);
  return stdout;
}

/** Key-and-type paths of a JSON value. Dynamic keys (dates, paths) collapse to `*`; metadata keys
 * are kept because the collector reads some of them by name. */
function shape(value: unknown, path = "", out = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((item) => shape(item, `${path}[]`, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const dynamic = !path.endsWith("metadata") && (/^\d/.test(key) || key.includes("/"));
      shape(item, `${path}.${dynamic ? "*" : key}`, out);
    }
  } else out.add(`${path}:${value === null ? "null" : typeof value}`);
  return out;
}

const difference = (left: Set<string>, right: Set<string>) => [...left].filter((item) => !right.has(item)).sort();

function fold(report: UnifiedReport, key: (period: string, agent: string, model: string) => string) {
  const totals = new Map<string, Totals>();
  for (const row of report.monthly) {
    for (const agent of row.agents ?? []) {
      for (const model of agent.modelBreakdowns) {
        const entry = totals.get(key(row.period, agent.agent, model.modelName)) ?? { cost: 0, tokens: 0 };
        entry.cost += model.cost;
        entry.tokens += model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
        totals.set(key(row.period, agent.agent, model.modelName), entry);
      }
    }
  }
  return totals;
}

function deltas(pinned: Map<string, Totals>, candidate: Map<string, Totals>) {
  return [...new Set([...pinned.keys(), ...candidate.keys()])].sort().map((key) => {
    const before = pinned.get(key) ?? { cost: 0, tokens: 0 };
    const after = candidate.get(key) ?? { cost: 0, tokens: 0 };
    return {
      key,
      pinned_cost: Number(before.cost.toFixed(2)),
      candidate_cost: Number(after.cost.toFixed(2)),
      cost_delta: Number((after.cost - before.cost).toFixed(2)),
      pinned_tokens: before.tokens,
      candidate_tokens: after.tokens,
      token_delta: after.tokens - before.tokens,
    };
  });
}

const changed = (rows: ReturnType<typeof deltas>) => rows.filter((row) => Math.abs(row.cost_delta) >= COST_NOISE || row.token_delta !== 0);

function validity(schema: { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown) {
  const result = schema.safeParse(value);
  return result.success ? "ok" : result.error!.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

async function main() {
  const [candidate, outputPath, ...extra] = process.argv.slice(2);
  if (!candidate || !/^\d+\.\d+\.\d+$/.test(candidate) || extra.length > 0) {
    throw new Error("Usage: bun run compare-versions.ts <candidate-version> [data-impact.json]");
  }
  const timeZone = systemTimeZone();
  const pinnedBinary = join(repository, "node_modules", ".bin", "ccusage");
  const scratch = await mkdtemp(join(tmpdir(), "ccusage-compare-"));
  try {
    const pinnedVersion = (await run([pinnedBinary, "--version"], scratch)).trim().replace(/^ccusage\s+/, "");
    const candidateCommand = ["bunx", `ccusage@${candidate}`];
    // Sequential on purpose: both versions read every transcript, and a session that is being
    // written right now would otherwise differ between the runs for reasons unrelated to ccusage.
    const pinnedUnified = JSON.parse(await run([pinnedBinary, ...unifiedArgs(timeZone)], scratch)) as Json;
    const candidateUnified = JSON.parse(await run([...candidateCommand, ...unifiedArgs(timeZone)], scratch)) as Json;
    const pinnedBlocks = JSON.parse(await run([pinnedBinary, ...blocksArgs(timeZone)], scratch)) as Json;
    const candidateBlocks = JSON.parse(await run([...candidateCommand, ...blocksArgs(timeZone)], scratch)) as Json;

    const contract = {
      unified: {
        pinned_zod: validity(unifiedReportSchema, pinnedUnified),
        candidate_zod: validity(unifiedReportSchema, candidateUnified),
        keys_removed: difference(shape(pinnedUnified), shape(candidateUnified)),
        keys_added: difference(shape(candidateUnified), shape(pinnedUnified)),
      },
      blocks: {
        pinned_zod: validity(blocksReportSchema, pinnedBlocks),
        candidate_zod: validity(blocksReportSchema, candidateBlocks),
        keys_removed: difference(shape(pinnedBlocks), shape(candidateBlocks)),
        keys_added: difference(shape(candidateBlocks), shape(pinnedBlocks)),
      },
    };

    const impact: Json = {
      pinned: pinnedVersion,
      candidate,
      time_zone: timeZone,
      compared_at: new Date().toISOString(),
      contract,
    };

    if (contract.unified.pinned_zod === "ok" && contract.unified.candidate_zod === "ok") {
      const before = unifiedReportSchema.parse(pinnedUnified);
      const after = unifiedReportSchema.parse(candidateUnified);
      const sessionKeys = (report: UnifiedReport) => new Set(report.session.map((row) => `${row.agent}:${row.period}`));
      const agents = (report: UnifiedReport) => new Set(report.monthly.flatMap((row) => (row.agents ?? []).map((agent) => agent.agent)));
      const newAgents = difference(agents(after), agents(before));
      Object.assign(impact, {
        totals: {
          pinned_cost: Number(before.totals.totalCost.toFixed(2)),
          candidate_cost: Number(after.totals.totalCost.toFixed(2)),
          pinned_tokens: before.totals.totalTokens,
          candidate_tokens: after.totals.totalTokens,
        },
        by_agent: changed(deltas(fold(before, (_, agent) => agent), fold(after, (_, agent) => agent))),
        by_model: changed(deltas(fold(before, (_, agent, model) => `${agent}/${model}`), fold(after, (_, agent, model) => `${agent}/${model}`))),
        by_month: changed(deltas(fold(before, (period) => period), fold(after, (period) => period))),
        sessions: {
          pinned: before.session.length,
          candidate: after.session.length,
          removed: difference(sessionKeys(before), sessionKeys(after)).length,
          added: difference(sessionKeys(after), sessionKeys(before)).length,
        },
        agents_added: newAgents.map((agent) => ({ agent, provider: providerFromAgent(agent) ?? "unknown" })),
        agents_removed: difference(agents(before), agents(after)),
        unpriced_models: { pinned: findUnpricedModels(before), candidate: findUnpricedModels(after) },
      });
    }

    const output = `${JSON.stringify(impact, null, 2)}\n`;
    if (outputPath) {
      await Bun.write(outputPath, output);
      console.log(`Wrote ${outputPath}`);
    } else {
      console.log(output);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
