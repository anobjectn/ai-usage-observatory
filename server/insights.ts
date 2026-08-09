import type { DashboardData, Session } from "../src/types";
import { providerFromAgent } from "../src/provider";
import { familyOf } from "../src/model-family";
import { dateKeyInTimeZone, systemTimeZone } from "../src/reporting-time";
import { shiftDateKey, validDateKey } from "../src/time-range";
import {
  buildEffortSessionDigest,
  resolveEffortFacet,
  resolveModelFamilies,
  resolveProviders,
  sessionsMatchingEffortFacet,
} from "./effort-api";

export type AnalysisScope = {
  rangeDays: number | null;
  fromDate: string | null;
  toDate: string | null;
  /** Selected providers, unioned with `modelFamilies`. Empty means every provider. */
  providers: Provider[];
  /** Selected dominant-model families, unioned with `providers`. Empty means every model. */
  modelFamilies: string[];
  pathTag: string;
  cache: "include" | "exclude";
  outliers: "all" | "typical" | "only";
  /** Efficiency rule id, or "all". Filters the findings list without changing any measurement. */
  finding: string;
  /** Data-only session facet. Once selected, downstream metrics retain each full session. */
  effort: string;
};
type Provider = "anthropic" | "codex";
type InsightSession = Session & {
  provider: Provider;
  /** Session total under the current cache scope — what the volume panel reports. */
  processed: number;
  /** Session total always including cache reads — what the ratio math needs. */
  raw: number;
  family: string;
  dominantModel: string;
  date: string | null;
  project: string;
  outlier: boolean;
  outlierReasons: string[];
};

export type Profile = { id: string; rubricVersion: string; score: number | null; band: "on-target" | "drifting" | "off-target" | null; confidence: "high" | "medium" | "low" | "insufficient"; components: Array<{id:string;label:string;weight:number;value:number|null;normalized:number|null;evidence:Record<string,number|string>;unavailableReason?:string}>; previousPeriod:{score:number|null;delta:number|null}; withoutOutliers:{score:number|null;delta:number|null}; explanation:string; links:Array<{label:string;href:string}> };

export type EfficiencyFinding = {
  ruleId: string;
  severity: "notice" | "opportunity" | "urgent";
  sessionId: string;
  provider: Provider;
  agent: string;
  date: string | null;
  project: string;
  model: string;
  headline: string;
  metrics: Array<{ label: string; value: string }>;
  /** Tokens a plausible alternative behaviour would not have re-sent. Null when not defensible. */
  recoverable: number | null;
  cost: number;
  processed: number;
};

/** Rule catalogue. `question` is the user-facing framing; `basis` states the evidence without
 * overclaiming — every rule below is a heuristic over token buckets, not an observed intent. */
export const efficiencyRules = [
  { id: "split-session", label: "Should have been split", severity: "opportunity" as const, question: "Which threads carried far more context per unit of output than comparable ones?", basis: "Cache-read tokens per output token, against the median for the same provider and model family." },
  { id: "missed-clear", label: "Missed a fresh start", severity: "opportunity" as const, question: "Which threads grew past a single context window instead of being cleared?", basis: "Cache-creation tokens written within one session. Claude only — ccusage reports no cache writes for Codex." },
  { id: "model-tier-mismatch", label: "Cost-tier mismatch", severity: "opportunity" as const, question: "Which small tasks ran on an expensive model?", basis: "Observed cost per million tokens for the dominant model versus the cheapest model you use regularly, on sessions in the smallest quartile." },
  { id: "model-switch", label: "Mid-thread model switch", severity: "notice" as const, question: "Which large threads split their work across model families?", basis: "Two or more families each holding at least 20% of one session. Switching mid-thread re-writes the prompt cache." },
  { id: "output-starved", label: "Read a lot, produced little", severity: "notice" as const, question: "Which large threads spent their tokens on context rather than answers?", basis: "Output share of session tokens, against the median for the same model family." },
  { id: "cold-cache", label: "Cache never amortised", severity: "notice" as const, question: "Which sessions paid to write a cache they then barely read?", basis: "Cache-creation tokens at or above cache-read tokens within the same session." },
];

