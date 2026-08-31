import { expect, test } from "bun:test";
import {
  mergeEffortSummaries,
  mergeProjectSummaries,
  projectGroup,
} from "./project-grouping";
import type { DashboardData, EffortSummary, ProjectTrendRow } from "./types";

type ProjectSummary = DashboardData["projects"][number];

function day(date: string, tokens: number, cost: number, model = "claude-opus-5"): ProjectTrendRow {
  return {
    date,
    inputTokens: 0,
    outputTokens: tokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: tokens,
    totalCost: cost,
    modelsUsed: [model],
    modelBreakdowns: [
      { modelName: model, inputTokens: 0, outputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0, cost },
    ],
  };
}

function project(name: string, trend: ProjectTrendRow[], sessions = 1): ProjectSummary {
  return {
    name,
    tokens: trend.reduce((sum, d) => sum + d.totalTokens, 0),
    cost: trend.reduce((sum, d) => sum + d.totalCost, 0),
    sessions,
    models: trend[0]?.modelsUsed ?? [],
    trend,
  };
}

test("projectGroup detects dated automation run directories and strips run suffixes", () => {
  const run = projectGroup("/Users/luis/Documents/Codex/2026-08-26/safely-reclaim-storage-from-stale-codex");
  expect(run).toEqual({ key: "safely-reclaim-storage-from-stale-codex", label: "safely-reclaim-storage-from-stale-codex", automation: true });
  const rerun = projectGroup("/Users/luis/Documents/Codex/2026-08-26/safely-reclaim-storage-from-stale-codex-2");
  expect(rerun.key).toBe(run.key);
  expect(rerun.automation).toBe(true);
});

test("projectGroup keeps ordinary projects apart and merges same-name checkouts", () => {
  const a = projectGroup("/Users/luis/htdocs/multi-stop-route-comparison");
  const b = projectGroup("/Users/luis/ndimensional/multi-stop-route-comparison");
  expect(a.key).toBe(b.key);
  expect(a.automation).toBe(false);
  // Names that merely end in digits are untouched outside dated run dirs.
  expect(projectGroup("/Users/luis/htdocs/vue3").label).toBe("vue3");
  expect(projectGroup("/Users/luis/htdocs/02-ring").key).not.toBe(projectGroup("/Users/luis/htdocs/03-orrery").key);
});

test("mergeProjectSummaries collapses instances, sums totals, and merges trend days", () => {
  const merged = mergeProjectSummaries([
    project("/x/2026-08-26/nightly-task", [day("2026-08-26", 100, 1)]),
    project("/x/2026-08-27/nightly-task", [day("2026-08-27", 200, 2)]),
    project("/x/2026-08-27/nightly-task-2", [day("2026-08-27", 50, 0.5, "gpt-5.5")]),
    project("/y/app", [day("2026-08-27", 999, 9)]),
  ]);
  expect(merged).toHaveLength(2);
  const task = merged.find((p) => p.label === "nightly-task")!;
  expect(task.automation).toBe(true);
  // The name stays a real path (the largest member) for path-based consumers.
  expect(task.name).toBe("/x/2026-08-27/nightly-task");
  expect(task.tokens).toBe(350);
  expect(task.sessions).toBe(3);
  expect(task.memberIds).toHaveLength(3);
  expect(task.trend).toHaveLength(2);
  const aug27 = task.trend.find((d) => d.date === "2026-08-27")!;
  expect(aug27.totalTokens).toBe(250);
  expect(aug27.modelBreakdowns).toHaveLength(2);
  const app = merged.find((p) => p.name === "/y/app")!;
  expect(app.automation).toBe(false);
  expect(app.label).toBe("app");
  expect(app.memberIds).toEqual(["/y/app"]);
});

function effort(tokens: Record<string, number>, unknownTokens = 0): EffortSummary {
  const attributed = Object.values(tokens).reduce((sum, value) => sum + value, 0);
  return {
    observedObservations: Object.keys(tokens).length,
    unknownObservations: unknownTokens ? 1 : 0,
    observationCoverage: 1,
    eligibleTokens: attributed + unknownTokens,
    attributedTokens: attributed,
    unknownTokens,
    tokenCoverage: attributed / (attributed + unknownTokens || 1),
    coverageState: "complete",
    quality: "ok",
    dominant: Object.keys(tokens)[0] ?? null,
    dominantBasis: "tokens",
    mixed: Object.keys(tokens).length >= 2,
    levels: Object.entries(tokens).map(([level, value]) => ({
      effort: level,
      observations: 1,
      tokens: value,
      tokenShare: attributed ? value / attributed : null,
    })),
    reconciliationDeltaTokens: 0,
  };
}

test("mergeEffortSummaries adds counts and recomputes dominance and mixedness", () => {
  const merged = mergeEffortSummaries([
    effort({ high: 100 }),
    effort({ medium: 300 }),
  ])!;
  expect(merged.attributedTokens).toBe(400);
  expect(merged.dominant).toBe("medium");
  expect(merged.mixed).toBe(true);
  expect(merged.levels.find((l) => l.effort === "medium")?.tokenShare).toBe(0.75);
});

test("mergeEffortSummaries passes single members through untouched", () => {
  const single = effort({ high: 10 });
  expect(mergeEffortSummaries([single])).toBe(single);
  expect(mergeEffortSummaries([])).toBeNull();
});
