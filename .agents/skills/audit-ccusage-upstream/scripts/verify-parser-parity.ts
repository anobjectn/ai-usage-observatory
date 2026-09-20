#!/usr/bin/env bun
/** Check that the effort parser counts the same tokens as ccusage, month by month.
 *
 * `server/effort-parse.ts` and `server/codex-replay.ts` re-implement ccusage's usage rules. The
 * test suite runs on fixtures, so it stays green when upstream changes a rule; only a run over
 * real transcripts shows the drift. The effort views suppress every day where the parser counts
 * more than ccusage, so a Codex delta above zero is a regression the upgrade would ship.
 *
 * The parser runs against a throwaway database: `USAGE_OBSERVATORY_DB` is set before the store is
 * imported, so the application database is never opened. */

import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unifiedArgs } from "../../../../server/ccusage";
import { unifiedReportSchema } from "../../../../server/schema";
import { systemTimeZone } from "../../../../src/reporting-time";

const repository = resolve(import.meta.dir, "../../../..");
const scratch = await mkdtemp(join(tmpdir(), "ccusage-parity-"));
process.env.USAGE_OBSERVATORY_DB = join(scratch, "parity.db");

type Agent = "claude" | "codex";
const globs: Array<[Agent, string]> = [
  ["claude", ".claude/projects/**/*.jsonl"],
  ["codex", ".codex/sessions/**/*.jsonl"],
  ["codex", ".codex/archived_sessions/**/*.jsonl"],
];

async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: scratch, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}: ${stderr.trim().slice(-400)}`);
  return stdout;
}

async function main() {
  // A leading argument that is not a version is the output path, so the pinned binary can be
  // checked without naming its version.
  const args = process.argv.slice(2);
  const version = /^\d+\.\d+\.\d+$/.test(args[0] ?? "") ? args.shift() : undefined;
  const [outputPath, ...extra] = args;
  if (extra.length > 0 || outputPath?.startsWith("-")) {
    throw new Error("Usage: bun run verify-parser-parity.ts [ccusage-version] [parity.json]\nWithout a version, the pinned binary is the reference.");
  }
  const timeZone = systemTimeZone();
  const reference = version ? ["bunx", `ccusage@${version}`] : [join(repository, "node_modules", ".bin", "ccusage")];

  // Imported only now, after the database path points at the scratch directory.
  const { db } = await import("../../../../server/store");
  const { parseHead } = await import("../../../../server/path-indexer");
  const { PARSER_VERSION, consumeEffortLine, createAccumulator, emptyState } = await import("../../../../server/effort-parse");
  const { planCodexReplay } = await import("../../../../server/codex-replay");

  const sources: Array<{ agent: Agent; file: string }> = [];
  for (const [agent, pattern] of globs) {
    for await (const relative of new Bun.Glob(pattern).scan({ cwd: homedir(), absolute: false, onlyFiles: true, dot: true })) {
      sources.push({ agent, file: join(homedir(), relative) });
    }
  }
  sources.sort((left, right) => left.file.localeCompare(right.file));

  // The fork lookup in codex-replay reads the path index, so the scratch database needs one row
  // per Codex rollout, keyed the way the real indexer keys it.
  const insert = db.query("INSERT OR REPLACE INTO session_paths (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size) VALUES (?, 'codex', ?, ?, NULL, 0, 0)");
  for (const source of sources) {
    if (source.agent !== "codex") continue;
    insert.run(source.file, (await parseHead(source.file, "codex")).nativeKey, source.file);
  }

  const parsed: Record<Agent, Map<string, number>> = { claude: new Map(), codex: new Map() };
  const quality = { files: sources.length, forks: 0, parseErrors: 0, contextGaps: 0, skippedBytes: 0 };
  for (const source of sources) {
    const accumulator = createAccumulator();
    const state = emptyState();
    if (source.agent === "codex") {
      state.codexReplayPlan = await planCodexReplay(source.file);
      if (state.codexReplayPlan) {
        state.codexReplay = { phase: "matching", index: 0 };
        quality.forks++;
      }
    }
    // Whole-file reads keep this simple; the indexer's chunking and resume logic has its own tests.
    for (const line of (await Bun.file(source.file).text()).split("\n")) consumeEffortLine(line, source.agent, accumulator, state);
    quality.parseErrors += accumulator.parseErrors;
    quality.contextGaps += accumulator.contextGaps;
    quality.skippedBytes += accumulator.skippedBytes;
    for (const row of accumulator.rows.values()) {
      const month = row.occurredOn.slice(0, 7);
      parsed[source.agent].set(month, (parsed[source.agent].get(month) ?? 0) + row.totalTokens);
    }
  }

  const referenceVersion = (await run([...reference, "--version"])).trim().replace(/^ccusage\s+/, "");
  const report = unifiedReportSchema.parse(JSON.parse(await run([...reference, ...unifiedArgs(timeZone)])));
  const counted: Record<Agent, Map<string, number>> = { claude: new Map(), codex: new Map() };
  for (const row of report.monthly) {
    for (const agent of row.agents ?? []) {
      if (agent.agent === "claude" || agent.agent === "codex") counted[agent.agent].set(row.period, agent.totalTokens);
    }
  }

  const months = (agent: Agent) => [...new Set([...parsed[agent].keys(), ...counted[agent].keys()])].filter(Boolean).sort().map((month) => {
    const parser = parsed[agent].get(month) ?? 0;
    const ccusage = counted[agent].get(month) ?? 0;
    return { month, ccusage_tokens: ccusage, parser_tokens: parser, delta: parser - ccusage };
  });
  const result = {
    reference: referenceVersion,
    parser_version: PARSER_VERSION,
    time_zone: timeZone,
    checked_at: new Date().toISOString(),
    quality,
    codex: { exact: months("codex").every((row) => row.delta === 0), months: months("codex") },
    claude: { exact: months("claude").every((row) => row.delta === 0), months: months("claude") },
  };

  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await Bun.write(outputPath, output);
  for (const agent of ["codex", "claude"] as const) {
    console.log(`${agent}: ${result[agent].exact ? "exact" : "DIFFERS"} against ccusage ${referenceVersion}`);
    for (const row of result[agent].months) if (row.delta !== 0) console.log(`  ${row.month}  ccusage ${row.ccusage_tokens}  parser ${row.parser_tokens}  delta ${row.delta > 0 ? "+" : ""}${row.delta}`);
  }
  console.log(JSON.stringify(quality));
  if (outputPath) console.log(`Wrote ${outputPath}`);
}

try {
  await main();
} finally {
  await rm(scratch, { recursive: true, force: true });
}