// Exactly one provider mapper exists; see src/provider.ts.
const provider = providerFromAgent;
function modelTokens(model: Session["modelBreakdowns"][number]) {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
}
function total(row: Session, cache: AnalysisScope["cache"]) {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + (cache === "include" ? row.cacheReadTokens : 0);
}
function quantile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)))];
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : 0;
}
function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}
function projectOf(row: Session) {
  if (row.cwd) return row.cwd.split("/").filter(Boolean).at(-1) ?? row.cwd;
  return row.pathTags[0] ?? "unknown";
}
function compactTokens(value: number) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}

export type OutlierRowInput = { sessionId: string; provider: string; family: string; cacheReadTokens: number; processed: number; outputTokens: number };

export function outlierFlags<T extends OutlierRowInput>(rows: T[]) {
  const flagged = new Map<string, string[]>();
  const cohorts = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.provider}\0${row.family}\0${row.cacheReadTokens > 0 ? "cache" : "direct"}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), row]);
  }
  let evaluated = 0;
  let skipped = 0;
  for (const cohort of cohorts.values()) {
    // Below n=8 a modified z-score is noise, so report "cohort too small" rather than "no outliers".
    if (cohort.length < 8) { skipped += 1; continue; }
    evaluated += 1;
    for (const [field, label] of [["processed", "long-context"], ["cacheReadTokens", "cache-heavy"], ["outputTokens", "output-heavy"]] as const) {
      const values = cohort.map((row) => Math.log1p(row[field]));
      const center = median(values);
      const mad = median(values.map((value) => Math.abs(value - center)));
      // Zero-variance guard: flagging every non-median row would be worse than flagging none.
      if (mad === 0) continue;
      cohort.forEach((row, index) => {
        if (Math.abs((0.6745 * (values[index] - center)) / mad) > 3.5) flagged.set(row.sessionId, [...(flagged.get(row.sessionId) ?? []), label]);
      });
    }
  }
  return { flagged, evaluated, skipped };
}

export function resolveScope(input: URLSearchParams): AnalysisScope {
  const requestedRange = input.get("range");
  const range = Number(requestedRange ?? 30);
  const requestedFrom = input.get("from");
  const requestedTo = input.get("to");
  const validBounds =
    (!requestedFrom || validDateKey(requestedFrom)) &&
    (!requestedTo || validDateKey(requestedTo)) &&
    (!requestedFrom || !requestedTo || requestedFrom <= requestedTo);
  const requestedOutliers = input.get("outliers");
  const requestedFinding = input.get("finding");
  return {
    rangeDays: requestedRange === "all" ? null : Math.max(1, Math.min(120, Number.isFinite(range) ? Math.floor(range) : 30)),
    fromDate: validBounds && requestedFrom ? requestedFrom : null,
    toDate: validBounds && requestedTo ? requestedTo : null,
    providers: resolveProviders(input.get("providers")),
    modelFamilies: resolveModelFamilies(input.get("modelFamilies")),
    pathTag: input.get("pathTag") || "all",
    cache: input.get("cache") === "exclude" ? "exclude" : "include",
    outliers: requestedOutliers === "typical" || requestedOutliers === "only" ? requestedOutliers : "all",
    finding: efficiencyRules.some((rule) => rule.id === requestedFinding) ? String(requestedFinding) : "all",
    effort: resolveEffortFacet(input.get("effort")),
  };
}

