import { basename } from "node:path";
import { dateKeyInTimeZone, systemTimeZone } from "../src/reporting-time";
import { providerFromAgent } from "../src/provider";
import { collectCcusage } from "./ccusage";
import { collectQuota } from "./quota";
import { getPathIndex, indexSessionPaths } from "./path-indexer";
import { scheduleEffortIndexing, setEffortCatalog } from "./effort-index";
import { emptyAnnotation, getAnnotations, getAnnotationVersion, getSettings, listRules } from "./store";
import { buildInsights, resolveScope } from "./insights";
import { reconcileAdvice } from "./advice";
import { aggregateModels } from "../src/model-aggregation";

export { aggregateModels } from "../src/model-aggregation";

type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
let snapshot: Snapshot | null = null;
let refreshPromise: Promise<Snapshot> | null = null;
let lastError: string | null = null;
let snapshotAnnotationVersion = -1;

type ModelUsage = { modelName: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; cost: number };

function modelTokens(model: ModelUsage) {
  return model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
}

function accumulateModel<T>(models: Map<string, T>, model: ModelUsage, create: () => T, update: (current: T, model: ModelUsage) => void) {
  const current = models.get(model.modelName) ?? create();
  update(current, model);
  models.set(model.modelName, current);
  return current;
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

type ProjectModelTotals = {inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;cost:number};

export function aggregateProjects(sessions: ProjectActivitySession[], timeZone = systemTimeZone()) {
  const projects = new Map<string, {name:string;tokens:number;cost:number;sessions:number;models:Map<string,number>;days:Map<string,{date:string;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;totalTokens:number;totalCost:number;models:Map<string,ProjectModelTotals>}>}>();
  for (const session of sessions) {
    const date = dateKeyInTimeZone(session.metadata?.lastActivity, timeZone) ?? session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)?.slice(1).join("-") ?? null;
    if (!activityProvider(session.agent) || !date || !session.cwd) continue;
    const projectId = session.cwd.replace(/\/+$/, "");
    const project = projects.get(projectId) ?? {name:projectId,tokens:0,cost:0,sessions:0,models:new Map(),days:new Map()};
    const day = project.days.get(date) ?? {date,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,totalTokens:0,totalCost:0,models:new Map()};
    project.tokens += session.totalTokens;
    project.cost += session.totalCost;
    project.sessions++;
    day.totalTokens += session.totalTokens;
    day.totalCost += session.totalCost;
    for (const model of session.modelBreakdowns) {
      const tokens = modelTokens(model);
      project.models.set(model.modelName, (project.models.get(model.modelName) ?? 0) + tokens);
      day.inputTokens += model.inputTokens;
      day.outputTokens += model.outputTokens;
      day.cacheReadTokens += model.cacheReadTokens;
      day.cacheCreationTokens += model.cacheCreationTokens;
      accumulateModel(day.models, model, () => ({inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,cost:0}), (current, entry) => {
        current.inputTokens += entry.inputTokens;
        current.outputTokens += entry.outputTokens;
        current.cacheReadTokens += entry.cacheReadTokens;
        current.cacheCreationTokens += entry.cacheCreationTokens;
        current.cost += entry.cost;
      });
    }
    project.days.set(date, day);
    projects.set(projectId, project);
  }
  return [...projects.values()].map((project) => ({
    name: project.name,
    tokens: project.tokens,
    cost: project.cost,
    sessions: project.sessions,
    models: [...project.models.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model),
    trend: [...project.days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => {
      const {models, ...totals} = day;
      const modelBreakdowns = [...models.entries()].map(([modelName, values]) => ({modelName,...values})).sort((a, b) => (b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens) - (a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheCreationTokens));
      return {...totals,modelsUsed:modelBreakdowns.map((model) => model.modelName),modelBreakdowns};
    }),
  })).sort((a, b) => b.cost - a.cost);
}

// Effort, projects, and project activity all bucket days through the one shared reporting-time
// helper; a private copy here would let one view's days drift from another's.
// The provider mapper is likewise shared: this now also recognises "openai"-flavoured agent
// labels as Codex, matching what Insights already did.
function activityProvider(agent: string) {
  return providerFromAgent(agent);
}

export function aggregateProjectActivity(sessions: ProjectActivitySession[], timeZone = systemTimeZone()) {
  const activity = new Map<string, {date:string;provider:"anthropic"|"codex";projectId:string;projectName:string;tokens:number;cost:number;sessions:number;models:Map<string,{tokens:number;cost:number}>}>();
  for (const session of sessions) {
    const provider = activityProvider(session.agent);
    const date = dateKeyInTimeZone(session.metadata?.lastActivity, timeZone) ?? session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)?.slice(1).join("-") ?? null;
    if (!provider || !date || !session.cwd) continue;
    const projectId = session.cwd.replace(/\/+$/, "");
    const key = `${date}\0${provider}\0${projectId}`;
    const bucket = activity.get(key) ?? { date, provider, projectId, projectName: basename(projectId), tokens: 0, cost: 0, sessions: 0, models: new Map<string,{tokens:number;cost:number}>() };
    bucket.tokens += session.totalTokens;
    bucket.cost += session.totalCost;
    bucket.sessions++;
    for (const model of session.modelBreakdowns) {
      accumulateModel(bucket.models, model, () => ({tokens:0,cost:0}), (current, entry) => {
        current.tokens += modelTokens(entry);
        current.cost += entry.cost;
      });
    }
    activity.set(key, bucket);
  }
  return [...activity.values()].map((item) => ({
    ...item,
    models: [...item.models.entries()].map(([model, values]) => ({model, ...values})).sort((a, b) => b.tokens - a.tokens),
  })).sort((a, b) => a.date.localeCompare(b.date) || b.tokens - a.tokens);
}

