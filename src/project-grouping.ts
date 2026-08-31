import type { DashboardData, EffortSummary, ProjectTrendRow } from "./types";

type ProjectSummary = DashboardData["projects"][number];

export type ProjectGroupInfo = {
  /** Case-insensitive grouping key shared by every instance of the project. */
  key: string;
  /** Display name: the directory name, with an automation run's `-N` suffix stripped. */
  label: string;
  /** True when the instance lives under a `YYYY-MM-DD/` parent — the signature of
   * a scheduled agent writing itself a fresh dated working directory per run. */
  automation: boolean;
};

export type GroupedProjectSummary = ProjectSummary & {
  /** Clean display name; `name` stays a real path for path-based consumers. */
  label: string;
  /** The full project paths merged into this row. */
  memberIds: string[];
  automation: boolean;
};

/** Where an instance of a project belongs. Instances group by directory name, so
 * the same project checked out under two parents merges, and a scheduled task's
 * dated run directories (`2026-08-26/task`, `2026-08-26/task-2`) collapse into
 * one recurring row instead of one row per day. */
export function projectGroup(projectPath: string): ProjectGroupInfo {
  const clean = projectPath.replace(/\/+$/, "");
  const segments = clean.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? clean;
  const parent = segments[segments.length - 2] ?? "";
  const automation = /^\d{4}-\d{2}-\d{2}$/.test(parent);
  const label = automation ? base.replace(/-\d+$/, "") : base;
  return { key: label.toLowerCase(), label, automation };
}