function allowance(data: DashboardData, providerId: Provider, sessionCount: number): Profile {
  const series = (data.quotas.history?.series ?? []).filter((point) => point.provider === providerId);
  const weekly = series.filter((point) => point.window === "weekly");
  const fiveHour = series.filter((point) => point.window === "fiveHour");
  const reaches = data.quotas.history?.windows.find((window) => window.provider === providerId && window.window === "fiveHour")?.reachedCount ?? 0;
  const confidence: Profile["confidence"] = weekly.length >= 2 ? (providerId === "codex" ? "low" : "medium") : "insufficient";
  const recentWeekly = weekly.at(-1)?.usedPercent ?? null;
  const utilization = recentWeekly === null ? null : Math.max(0, 100 - Math.abs(90 - recentWeekly) * 2);
  const noStops = weekly.length ? Math.max(0, 100 - reaches * 20) : null;
  const pace = fiveHour.length >= 2 ? Math.max(0, 100 - Math.max(...fiveHour.map((point) => point.usedPercent)) + 60) : null;
  const components: Profile["components"] = [
    { id:"weekly-utilization", label:"Weekly allowance utilization", weight:40, value:recentWeekly, normalized:utilization, evidence:{points:weekly.length, usedPercent:recentWeekly ?? "N/A"}, unavailableReason: weekly.length ? undefined : "No weekly quota series" },
    { id:"hard-stops", label:"Absence of five-hour hard stops", weight:25, value:reaches, normalized:noStops, evidence:{reaches}, unavailableReason: weekly.length ? undefined : "No quota series" },
    { id:"pacing", label:"Pacing across five-hour windows", weight:20, value:fiveHour.length ? Math.max(...fiveHour.map((point) => point.usedPercent)) : null, normalized:pace, evidence:{points:fiveHour.length}, unavailableReason: fiveHour.length < 2 ? "Insufficient five-hour observations" : undefined },
    { id:"headroom", label:"Usable allowance before reset", weight:15, value:recentWeekly === null ? null : 100 - recentWeekly, normalized:recentWeekly === null ? null : recentWeekly <= 95 ? 100 : 0, evidence:{sessions:sessionCount}, unavailableReason: recentWeekly === null ? "No weekly quota series" : undefined },
  ];
  const available = components.filter((component) => component.normalized !== null);
  const score = confidence === "insufficient" ? null : Math.round(available.reduce((sum, component) => sum + component.weight * (component.normalized ?? 0), 0) / available.reduce((sum, component) => sum + component.weight, 0));
  return { id:`allowance-capture-${providerId}`, rubricVersion:"allowance-capture@1", score, band: score === null ? null : score >= 80 ? "on-target" : score >= 60 ? "drifting" : "off-target", confidence, components, previousPeriod:{score:null,delta:null}, withoutOutliers:{score,delta:0}, explanation: score === null ? "Allowance Capture needs locally observed quota percentage history before it can be graded." : `${providerId === "anthropic" ? "Claude" : "Codex"} is scored separately from its own locally observed quota history.`, links:[{label:"Quota provenance",href:"?view=sources"}] };
}

/** Per-session context estimates. Claude writes one cache block per turn, so for a thread whose
 * context grows roughly linearly the reads sum to turns x half the final context — inverting that
 * gives a turn count. Codex reports no cache creation, so both estimates are unavailable there
 * rather than zero. Both are rough: a compaction or an expired cache re-writes the prefix. */
export function contextEstimate(row: { cacheReadTokens: number; cacheCreationTokens: number }) {
  if (row.cacheCreationTokens <= 0) return { turns: null, contextWritten: null };
  return { turns: Math.round((2 * row.cacheReadTokens) / row.cacheCreationTokens), contextWritten: row.cacheCreationTokens };
}

function insightDate(row: Session, timeZone: string) {
  const activity = dateKeyInTimeZone(row.metadata?.lastActivity, timeZone);
  if (validDateKey(activity)) return activity;
  const period = row.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)?.slice(1).join("-");
  return validDateKey(period) ? period : null;
}

