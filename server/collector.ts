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
    blocks: ccusage.blocks.blocks,
    projects: aggregateProjects(ccusage.projects),
    models: aggregateModels(ccusage.unified.daily),
    quotas: quota,
    rules: listRules(),
    settings: getSettings(),
    sources: [
      { name: "ccusage", status: "healthy", detail: `Pinned v${ccusage.version} · offline pricing`, kind: "local analytics" },
      { name: "Path index", status: "healthy", detail: `${Object.keys(pathIndex).length} session records · metadata only`, kind: "local metadata" },
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
