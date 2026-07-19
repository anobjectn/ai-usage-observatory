import { basename } from "node:path";
import { collectCcusage } from "./ccusage";
import { collectQuota } from "./quota";
import { getPathIndex, indexSessionPaths } from "./path-indexer";
import { getAnnotations, getSettings, listRules } from "./store";

type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
let snapshot: Snapshot | null = null;
let refreshPromise: Promise<Snapshot> | null = null;
let lastError: string | null = null;

function aggregateModels(rows: Awaited<ReturnType<typeof collectCcusage>>["unified"]["daily"]) {
  const models = new Map<string, {model:string;tokens:number;cost:number;inputTokens:number;outputTokens:number;cacheReadTokens:number;agents:Set<string>}>();
  for (const row of rows) for (const agent of row.agents ?? []) for (const model of agent.modelBreakdowns) {
    const current = models.get(model.modelName) ?? { model: model.modelName, tokens: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, agents: new Set<string>() };
    current.tokens += model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
    current.cost += model.cost;
    current.inputTokens += model.inputTokens;
    current.outputTokens += model.outputTokens;
    current.cacheReadTokens += model.cacheReadTokens;
    current.agents.add(agent.agent);
    models.set(model.modelName, current);
  }
  return [...models.values()].map((model) => ({ ...model, agents: [...model.agents] })).sort((a, b) => b.cost - a.cost);
}

function aggregateProjects(report: Awaited<ReturnType<typeof collectCcusage>>["projects"]) {
  return Object.entries(report.projects).map(([name, rows]) => ({
    name,
    tokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    cost: rows.reduce((sum, row) => sum + row.totalCost, 0),
    sessions: rows.length,
    models: [...new Set(rows.flatMap((row) => row.modelsUsed))],
    trend: rows,
  })).sort((a, b) => b.cost - a.cost);
}

type ProjectActivitySession = {
  agent: string;
  period: string;
  totalTokens: number;
  cwd: string | null;
  metadata?: {lastActivity?:unknown};
  totalCost: number;
  modelBreakdowns: Array<{modelName:string;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;cost:number}>;
};

function localDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function activityProvider(agent: string) {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic" as const;
  if (normalized.includes("codex")) return "codex" as const;
  return null;
}

export function aggregateProjectActivity(sessions: ProjectActivitySession[]) {
  const activity = new Map<string, {date:string;provider:"anthropic"|"codex";projectId:string;projectName:string;tokens:number;cost:number;sessions:number;models:Map<string,{tokens:number;cost:number}>}>();
  for (const session of sessions) {
    const provider = activityProvider(session.agent);
    const date = localDate(session.metadata?.lastActivity) ?? session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)?.slice(1).join("-") ?? null;
    if (!provider || !date || !session.cwd) continue;
    const projectId = session.cwd.replace(/\/+$/, "");
    const key = `${date}\0${provider}\0${projectId}`;
    const bucket = activity.get(key) ?? { date, provider, projectId, projectName: basename(projectId), tokens: 0, cost: 0, sessions: 0, models: new Map<string,{tokens:number;cost:number}>() };
    bucket.tokens += session.totalTokens;
    bucket.cost += session.totalCost;
    bucket.sessions++;
    for (const model of session.modelBreakdowns) {
      const tokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
      const current = bucket.models.get(model.modelName) ?? {tokens:0,cost:0};
      current.tokens += tokens;
      current.cost += model.cost;
      bucket.models.set(model.modelName, current);
    }
    activity.set(key, bucket);
  }
  return [...activity.values()].map((item) => ({
    ...item,
    models: [...item.models.entries()].map(([model, values]) => ({model, ...values})).sort((a, b) => b.tokens - a.tokens),
  })).sort((a, b) => a.date.localeCompare(b.date) || b.tokens - a.tokens);
}

async function buildSnapshot() {
  const [, ccusage, quota] = await Promise.all([indexSessionPaths(), collectCcusage(), collectQuota()]);
  const pathIndex = getPathIndex();
  const annotations = getAnnotations();
  const sessions = ccusage.unified.session.map((row) => {
    const path = pathIndex[`${row.agent}:${row.period}`];
    const sessionId = path?.sessionId ?? `${row.agent}-${row.period}`;
    return { ...row, sessionId, cwd: path?.cwd ?? null, pathTags: path?.tags ?? [], annotation: annotations[sessionId] ?? { tags: [], note: "" } };
  }).sort((a, b) => String(b.metadata?.lastActivity ?? "").localeCompare(String(a.metadata?.lastActivity ?? "")));
  return {
    collectedAt: new Date().toISOString(),
    ccusageVersion: ccusage.version,
    costMethodology: "ccusage",
    blockScope: "Claude Code",
    daily: ccusage.unified.daily,
    weekly: ccusage.unified.weekly,
    monthly: ccusage.unified.monthly,
    totals: ccusage.unified.totals,
    sessions,
    projectActivity: aggregateProjectActivity(sessions),
    blocks: ccusage.blocks.blocks,
    projects: aggregateProjects(ccusage.projects),
    models: aggregateModels(ccusage.unified.daily),
    quotas: quota,
    rules: listRules(),
    settings: getSettings(),
    sources: [
      { name: "ccusage", status: "healthy", detail: `Pinned v${ccusage.version} · offline pricing`, kind: "local analytics" },
      { name: "Path index", status: "healthy", detail: `${sessions.filter((session) => session.cwd).length} sessions joined · metadata only`, kind: "local metadata" },
      { name: "quota-service", status: quota.available ? "healthy" : "unavailable", detail: quota.available ? "Provider-reported limits connected" : quota.error, kind: "provider quota" },
    ],
  };
}

export async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = buildSnapshot().then((next) => { snapshot = next; lastError = null; return next; }).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    if (snapshot) return snapshot;
    throw error;
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function getSnapshot() {
  const result = snapshot ?? await refresh();
  return { ...result, refresh: { inProgress: Boolean(refreshPromise), lastError, stale: Boolean(lastError) } };
}