function summarizeGroup(rows: InsightSession[]) {
  const sum = rows.reduce(
    (totals, row) => ({
      processed: totals.processed + row.processed,
      raw: totals.raw + row.raw,
      input: totals.input + row.inputTokens,
      output: totals.output + row.outputTokens,
      cacheRead: totals.cacheRead + row.cacheReadTokens,
      cacheCreation: totals.cacheCreation + row.cacheCreationTokens,
      cost: totals.cost + row.totalCost,
    }),
    { processed: 0, raw: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 },
  );
  const withWrites = rows.filter((row) => row.cacheCreationTokens > 0);
  return {
    ...sum,
    sessions: rows.length,
    medianSession: Math.round(median(rows.map((row) => row.processed))),
    p90Session: Math.round(quantile(rows.map((row) => row.processed), 0.9)),
    largestSession: rows.length ? Math.max(...rows.map((row) => row.processed)) : 0,
    outputShare: ratio(sum.output, sum.processed),
    /** Context tokens re-read per output token produced. */
    contextCarry: ratio(sum.cacheRead, sum.output),
    /** Share of non-output input served from cache rather than sent fresh. */
    cacheHitRate: ratio(sum.cacheRead, sum.cacheRead + sum.input),
    /** Reads per written token: how many times each cache write paid for itself. */
    amplification: ratio(sum.cacheRead, sum.cacheCreation),
    cacheWritesReported: withWrites.length > 0,
    medianTurns: withWrites.length ? Math.round(median(withWrites.map((row) => contextEstimate(row).turns ?? 0))) : null,
    medianContextWritten: withWrites.length ? Math.round(median(withWrites.map((row) => row.cacheCreationTokens))) : null,
    largestContextWritten: withWrites.length ? Math.max(...withWrites.map((row) => row.cacheCreationTokens)) : null,
  };
}

type ModelRate = { rate: number | null; dominantSessions: number; provider: Provider };

function modelRates(sessions: InsightSession[]) {
  const totals = new Map<string, { tokens: number; cost: number; dominantSessions: number; provider: Provider }>();
  for (const row of sessions) {
    for (const model of row.modelBreakdowns) {
      const current = totals.get(model.modelName) ?? { tokens: 0, cost: 0, dominantSessions: 0, provider: row.provider };
      current.tokens += modelTokens(model);
      current.cost += model.cost;
      if (model.modelName === row.dominantModel) current.dominantSessions += 1;
      totals.set(model.modelName, current);
    }
  }
  return new Map<string, ModelRate>(
    [...totals].map(([model, entry]) => [model, {
      // Blended $/Mtok over observed traffic. It is a cost-tier proxy, never a capability ranking.
      rate: entry.cost > 0 && entry.tokens > 0 ? (entry.cost / entry.tokens) * 1e6 : null,
      dominantSessions: entry.dominantSessions,
      provider: entry.provider,
    }]),
  );
}