function mergeTrends(trends: ProjectTrendRow[][]): ProjectTrendRow[] {
  const byDate = new Map<string, ProjectTrendRow>();
  for (const trend of trends) {
    for (const day of trend) {
      const current = byDate.get(day.date);
      if (!current) {
        byDate.set(day.date, {
          ...day,
          modelsUsed: [...day.modelsUsed],
          modelBreakdowns: day.modelBreakdowns.map((model) => ({ ...model })),
        });
        continue;
      }
      current.inputTokens += day.inputTokens;
      current.outputTokens += day.outputTokens;
      current.cacheReadTokens += day.cacheReadTokens;
      current.cacheCreationTokens += day.cacheCreationTokens;
      current.totalTokens += day.totalTokens;
      current.totalCost += day.totalCost;
      if (day.warpCredits) {
        current.warpCredits = (current.warpCredits ?? 0) + day.warpCredits;
      }
      for (const model of day.modelBreakdowns) {
        const existing = current.modelBreakdowns.find(
          (entry) => entry.modelName === model.modelName,
        );
        if (existing) {
          existing.inputTokens += model.inputTokens;
          existing.outputTokens += model.outputTokens;
          existing.cacheReadTokens += model.cacheReadTokens;
          existing.cacheCreationTokens += model.cacheCreationTokens;
          existing.cost += model.cost;
        } else {
          current.modelBreakdowns.push({ ...model });
        }
      }
      current.modelBreakdowns.sort(
        (a, b) =>
          b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens -
          (a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheCreationTokens),
      );
      current.modelsUsed = current.modelBreakdowns.map((model) => model.modelName);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Collapses per-path project summaries into per-project rows. Totals are sums,
 * trends merge day by day, and the model list is re-ranked from the merged
 * trend so it reflects the whole group rather than one member. */
export function mergeProjectSummaries(
  projects: ProjectSummary[],
): GroupedProjectSummary[] {
  const groups = new Map<string, { info: ProjectGroupInfo; members: ProjectSummary[] }>();
  for (const project of projects) {
    const info = projectGroup(project.name);
    const group = groups.get(info.key) ?? { info, members: [] };
    // Any automated member marks the group; a task run both by schedule and by
    // hand is still fundamentally the recurring task.
    if (info.automation) group.info = { ...group.info, automation: true };
    group.members.push(project);
    groups.set(info.key, group);
  }
  return [...groups.values()].map(({ info, members }) => {
    if (members.length === 1 && !info.automation) {
      return {
        ...members[0],
        label: info.label,
        memberIds: [members[0].name],
        automation: false,
      };
    }
    const trend = mergeTrends(members.map((member) => member.trend));
    const modelTotals = new Map<string, number>();
    for (const day of trend) {
      for (const model of day.modelBreakdowns) {
        modelTotals.set(
          model.modelName,
          (modelTotals.get(model.modelName) ?? 0) +
            model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens,
        );
      }
    }
    const warpCredits = members.reduce((sum, member) => sum + (member.warpCredits ?? 0), 0);
    const primary = members.reduce((largest, member) =>
      member.tokens > largest.tokens ? member : largest,
    );
    return {
      name: primary.name,
      label: info.label,
      tokens: members.reduce((sum, member) => sum + member.tokens, 0),
      cost: members.reduce((sum, member) => sum + member.cost, 0),
      sessions: members.reduce((sum, member) => sum + member.sessions, 0),
      warpCredits: warpCredits || undefined,
      models: [...modelTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([model]) => model),
      trend,
      memberIds: members.map((member) => member.name),
      automation: info.automation,
    };
  });
}

/** Arithmetic union of member effort summaries: counts add, coverages and
 * shares recompute, dominance follows tokens, and `mixed` keeps the server's
 * rule of two-or-more distinct recorded efforts. */
export function mergeEffortSummaries(
  summaries: EffortSummary[],
): EffortSummary | null {
  const present = summaries.filter(Boolean);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  const levels = new Map<string, { effort: string; observations: number; tokens: number }>();
  for (const summary of present) {
    for (const level of summary.levels) {
      const current = levels.get(level.effort) ?? { effort: level.effort, observations: 0, tokens: 0 };
      current.observations += level.observations;
      current.tokens += level.tokens;
      levels.set(level.effort, current);
    }
  }
  const observedObservations = present.reduce((sum, s) => sum + s.observedObservations, 0);
  const unknownObservations = present.reduce((sum, s) => sum + s.unknownObservations, 0);
  const eligibleTokens = present.reduce((sum, s) => sum + s.eligibleTokens, 0);
  const attributedTokens = present.reduce((sum, s) => sum + s.attributedTokens, 0);
  const unknownTokens = present.some((s) => s.unknownTokens === null)
    ? null
    : present.reduce((sum, s) => sum + (s.unknownTokens ?? 0), 0);
  const mergedLevels = [...levels.values()]
    .sort((a, b) => b.tokens - a.tokens || b.observations - a.observations)
    .map((level) => ({
      ...level,
      tokenShare: attributedTokens > 0 ? level.tokens / attributedTokens : null,
    }));
  const known = mergedLevels.filter((level) => level.effort !== "unknown");
  const qualityRank = { ok: 0, stale: 1, degraded: 2 } as const;
  const coverageRank = { unavailable: 0, partial: 1, complete: 2 } as const;
  return {
    observedObservations,
    unknownObservations,
    observationCoverage:
      observedObservations + unknownObservations > 0
        ? observedObservations / (observedObservations + unknownObservations)
        : null,
    eligibleTokens,
    attributedTokens,
    unknownTokens,
    tokenCoverage: eligibleTokens > 0 ? attributedTokens / eligibleTokens : null,
    coverageState: present
      .map((s) => s.coverageState)
      .reduce((worst, state) =>
        coverageRank[state] < coverageRank[worst] ? state : worst,
      ),
    quality: present
      .map((s) => s.quality)
      .reduce((worst, state) =>
        qualityRank[state] > qualityRank[worst] ? state : worst,
      ),
    dominant: known[0]?.effort ?? null,
    dominantBasis: known.length ? "tokens" : null,
    mixed: known.length >= 2,
    levels: mergedLevels,
    reconciliationDeltaTokens: present.reduce(
      (sum, s) => sum + s.reconciliationDeltaTokens,
      0,
    ),
  };
}