async function buildSnapshot() {
  const timeZone = systemTimeZone();
  const [paths, ccusage, quota] = await Promise.all([indexSessionPaths(), collectCcusage(timeZone), collectQuota()]);
  setEffortCatalog(paths.catalog);
  const pathIndex = getPathIndex();
  // Read the revision before the rows: a write in between only causes one harmless re-overlay,
  // whereas the other order could leave a stale annotation looking current.
  snapshotAnnotationVersion = getAnnotationVersion();
  const annotations = getAnnotations();
  const sessions = ccusage.unified.session.map((row) => {
    const path = pathIndex[`${row.agent}:${row.period}`];
    const sessionId = path?.sessionId ?? `${row.agent}-${row.period}`;
    return { ...row, sessionId, cwd: path?.cwd ?? null, pathTags: path?.tags ?? [], annotation: annotations[sessionId] ?? emptyAnnotation() };
  }).sort((a, b) => String(b.metadata?.lastActivity ?? "").localeCompare(String(a.metadata?.lastActivity ?? "")));
  return {
    collectedAt: new Date().toISOString(),
    timeZone,
    ccusageVersion: ccusage.version,
    costMethodology: "ccusage",
    blockScope: "Claude Code",
    daily: ccusage.unified.daily,
    weekly: ccusage.unified.weekly,
    monthly: ccusage.unified.monthly,
    totals: ccusage.unified.totals,
    sessions,
    projectActivity: aggregateProjectActivity(sessions, timeZone),
    blocks: ccusage.blocks.blocks,
    projects: aggregateProjects(sessions, timeZone),
    models: aggregateModels(ccusage.unified.daily, ccusage.unpricedModels),
    unpricedModels: ccusage.unpricedModels,
    quotas: quota,
    rules: listRules(),
    settings: getSettings(),
    sources: [
      {
        name: "ccusage",
        status: ccusage.unpricedModels.length ? "degraded" : "healthy",
        detail: ccusage.unpricedModels.length
          ? `Pinned v${ccusage.version} · ${timeZone} calendar · no pricing for ${ccusage.unpricedModels.join(", ")} — cost totals exclude these models`
          : `Pinned v${ccusage.version} · ${timeZone} calendar · live pricing`,
        kind: "local analytics",
      },
      { name: "Path index", status: "healthy", detail: `${sessions.filter((session) => session.cwd).length} sessions joined · metadata only`, kind: "local metadata" },
      { name: "quota-service", status: quota.available ? "healthy" : "unavailable", detail: quota.available ? "Provider-reported limits connected" : quota.error, kind: "provider quota" },
    ],
  };
}

export async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = buildSnapshot().then((next) => { snapshot = next; lastError = null;
    // Transcript indexing is scheduled only after the snapshot and path catalog succeeded, and
    // is never awaited by a request handler.
    queueMicrotask(() => { try { scheduleEffortIndexing(); } catch { /* indexing must never break collection */ } });
    queueMicrotask(() => {
      // Advice is evaluated against the default, unfaceted scope so it cannot depend on what a
      // browser happens to be looking at.
      try { reconcileAdvice(buildInsights(next as unknown as import("../src/types").DashboardData, resolveScope(new URLSearchParams()))); }
      catch { /* Advice is best-effort; a failed rule must never invalidate a collection. */ }
    });
    return next;
  }).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    if (snapshot) return snapshot;
    throw error;
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/** A verdict or tag edit must be visible without a full ccusage recollection. Re-overlaying the
 * annotations onto the cached snapshot does that without redefining what `collectedAt` means. */
function withCurrentAnnotations(current: Snapshot): Snapshot {
  const version = getAnnotationVersion();
  if (version === snapshotAnnotationVersion) return current;
  const annotations = getAnnotations();
  snapshotAnnotationVersion = version;
  snapshot = {
    ...current,
    sessions: current.sessions.map((session) => ({
      ...session,
      annotation: annotations[session.sessionId] ?? emptyAnnotation(),
    })),
  };
  return snapshot;
}

export async function getSnapshot() {
  const isStale = !snapshot || Date.now() - Date.parse(snapshot.collectedAt) >= 60_000;
  const result = isStale ? await refresh() : withCurrentAnnotations(snapshot!);
  return { ...result, refresh: { inProgress: Boolean(refreshPromise), lastError, stale: Boolean(lastError) } };
}