function buildFindings(rows: InsightSession[], rates: Map<string, ModelRate>): EfficiencyFinding[] {
  const findings: EfficiencyFinding[] = [];
  const cohorts = new Map<string, InsightSession[]>();
  for (const row of rows) cohorts.set(`${row.provider}\0${row.family}`, [...(cohorts.get(`${row.provider}\0${row.family}`) ?? []), row]);
  const stats = new Map(
    [...cohorts].map(([key, cohort]) => [key, {
      size: cohort.length,
      p25: quantile(cohort.map((row) => row.raw), 0.25),
      p75: quantile(cohort.map((row) => row.raw), 0.75),
      carry: median(cohort.filter((row) => row.outputTokens > 0).map((row) => row.cacheReadTokens / row.outputTokens)),
      outputShare: median(cohort.map((row) => (row.raw ? row.outputTokens / row.raw : 0))),
    }]),
  );
  // Baseline for the cost-tier rule: the cheapest model of that provider the user actually uses
  // regularly. A model tried once is not a credible alternative to recommend.
  const baseline = new Map<Provider, { model: string; rate: number }>();
  for (const [model, entry] of rates) {
    if (entry.rate === null || entry.dominantSessions < 5) continue;
    const current = baseline.get(entry.provider);
    if (!current || entry.rate < current.rate) baseline.set(entry.provider, { model, rate: entry.rate });
  }

  for (const row of rows) {
    const cohort = stats.get(`${row.provider}\0${row.family}`);
    if (!cohort || cohort.size < 5) continue;
    const shared = { sessionId: row.sessionId, provider: row.provider, agent: row.agent, date: row.date, project: row.project, model: row.dominantModel, cost: row.totalCost, processed: row.processed };
    const carry = ratio(row.cacheReadTokens, row.outputTokens);
    const estimate = contextEstimate(row);

    if (carry !== null && cohort.carry > 0 && row.raw >= cohort.p75 && carry >= 2 * cohort.carry) {
      findings.push({ ...shared, ruleId: "split-session", severity: "opportunity",
        headline: `Re-read ${Math.round(carry)} context tokens for every token produced — ${(carry / cohort.carry).toFixed(1)}x the ${row.family} median`,
        metrics: [{ label: "Context carry", value: `${Math.round(carry)} : 1` }, { label: `${row.family} median`, value: `${Math.round(cohort.carry)} : 1` }, { label: "Cache read", value: compactTokens(row.cacheReadTokens) }, { label: "Output", value: compactTokens(row.outputTokens) }],
        recoverable: Math.max(0, Math.round(row.cacheReadTokens - row.outputTokens * 2 * cohort.carry)) });
    }
    if (estimate.contextWritten !== null && estimate.contextWritten >= 250_000) {
      findings.push({ ...shared, ruleId: "missed-clear", severity: "opportunity",
        headline: `Wrote ${compactTokens(estimate.contextWritten)} of context in one thread — more than a single 200K window holds`,
        metrics: [{ label: "Context written", value: compactTokens(estimate.contextWritten) }, { label: "Est. turns", value: estimate.turns === null ? "N/A" : String(estimate.turns) }, { label: "Est. context per turn", value: compactTokens(Math.round(estimate.contextWritten / 2)) }, { label: "Cache read", value: compactTokens(row.cacheReadTokens) }],
        recoverable: Math.max(0, Math.round(row.cacheReadTokens - (estimate.turns ?? 0) * 100_000)) });
    }
    const rate = rates.get(row.dominantModel)?.rate ?? null;
    const base = baseline.get(row.provider);
    if (rate !== null && base && row.dominantModel !== base.model && rate >= 2.5 * base.rate && row.raw <= cohort.p25 && row.outputTokens <= 5_000) {
      findings.push({ ...shared, ruleId: "model-tier-mismatch", severity: "opportunity",
        headline: `${compactTokens(row.raw)} tokens and ${compactTokens(row.outputTokens)} of output on ${row.dominantModel}, which costs ${(rate / base.rate).toFixed(1)}x ${base.model} in your data`,
        metrics: [{ label: `${row.dominantModel}`, value: `$${rate.toFixed(2)} / Mtok` }, { label: `${base.model}`, value: `$${base.rate.toFixed(2)} / Mtok` }, { label: "Session cost", value: `$${row.totalCost.toFixed(3)}` }, { label: "At baseline rate", value: `$${((row.raw / 1e6) * base.rate).toFixed(3)}` }],
        recoverable: null });
    }
    const majorFamilies = [...new Set(row.modelBreakdowns.filter((model) => modelTokens(model) >= row.raw * 0.2).map((model) => familyOf(model.modelName)))];
    if (majorFamilies.length >= 2 && row.raw >= cohort.p75) {
      findings.push({ ...shared, ruleId: "model-switch", severity: "notice",
        headline: `Split ${compactTokens(row.raw)} tokens across ${majorFamilies.join(" and ")} in one thread`,
        metrics: [
          ...majorFamilies.slice(0, 3).map((family) => ({ label: family, value: `${Math.round((row.modelBreakdowns.filter((model) => familyOf(model.modelName) === family).reduce((sum, model) => sum + modelTokens(model), 0) / row.raw) * 100)}%` })),
          { label: "Cache write", value: row.cacheCreationTokens ? compactTokens(row.cacheCreationTokens) : "N/A" },
        ],
        recoverable: null });
    }
    const outputShare = row.raw ? row.outputTokens / row.raw : 0;
    if (cohort.outputShare > 0 && row.raw >= cohort.p75 && outputShare <= 0.4 * cohort.outputShare) {
      findings.push({ ...shared, ruleId: "output-starved", severity: "notice",
        headline: `Only ${(outputShare * 100).toFixed(2)}% of this thread was generated output, against ${(cohort.outputShare * 100).toFixed(2)}% for ${row.family}`,
        metrics: [{ label: "Output share", value: `${(outputShare * 100).toFixed(2)}%` }, { label: `${row.family} median`, value: `${(cohort.outputShare * 100).toFixed(2)}%` }, { label: "Processed", value: compactTokens(row.raw) }, { label: "Output", value: compactTokens(row.outputTokens) }],
        recoverable: null });
    }
    if (row.cacheCreationTokens > 0 && row.cacheCreationTokens >= row.cacheReadTokens && row.raw >= 50_000) {
      findings.push({ ...shared, ruleId: "cold-cache", severity: "notice",
        headline: `Wrote ${compactTokens(row.cacheCreationTokens)} of cache and read back only ${compactTokens(row.cacheReadTokens)}`,
        metrics: [{ label: "Cache write", value: compactTokens(row.cacheCreationTokens) }, { label: "Cache read", value: compactTokens(row.cacheReadTokens) }, { label: "Reads per write", value: (ratio(row.cacheReadTokens, row.cacheCreationTokens) ?? 0).toFixed(2) }],
        recoverable: null });
    }
  }
  const weight = { urgent: 0, opportunity: 1, notice: 2 };
  return findings.sort((a, b) => weight[a.severity] - weight[b.severity] || (b.recoverable ?? 0) - (a.recoverable ?? 0) || b.processed - a.processed);
}

/** The Agent filter's provider and model grains are unioned; see `matchesAgentScope`. */
function matchesAgentScope(row: Session, itemProvider: Provider, scope: AnalysisScope) {
  if (scope.providers.length === 0 && scope.modelFamilies.length === 0) return true;
  if (scope.providers.includes(itemProvider)) return true;
  return row.modelBreakdowns.some((model) => scope.modelFamilies.includes(familyOf(model.modelName)));
}

export function buildInsights(data: DashboardData, scope: AnalysisScope) {
  // Allowance cards are a whole-corpus overview. Session, Agent, path, cache, finding, effort,
  // outlier, and time controls scope the analysis below this row, but never its membership or
  // evidence counts.
  const overviewSessionCounts = new Map<Provider, number>();
  for (const row of data.sessions) {
    const itemProvider = provider(row.agent);
    if (itemProvider) overviewSessionCounts.set(itemProvider, (overviewSessionCounts.get(itemProvider) ?? 0) + 1);
  }
  const overviewProviderIds = new Set<Provider>(overviewSessionCounts.keys());
  for (const quotaProvider of data.quotas.usage?.providers ?? []) {
    if (quotaProvider.provider === "anthropic" || quotaProvider.provider === "codex") overviewProviderIds.add(quotaProvider.provider);
  }
  for (const point of data.quotas.history?.series ?? []) overviewProviderIds.add(point.provider);
  for (const window of data.quotas.history?.windows ?? []) overviewProviderIds.add(window.provider);
  const overviewProviders = (["anthropic", "codex"] as Provider[]).filter((id) => overviewProviderIds.has(id));

  const timeZone = data.timeZone || systemTimeZone();
  const today = dateKeyInTimeZone(new Date(), timeZone);
  const rangeStart = scope.rangeDays === null || !today ? null : shiftDateKey(today, -(scope.rangeDays - 1));
  const effortSessions = sessionsMatchingEffortFacet(data, scope);
  const base: InsightSession[] = data.sessions
    .filter((row) => {
      const itemProvider = provider(row.agent);
      const date = insightDate(row, timeZone);
      return itemProvider
        && (effortSessions === null || effortSessions.has(row.sessionId))
        && matchesAgentScope(row, itemProvider, scope)
        && (scope.fromDate ? date !== null && date >= scope.fromDate : rangeStart === null || date === null || date >= rangeStart)
        && (!scope.toDate || (date !== null && date <= scope.toDate))
        && (scope.pathTag === "all" || row.pathTags.includes(scope.pathTag));
    })
    .map((row) => {
      const dominantModel = [...row.modelBreakdowns].sort((a, b) => modelTokens(b) - modelTokens(a))[0]?.modelName ?? "unknown";
      const lastActivity = String(row.metadata?.lastActivity ?? "");
      return {
        ...row,
        provider: provider(row.agent)!,
        processed: total(row, scope.cache),
        raw: total(row, "include"),
        dominantModel,
        family: familyOf(dominantModel),
        date: Number.isFinite(Date.parse(lastActivity)) ? lastActivity : null,
        project: projectOf(row),
        outlier: false,
        outlierReasons: [] as string[],
      };
    });

  const { flagged, evaluated, skipped } = outlierFlags(base);
  const marked = base.map((row) => ({ ...row, outlier: flagged.has(row.sessionId), outlierReasons: flagged.get(row.sessionId) ?? [] }));
  // Detection runs on the whole provider cohort; the facet only chooses what is displayed.
  const sessions = marked.filter((row) => scope.outliers === "all" || (scope.outliers === "only" ? row.outlier : !row.outlier));
  // Provider rows follow what actually survived the Agent filter, so a model-only selection still
  // reports the provider that model belongs to rather than both.
  const present = new Set(sessions.map((row) => row.provider));
  const providers = (["anthropic", "codex"] as Provider[]).filter((id) => present.has(id));
  const rates = modelRates(sessions);

  const overall = summarizeGroup(sessions);
  const perProvider = providers.map((id) => ({ provider: id, ...summarizeGroup(sessions.filter((row) => row.provider === id)) }));
  const models = [...new Set(sessions.flatMap((row) => row.modelBreakdowns.map((model) => model.modelName)))]
    .map((model) => {
      const appearsIn = sessions.filter((row) => row.modelBreakdowns.some((entry) => entry.modelName === model));
      const dominantIn = sessions.filter((row) => row.dominantModel === model);
      const sums = appearsIn
        .flatMap((row) => row.modelBreakdowns.filter((entry) => entry.modelName === model))
        .reduce((totals, entry) => ({
          processed: totals.processed + entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + (scope.cache === "include" ? entry.cacheReadTokens : 0),
          input: totals.input + entry.inputTokens,
          output: totals.output + entry.outputTokens,
          cacheRead: totals.cacheRead + entry.cacheReadTokens,
          cacheCreation: totals.cacheCreation + entry.cacheCreationTokens,
          cost: totals.cost + entry.cost,
        }), { processed: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });
      return {
        model,
        family: familyOf(model),
        provider: appearsIn[0]?.provider ?? "anthropic",
        sessions: appearsIn.length,
        dominantIn: dominantIn.length,
        ...sums,
        ratePerMillion: rates.get(model)?.rate ?? null,
        priced: !data.unpricedModels.includes(model),
        outputShare: ratio(sums.output, sums.processed),
        contextCarry: ratio(sums.cacheRead, sums.output),
        cacheHitRate: ratio(sums.cacheRead, sums.cacheRead + sums.input),
        medianSession: Math.round(median(dominantIn.map((row) => row.processed))),
        outliers: dominantIn.filter((row) => row.outlier).length,
      };
    })
    .sort((a, b) => b.processed - a.processed);

  const outliers = marked.filter((row) => row.outlier);
  const allTokens = marked.reduce((sum, row) => sum + row.processed, 0);

  const findings = buildFindings(sessions, rates);
  const shown = scope.finding === "all" ? findings : findings.filter((finding) => finding.ruleId === scope.finding);
  const flaggedSessions = new Set(findings.map((finding) => finding.sessionId));
  // One session can trip several rules over the same cache reads, so summing every estimate would
  // count the same tokens twice. Credit each session with its single largest estimate instead.
  const perSession = new Map<string, number>();
  for (const finding of findings) perSession.set(finding.sessionId, Math.max(perSession.get(finding.sessionId) ?? 0, finding.recoverable ?? 0));
  const recoverable = [...perSession.values()].reduce((sum, value) => sum + value, 0);
  const effortLevels = buildEffortSessionDigest(data, {
    basis: "sessions",
    rangeDays: scope.rangeDays,
    fromDate: scope.fromDate,
    toDate: scope.toDate,
    providers: scope.providers,
    modelFamilies: scope.modelFamilies,
    pathTag: scope.pathTag,
    project: null,
    model: null,
    effort: "all",
    outliers: "all",
  }).levels;

  return {
    scope,
    profiles: overviewProviders.map((id) => allowance(data, id, overviewSessionCounts.get(id) ?? 0)),
    volume: {
      ...overall,
      cacheCreationAvailable: data.models.some((model) => model.cacheCreationTokens > 0),
      providers: perProvider,
      models: models.slice(0, 12),
    },
    cacheComposition: {
      directInput: overall.input,
      cacheRead: overall.cacheRead,
      cacheCreation: overall.cacheCreation,
      output: overall.output,
      cacheHitRate: overall.cacheHitRate,
      amplification: overall.amplification,
      providers: perProvider.map(({ provider: id, input, cacheRead, cacheCreation, output, cacheHitRate, amplification, cacheWritesReported, medianTurns, medianContextWritten, largestContextWritten }) => ({ provider: id, directInput: input, cacheRead, cacheCreation, output, cacheHitRate, amplification, cacheWritesReported, medianTurns, medianContextWritten, largestContextWritten })),
    },
    outliers: {
      count: outliers.length,
      sessionShare: marked.length ? outliers.length / marked.length : 0,
      tokenShare: allTokens ? outliers.reduce((sum, row) => sum + row.processed, 0) / allTokens : 0,
      cohortsEvaluated: evaluated,
      cohortsSkipped: skipped,
      sessions: outliers
        .map((row) => {
          // Compare against the same cohort the detector used, cache mode included, so the
          // displayed multiple is the basis of the flag rather than a looser lookalike.
          const cohortMedian = median(marked.filter((other) => other.provider === row.provider && other.family === row.family && other.cacheReadTokens > 0 === row.cacheReadTokens > 0).map((other) => other.processed));
          return { sessionId: row.sessionId, provider: row.provider, agent: row.agent, date: row.date, project: row.project, model: row.dominantModel, family: row.family, reasons: row.outlierReasons, processed: row.processed, input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheCreation: row.cacheCreationTokens, cost: row.totalCost, cohortMedian: Math.round(cohortMedian), timesCohortMedian: ratio(row.processed, cohortMedian), estimatedTurns: contextEstimate(row).turns };
        })
        .sort((a, b) => b.processed - a.processed),
    },
    efficiency: {
      rules: efficiencyRules.map((rule) => {
        const matches = findings.filter((finding) => finding.ruleId === rule.id);
        return { ...rule, count: matches.length, recoverable: matches.reduce((sum, finding) => sum + (finding.recoverable ?? 0), 0) };
      }),
      findings: shown.slice(0, 80),
      truncated: Math.max(0, shown.length - 80),
      totals: { findings: findings.length, flaggedSessions: flaggedSessions.size, sessionShare: ratio(flaggedSessions.size, sessions.length), recoverable, recoverableShare: ratio(recoverable, overall.raw) },
    },
    facets: {
      modelFamilies: [...new Set(marked.map((row) => row.family))].sort(),
      sessionsInScope: marked.length,
      sessionsShown: sessions.length,
      outlierCount: outliers.length,
      effortLevels,
    },
  };
}
