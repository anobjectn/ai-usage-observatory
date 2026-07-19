import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlarmClock, ArrowDownRight, ArrowUpRight, Atom, Bot, Check,
  ChevronLeft, ChevronRight, CircleDollarSign, Clock3, Database, FolderGit2,
  Copy, Gauge, Layers3, Menu, Orbit, Palette, PencilLine, RefreshCw, RotateCcw, Search, Settings2,
  Plus, Sparkles, Tag, Trash2, X, Zap,
} from "lucide-react";
import { OrbitalScene, Starfield, type ProviderColors, type SceneEffects } from "./scene";
import { providerHeadroom } from "./quota-headroom";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { DashboardData, MetricRow, ModelBreakdown, ProjectActivity, ProjectTrendRow, Session, SessionDetail } from "./types";

type View = "overview" | "explorer" | "sessions" | "projects" | "models" | "limits";
type Metric = "totalTokens" | "totalCost" | "outputTokens";
type MetricRange = "1" | "7" | "14" | "30" | "120";
type ProjectSummary = DashboardData["projects"][number];
type ProjectSessionDetail = { session: Session; detail: SessionDetail };
const nav: Array<{id:View;label:string;icon:typeof Orbit}> = [
  { id: "overview", label: "Overview", icon: Orbit },
  { id: "explorer", label: "Explorer", icon: Activity },
  { id: "sessions", label: "Sessions", icon: Layers3 },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "models", label: "Models", icon: Atom },
  { id: "limits", label: "Limits & sources", icon: Gauge },
];
const palette = ["#b7f25c", "#58d9cf", "#ff9e64", "#d7b3ff", "#78a8ff", "#f2d15c"];
const defaultAccent = "#78a8ff";
const defaultProviderColors: ProviderColors = { anthropic: "#d97757", openai: "#eaeaea", warp: "#d7b3ff" };
const defaultFavoriteAccents = ["#78a8ff", "#b7f25c", "#58d9cf", "#f08bb4", "#f2d15c", "#ff786f"];
const accentStorageKey = "usage-observatory:accent";
const providerColorsStorageKey = "usage-observatory:provider-colors";
const favoriteAccentsStorageKey = "usage-observatory:favorite-accents";
const dataTextScaleStorageKey = "usage-observatory:data-text-scale";
const defaultDataTextScale = 125;

function faviconHref(accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 1.5 21 21" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2" fill="${accent}"/><circle cx="5" cy="19" r="2" fill="${accent}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function savedAccent() {
  try {
    const value = localStorage.getItem(accentStorageKey);
    return value && /^#[0-9a-f]{6}$/i.test(value) ? value : defaultAccent;
  } catch { return defaultAccent; }
}

function savedFavoriteAccents() {
  try {
    const value = JSON.parse(localStorage.getItem(favoriteAccentsStorageKey) ?? "[]");
    return Array.isArray(value) && value.length === defaultFavoriteAccents.length && value.every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) ? value : defaultFavoriteAccents;
  } catch { return defaultFavoriteAccents; }
}

function savedProviderColors(): ProviderColors {
  try {
    const value = JSON.parse(localStorage.getItem(providerColorsStorageKey) ?? "{}");
    return {
      anthropic: typeof value.anthropic === "string" && /^#[0-9a-f]{6}$/i.test(value.anthropic) ? value.anthropic : defaultProviderColors.anthropic,
      openai: typeof value.openai === "string" && /^#[0-9a-f]{6}$/i.test(value.openai) ? value.openai : defaultProviderColors.openai,
      warp: typeof value.warp === "string" && /^#[0-9a-f]{6}$/i.test(value.warp) ? value.warp : defaultProviderColors.warp,
    };
  } catch { return defaultProviderColors; }
}

function savedDataTextScale() {
  try {
    const value = Number(localStorage.getItem(dataTextScaleStorageKey));
    return Number.isFinite(value) && value >= 90 && value <= 150 ? value : defaultDataTextScale;
  } catch { return defaultDataTextScale; }
}

function initialView(): View {
  const value = new URLSearchParams(window.location.search).get("view");
  return nav.some((item) => item.id === value) ? value as View : "overview";
}

function initialSessionId() {
  return new URLSearchParams(window.location.search).get("session");
}

function sessionHref(sessionId: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", "sessions");
  url.searchParams.set("session", sessionId);
  return `${url.pathname}${url.search}`;
}

const sceneEffectsStorageKey = "usage-observatory:scene-effects";
const defaultSceneEffects: SceneEffects = { starfield: true, parallax: true, twinkle: false, speed: 0.3, starDensity: 3 };

function savedSceneEffects(): SceneEffects {
  try {
    const value = JSON.parse(localStorage.getItem(sceneEffectsStorageKey) ?? "");
    const speed = Number(value.speed);
    const starDensity = Number(value.starDensity);
    return {
      starfield: value.starfield !== false, parallax: value.parallax !== false, twinkle: value.twinkle === true,
      speed: Number.isFinite(speed) && speed >= 0.1 && speed <= 3 ? speed : defaultSceneEffects.speed,
      starDensity: Number.isInteger(starDensity) && starDensity >= 1 && starDensity <= 6 ? starDensity : defaultSceneEffects.starDensity,
    };
  } catch { return defaultSceneEffects; }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

const formatCompact = (value: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const formatMoney = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const friendlyProject = (value: string) => value.startsWith("/") ? value.split("/").filter(Boolean).at(-1) ?? value : value.replace(/^-Users-[^-]+-/, "").replaceAll("-", " / ");
const providerSeries = [
  { key: "anthropic", label: "Claude", color: "var(--anthropic-color)" },
  { key: "codex", label: "Codex", color: "var(--openai-color)" },
  { key: "warp", label: "Warp", color: "var(--warp-color)" },
] as const;
const stackedProviderSeries = [...providerSeries].reverse();

function providerKey(agent: string) {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("warp")) return "warp";
  return null;
}

function resetCopy(timestamp: number | null, verb = "resets") {
  if (!timestamp || !Number.isFinite(timestamp)) return `${verb} time unavailable`;
  const delta = timestamp - Date.now();
  const absolute = new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (delta <= 0) return `expired · was due ${absolute}`;
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const countdown = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
  return `${verb} in ${countdown} · ${absolute}`;
}

function expiryCopy(timestamp: string | null) {
  if (!timestamp) return { text: "no expiry reported", urgent: false };
  const expiresAt = Date.parse(timestamp);
  if (!Number.isFinite(expiresAt)) return { text: "expiry time unavailable", urgent: false };
  const delta = expiresAt - Date.now();
  const absolute = new Date(expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (delta <= 0) return { text: `expired · was due ${absolute}`, urgent: false };
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const countdown = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
  return { text: `expires in ${countdown} · ${absolute}`, urgent: delta <= 24 * 60 * 60 * 1_000 };
}

function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      if (refresh) await fetch("/api/refresh", { method: "POST" });
      const response = await fetch("/api/dashboard");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setData(await response.json());
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60_000); return () => clearInterval(timer); }, []);
  return { data, error, loading, load };
}

function selectAgent(row: MetricRow, agent: string): MetricRow | null {
  if (agent === "all") return row;
  const selected = row.agents?.find((item) => item.agent === agent);
  return selected ? { ...selected, period: row.period } : null;
}

function MetricCard({ eyebrow, value, detail, trend, trendUnit = "%", icon: Icon }: {eyebrow:string;value:string;detail:string;trend?:number;trendUnit?:"%"|"pp";icon:typeof Orbit}) {
  return <article className="metric-card">
    <div className="metric-card__top"><span>{eyebrow}</span><Icon size={16} /></div>
    <strong aria-live="polite">{value}</strong>
    <div className="metric-detail"><span>{detail}</span>{trend !== undefined && <span className={trend >= 0 ? "trend-up" : "trend-down"}>{trend >= 0 ? <ArrowUpRight /> : <ArrowDownRight />}{Math.abs(trend)}{trendUnit}</span>}</div>
  </article>;
}

function ChartTooltip({ active, payload, label, metric }: any) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><span>{label}</span>{payload.map((item:any) => <div key={item.dataKey}><i style={{background:item.color}} />{item.name}: <b>{metric === "totalCost" ? formatMoney(item.value) : formatCompact(item.value)}</b></div>)}</div>;
}

function useClampedTooltip(active: boolean, coordinate?: {x?: number}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tooltip = ref.current;
    const chart = tooltip?.closest(".recharts-wrapper");
    const wrapper = tooltip?.parentElement;
    if (!active || !tooltip || !(chart instanceof HTMLElement) || !wrapper || typeof coordinate?.x !== "number") return;

    const chartBounds = chart.getBoundingClientRect();
    const edgePadding = 8;
    tooltip.style.setProperty("--tooltip-width", `${Math.max(0, Math.min(410, chartBounds.width - edgePadding * 2))}px`);
    const wrapperBounds = wrapper.getBoundingClientRect();
    const centeredOffset = chartBounds.left + coordinate.x - wrapperBounds.left - tooltip.offsetWidth / 2;
    tooltip.style.setProperty("--tooltip-x", `${centeredOffset}px`);

    const tooltipBounds = tooltip.getBoundingClientRect();
    const leftBoundary = Math.max(chartBounds.left, 0) + edgePadding;
    const rightBoundary = Math.min(chartBounds.right, window.innerWidth) - edgePadding;
    const shift = tooltipBounds.left < leftBoundary
      ? leftBoundary - tooltipBounds.left
      : tooltipBounds.right > rightBoundary
        ? rightBoundary - tooltipBounds.right
        : 0;
    tooltip.style.setProperty("--tooltip-x", `${centeredOffset + shift}px`);
  });
  return ref;
}

function tooltipModels(row: any, provider: typeof providerSeries[number]["key"]) {
  return (row?.models?.[provider] ?? []) as Array<{ name: string; tokens: number; cost: number }>;
}

type TooltipProject = {
  projectId: string;
  projectName: string;
  tokens: number;
  cost: number;
  providers: ProjectActivity[];
};

function tooltipProjects(row: any): TooltipProject[] {
  const projects = new Map<string, TooltipProject>();
  const groups = (row?.projectGroups ?? {}) as Record<string,ProjectActivity[]>;
  Object.values(groups).flat().forEach((activity) => {
    const project = projects.get(activity.projectId) ?? {projectId:activity.projectId,projectName:activity.projectName,tokens:0,cost:0,providers:[]};
    project.tokens += activity.tokens;
    project.cost += activity.cost;
    project.providers.push(activity);
    projects.set(activity.projectId, project);
  });
  return [...projects.values()].map((project) => ({
    ...project,
    providers: project.providers.sort((a, b) => providerSeries.findIndex((provider) => provider.key === a.provider) - providerSeries.findIndex((provider) => provider.key === b.provider)),
  })).sort((a, b) => b.tokens - a.tokens);
}

function ProviderChartTooltip({ active, payload, label, coordinate }: any) {
  const tooltipRef = useClampedTooltip(Boolean(active), coordinate);
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  const projects = tooltipProjects(row);
  const visibleProjects = projects.slice(0, 4);
  const projectTotal = projects.reduce((sum, project) => sum + project.tokens, 0);
  const projectCost = projects.reduce((sum, project) => sum + project.cost, 0);
  return <div className="chart-tooltip provider-tooltip" key={label} ref={tooltipRef}>
    <div className="tooltip-columns"><span>{label}</span><small>Tokens</small><small>API $</small></div>
    {providerSeries.map((provider) => payload.find((item:any) => item.dataKey === provider.key)).filter((item:any) => item?.value > 0).map((item:any) => {
      const models = tooltipModels(row, item.dataKey);
      const visibleModels = models.slice(0, 3);
      return <section className="tooltip-provider" key={item.dataKey}>
        <div className="tooltip-provider__head"><i style={{background:item.color}} /><strong>{item.name}</strong><b>{formatCompact(item.value)}</b><b>{formatMoney(row?.costs?.[item.dataKey] ?? 0)}</b></div>
        {visibleModels.length > 0 && <ul className="tooltip-provider-models">{visibleModels.map((model) => <li key={model.name}><span>{model.name}</span><b>{formatCompact(model.tokens)}</b><b>{formatMoney(model.cost)}</b></li>)}</ul>}
        {models.length > visibleModels.length && <small className="tooltip-more-row tooltip-model-more"><span>+{models.length - visibleModels.length} more</span><b>{formatCompact(models.slice(3).reduce((sum, model) => sum + model.tokens, 0))}</b><b>{formatMoney(models.slice(3).reduce((sum, model) => sum + model.cost, 0))}</b></small>}
      </section>;
    })}
    {visibleProjects.length > 0 && <section className="tooltip-projects">
      <div className="tooltip-projects__head"><strong>Projects</strong><b>{formatCompact(projectTotal)}</b><b>{formatMoney(projectCost)}</b></div>
      <ol className="tooltip-project-list">{visibleProjects.map((project) => <li key={project.projectId}>
        <div className="tooltip-project-row"><span>{project.projectName}</span><b>{formatCompact(project.tokens)}</b><b>{formatMoney(project.cost)}</b></div>
        <div className="tooltip-project-providers">{project.providers.map((providerActivity) => {
          const provider = providerSeries.find((item) => item.key === providerActivity.provider)!;
          const visibleModels = providerActivity.models.slice(0, 3);
          return <section key={providerActivity.provider}>
            <div className="tooltip-project-provider"><i style={{background:provider.color}}/><span>{provider.label}</span><b>{formatCompact(providerActivity.tokens)}</b><b>{formatMoney(providerActivity.cost)}</b></div>
            {visibleModels.length > 0 && <ul className="tooltip-project-models">{visibleModels.map((model) => <li key={model.model}><span>{model.model}</span><b>{formatCompact(model.tokens)}</b><b>{formatMoney(model.cost)}</b></li>)}</ul>}
            {providerActivity.models.length > visibleModels.length && <small className="tooltip-more-row tooltip-model-more project"><span>+{providerActivity.models.length - visibleModels.length} more</span><b>{formatCompact(providerActivity.models.slice(3).reduce((sum, model) => sum + model.tokens, 0))}</b><b>{formatMoney(providerActivity.models.slice(3).reduce((sum, model) => sum + model.cost, 0))}</b></small>}
          </section>;
        })}</div>
      </li>)}</ol>
      {projects.length > visibleProjects.length && <small className="tooltip-more-row tooltip-project-more"><span>+{projects.length - visibleProjects.length} more projects</span><b>{formatCompact(projects.slice(4).reduce((sum, project) => sum + project.tokens, 0))}</b><b>{formatMoney(projects.slice(4).reduce((sum, project) => sum + project.cost, 0))}</b></small>}
    </section>}
  </div>;
}

function metricRangeRows(rows: MetricRow[], range: MetricRange, periodOffset = 0) {
  if (!rows.length) return [];
  const days = Number(range);
  const sorted = [...rows].sort((a, b) => a.period.localeCompare(b.period));
  const latest = new Date(`${sorted.at(-1)!.period}T12:00:00`);
  const end = new Date(latest);
  end.setDate(end.getDate() - days * periodOffset);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  const toPeriod = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const startPeriod = toPeriod(start);
  const endPeriod = toPeriod(end);
  return sorted.filter((row) => row.period >= startPeriod && row.period <= endPeriod);
}

function sessionDate(session: Session) {
  const lastActivity = session.metadata?.lastActivity;
  if (typeof lastActivity === "string") {
    const date = new Date(lastActivity);
    if (Number.isFinite(date.getTime())) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
  }
  const match = session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function metricTotals(rows: MetricRow[]) {
  return rows.reduce((sum, row) => ({ tokens: sum.tokens + row.totalTokens, cost: sum.cost + row.totalCost, output: sum.output + row.outputTokens, cache: sum.cache + row.cacheReadTokens }), {tokens:0,cost:0,output:0,cache:0});
}

function modelDistribution(rows: MetricRow[], metric: Metric) {
  const models = new Map<string, {tokens:number;cost:number;outputTokens:number}>();
  rows.forEach((row) => {
    const sources = row.agents?.length ? row.agents : [row];
    sources.forEach((source) => source.modelBreakdowns.forEach((model) => {
      const current = models.get(model.modelName) ?? {tokens:0,cost:0,outputTokens:0};
      current.tokens += model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
      current.cost += model.cost;
      current.outputTokens += model.outputTokens;
      models.set(model.modelName, current);
    }));
  });
  const key = metric === "totalCost" ? "cost" : metric === "outputTokens" ? "outputTokens" : "tokens";
  return [...models.entries()]
    .map(([name, values]) => ({name:name.replace(/^claude-|^gpt-/, ""), value:values[key]}))
    .sort((a, b) => b.value - a.value);
}

function combineMetricRows(rows: MetricRow[], agent: string, period: string): MetricRow {
  const models = new Map<string, ModelBreakdown>();
  const totals = rows.reduce((total, row) => {
    row.modelBreakdowns.forEach((model) => {
      const current = models.get(model.modelName) ?? { modelName:model.modelName, inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheCreationTokens:0, cost:0 };
      current.inputTokens += model.inputTokens;
      current.outputTokens += model.outputTokens;
      current.cacheReadTokens += model.cacheReadTokens;
      current.cacheCreationTokens += model.cacheCreationTokens;
      current.cost += model.cost;
      models.set(model.modelName, current);
    });
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cacheCreationTokens += row.cacheCreationTokens;
    total.totalTokens += row.totalTokens;
    total.totalCost += row.totalCost;
    return total;
  }, { inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheCreationTokens:0, totalTokens:0, totalCost:0 });
  return { agent, period, ...totals, modelsUsed:[...models.keys()], modelBreakdowns:[...models.values()] };
}

function pathFilteredRows(sessions: Session[], periods: Set<string>) {
  const sessionsByPeriod = new Map<string, Session[]>();
  sessions.forEach((session) => {
    if (!periods.has(session.period)) return;
    sessionsByPeriod.set(session.period, [...(sessionsByPeriod.get(session.period) ?? []), session]);
  });
  return [...sessionsByPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, daySessions]) => {
    const agents = [...new Set(daySessions.map((session) => session.agent))]
      .map((agent) => combineMetricRows(daySessions.filter((session) => session.agent === agent), agent, period));
    return { ...combineMetricRows(daySessions, "all", period), agents };
  });
}

function percentChange(current: number, previous: number) {
  return previous > 0 ? Math.round((current - previous) / previous * 100) : undefined;
}

function ProviderTimeline({ rows, projectActivity, activeProvider }: {rows:MetricRow[];projectActivity:ProjectActivity[];activeProvider:typeof providerSeries[number]["key"]|null}) {
  const projectsByDay = new Map<string, Record<string,ProjectActivity[]>>();
  projectActivity.forEach((project) => {
    if (activeProvider && project.provider !== activeProvider) return;
    const day = projectsByDay.get(project.date) ?? {};
    day[project.provider] = [...(day[project.provider] ?? []), project];
    projectsByDay.set(project.date, day);
  });
  const data = rows.map((row) => {
    const values = { anthropic: 0, codex: 0, warp: 0 };
    const costs = { anthropic: 0, codex: 0, warp: 0 };
    const modelMaps = { anthropic: new Map<string, {tokens:number;cost:number}>(), codex: new Map<string, {tokens:number;cost:number}>(), warp: new Map<string, {tokens:number;cost:number}>() };
    if (row.agents?.length) {
      row.agents.forEach((item) => {
        const key = providerKey(item.agent);
        if (!key) return;
        values[key] += item.totalTokens;
        costs[key] += item.totalCost;
        item.modelBreakdowns.forEach((model) => {
          const total = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
          const current = modelMaps[key].get(model.modelName) ?? {tokens:0,cost:0};
          current.tokens += total;
          current.cost += model.cost;
          modelMaps[key].set(model.modelName, current);
        });
      });
    } else {
      const key = providerKey(row.agent);
      if (key) {
        values[key] = row.totalTokens;
        costs[key] = row.totalCost;
        row.modelBreakdowns.forEach((model) => {
          const total = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
          const current = modelMaps[key].get(model.modelName) ?? {tokens:0,cost:0};
          current.tokens += total;
          current.cost += model.cost;
          modelMaps[key].set(model.modelName, current);
        });
      }
    }
    const models = Object.fromEntries(Object.entries(modelMaps).map(([provider, entries]) => [provider, [...entries.entries()].map(([name, values]) => ({name, ...values})).sort((a, b) => b.tokens - a.tokens)]));
    const projectGroups = projectsByDay.get(row.period) ?? {};
    return { ...values, costs, models, projectGroups, label: new Date(`${row.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  });
  const totals = providerSeries.map((provider) => ({ ...provider, value: data.reduce((sum, row) => sum + row[provider.key], 0) }));
  return <>
    <div className="provider-legend" aria-label="Activity providers">{totals.map((provider) => <div key={provider.key}><i style={{background:provider.color}}/><span>{provider.label}</span><b>{formatCompact(provider.value)}</b></div>)}</div>
    <div className="chart-wrap provider-chart" aria-label="Token usage by day, split into Claude, Codex, and Warp sections" role="img">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, left: -18, bottom: 0 }}>
          <defs>{providerSeries.map((provider) => <linearGradient key={provider.key} id={`${provider.key}Area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={provider.color} stopOpacity={0.58}/><stop offset="100%" stopColor={provider.color} stopOpacity={0.13}/></linearGradient>)}</defs>
          <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
          <XAxis dataKey="label" tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false} minTickGap={30}/>
          <YAxis tickFormatter={formatCompact} tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false}/>
          <Tooltip content={<ProviderChartTooltip/>} cursor={{stroke:"#71807b",strokeDasharray:"3 3"}} offset={0} isAnimationActive={false} wrapperStyle={{transition:"none"}}/>
          {stackedProviderSeries.map((provider) => <Area key={provider.key} type="monotone" dataKey={provider.key} name={provider.label} stackId="providers" stroke={provider.color} strokeWidth={1.8} fill={`url(#${provider.key}Area)`} activeDot={{r:4,fill:"#07100f",stroke:provider.color,strokeWidth:2}}/>)}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  </>;
}

function localPeriod(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function HourlyProviderTimeline({ date, sessions }: {date:string;sessions:Session[]}) {
  const data = Array.from({length:24}, (_, hour) => ({
    anthropic: 0,
    codex: 0,
    warp: 0,
    costs: { anthropic: 0, codex: 0, warp: 0 },
    models: { anthropic: [] as Array<{name:string;tokens:number;cost:number}>, codex: [] as Array<{name:string;tokens:number;cost:number}>, warp: [] as Array<{name:string;tokens:number;cost:number}> },
    modelMaps: { anthropic: new Map<string,{tokens:number;cost:number}>(), codex: new Map<string,{tokens:number;cost:number}>(), warp: new Map<string,{tokens:number;cost:number}>() },
    projectGroups: {} as Record<string,ProjectActivity[]>,
    projectMaps: {
      anthropic: new Map<string,{projectId:string;projectName:string;tokens:number;cost:number;sessions:number;models:Map<string,{tokens:number;cost:number}>}>(),
      codex: new Map<string,{projectId:string;projectName:string;tokens:number;cost:number;sessions:number;models:Map<string,{tokens:number;cost:number}>}>(),
    },
    label: new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {hour:"numeric"}),
  }));
  sessions.forEach((session) => {
    const activity = session.metadata?.lastActivity;
    if (typeof activity !== "string" || localPeriod(activity) !== date) return;
    const timestamp = new Date(activity);
    const provider = providerKey(session.agent);
    if (!provider) return;
    const bucket = data[timestamp.getHours()];
    bucket[provider] += session.totalTokens;
    bucket.costs[provider] += session.totalCost;
    session.modelBreakdowns.forEach((model) => {
      const tokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
      const current = bucket.modelMaps[provider].get(model.modelName) ?? {tokens:0,cost:0};
      current.tokens += tokens;
      current.cost += model.cost;
      bucket.modelMaps[provider].set(model.modelName, current);
    });
    if (session.cwd && provider !== "warp") {
      const projectId = session.cwd.replace(/\/+$/, "");
      const project = bucket.projectMaps[provider].get(projectId) ?? {projectId,projectName:projectId.split("/").at(-1) ?? projectId,tokens:0,cost:0,sessions:0,models:new Map<string,{tokens:number;cost:number}>()};
      project.tokens += session.totalTokens;
      project.cost += session.totalCost;
      project.sessions++;
      session.modelBreakdowns.forEach((model) => {
        const tokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
        const current = project.models.get(model.modelName) ?? {tokens:0,cost:0};
        current.tokens += tokens;
        current.cost += model.cost;
        project.models.set(model.modelName, current);
      });
      bucket.projectMaps[provider].set(projectId, project);
    }
  });
  data.forEach((bucket) => providerSeries.forEach((provider) => {
    bucket.models[provider.key] = [...bucket.modelMaps[provider.key].entries()].map(([name, values]) => ({name,...values})).sort((a,b) => b.tokens - a.tokens);
  }));
  data.forEach((bucket) => (["anthropic", "codex"] as const).forEach((provider) => {
    bucket.projectGroups[provider] = [...bucket.projectMaps[provider].values()].map((project) => ({
      ...project,
      provider,
      date,
      models: [...project.models.entries()].map(([model, values]) => ({model,...values})).sort((a,b) => b.tokens - a.tokens),
    })).sort((a,b) => b.tokens - a.tokens);
  }));
  const totals = providerSeries.map((provider) => ({...provider,value:data.reduce((sum,bucket)=>sum+bucket[provider.key],0)}));
  return <>
    <div className="provider-legend" aria-label="Activity providers">{totals.map((provider) => <div key={provider.key}><i style={{background:provider.color}}/><span>{provider.label}</span><b>{formatCompact(provider.value)}</b></div>)}</div>
    <div className="chart-wrap provider-chart" aria-label="Session token usage by last activity hour, split into Claude, Codex, and Warp sections" role="img">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{top:10,right:8,left:-18,bottom:0}}>
          <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
          <XAxis dataKey="label" interval={2} tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false}/>
          <YAxis tickFormatter={formatCompact} tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false}/>
          <Tooltip content={<ProviderChartTooltip/>} cursor={{fill:"#15211d"}} offset={0} isAnimationActive={false} wrapperStyle={{transition:"none"}}/>
          {stackedProviderSeries.map((provider) => <Bar key={provider.key} dataKey={provider.key} name={provider.label} stackId="providers" fill={provider.color} maxBarSize={26}/>) }
        </BarChart>
      </ResponsiveContainer>
    </div>
  </>;
}

type QuotaState = "ok" | "stale" | "suspended" | "unavailable" | "expired";
type QuotaBucket = {
  id: string;
  windowLabel: string;
  usedPercent: number | null;
  resetAt: number | null;
  resetVerb: "resets" | "renews";
  state: QuotaState;
  detail: string;
  historyWindow?: "fiveHour" | "weekly";
  reachedCount?: number;
};

type QuotaCard = {
  provider: "anthropic" | "codex" | "warp";
  providerLabel: string;
  state: QuotaState;
  buckets: QuotaBucket[];
  bankedResets: Array<{ id: string; title: string; expiresAt: string | null }>;
  usedResetCount: number;
};

function quotaBucket(id: string, windowLabel: string, usedPercent: number | null, resetAt: number | null, resetVerb: "resets" | "renews", reportStatus: string | undefined, detail?: string, suspended = false, historyWindow?: "fiveHour" | "weekly", reachedCount?: number): QuotaBucket {
  const hasValue = usedPercent !== null && Number.isFinite(usedPercent);
  const expired = hasValue && resetAt !== null && resetAt <= Date.now();
  const state = suspended ? "suspended" : reportStatus === "unavailable" || reportStatus === "unknown" || !hasValue ? "unavailable" : expired ? "expired" : reportStatus === "stale" ? "stale" : "ok";
  return { id, windowLabel, usedPercent, resetAt, resetVerb, state, detail: detail ?? (hasValue ? `${Math.max(0, 100 - usedPercent).toFixed(0)}% available` : suspended ? "temporarily suspended" : "not currently reported"), historyWindow, reachedCount };
}

function quotaCards(quotas: DashboardData["quotas"]): QuotaCard[] {
  const reports = new Map(quotas.usage?.providers.map((provider) => [provider.provider, provider]) ?? []);
  const reachedCount = (provider: "codex" | "anthropic", window: "fiveHour" | "weekly") => quotas.history?.windows.find((item) => item.provider === provider && item.window === window)?.reachedCount;
  const anthropic = reports.get("anthropic");
  const anthropicSnapshot = anthropic?.snapshot?.kind === "window" ? anthropic.snapshot : null;
  const anthropicBuckets = [
    quotaBucket("anthropic-five-hour", "5-hour", anthropicSnapshot?.fiveHour?.usedPercent ?? null, anthropicSnapshot?.fiveHour?.resetsAt ?? null, "resets", anthropic?.status, anthropic?.error, false, "fiveHour", reachedCount("anthropic", "fiveHour")),
    quotaBucket("anthropic-weekly", "Weekly", anthropicSnapshot?.weekly?.usedPercent ?? null, anthropicSnapshot?.weekly?.resetsAt ?? null, "resets", anthropic?.status, anthropic?.error, false, "weekly", reachedCount("anthropic", "weekly")),
    ...Object.entries(anthropicSnapshot?.modelWindows ?? {}).map(([model, window]) => quotaBucket(`anthropic-${model}`, `${model} bucket`, window.usedPercent, window.resetsAt, "resets", anthropic?.status)),
  ];
  const codex = reports.get("codex");
  const codexSnapshot = codex?.snapshot?.kind === "window" ? codex.snapshot : null;
  const codexBuckets = [
    quotaBucket("codex-five-hour", "5-hour", codexSnapshot?.fiveHour?.usedPercent ?? null, codexSnapshot?.fiveHour?.resetsAt ?? null, "resets", codex?.status, codex?.error, Boolean(codexSnapshot && !codexSnapshot.fiveHour), "fiveHour", reachedCount("codex", "fiveHour")),
    quotaBucket("codex-weekly", "Weekly", codexSnapshot?.weekly?.usedPercent ?? null, codexSnapshot?.weekly?.resetsAt ?? null, "resets", codex?.status, codex?.error, false, "weekly", reachedCount("codex", "weekly")),
  ];
  const warp = reports.get("warp");
  const pool = warp?.snapshot?.kind === "pool" ? warp.snapshot.pool : null;
  const warpBuckets = [quotaBucket("warp-monthly", pool?.cadence ?? "Monthly", pool?.usedPercent ?? null, pool?.refreshesAt ?? null, "renews", warp?.status, pool ? `${pool.used.toLocaleString()} / ${pool.limit.toLocaleString()} requests` : warp?.error)];
  const banked = quotas.resets?.codexBankedResetCredits;
  const bankedResets = banked?.credits.filter((credit) => credit.status === "available").map(({id, title, expiresAt}) => ({id, title, expiresAt})) ?? [];
  return [
    { provider: "anthropic", providerLabel: "Anthropic", state: anthropic?.status === "ok" ? "ok" : anthropic?.status === "stale" ? "stale" : "unavailable", buckets: anthropicBuckets, bankedResets: [], usedResetCount: 0 },
    { provider: "codex", providerLabel: "OpenAI", state: codex?.status === "ok" ? "ok" : codex?.status === "stale" ? "stale" : "unavailable", buckets: codexBuckets, bankedResets, usedResetCount: quotas.history?.codexBankedResets.usedCount ?? 0 },
    { provider: "warp", providerLabel: "Warp", state: warp?.status === "ok" ? "ok" : warp?.status === "stale" ? "stale" : "unavailable", buckets: warpBuckets, bankedResets: [], usedResetCount: 0 },
  ];
}

function QuotaDials({ quotas }: {quotas: DashboardData["quotas"]}) {
  const cards = quotaCards(quotas);
  const trackingSince = quotas.history?.trackingSince ? new Date(quotas.history.trackingSince).toLocaleDateString(undefined, {month:"short",day:"numeric"}) : null;
  return <section className="quota-panel panel">
    <div className="panel-heading"><div><span className="overline">SUBSCRIPTION WINDOWS</span><h2>Usage & resets</h2></div><div className="quota-heading-meta">{trackingSince&&<span>History since {trackingSince}</span>}{quotas.history?.available&&<span className="method-chip local"><i/> locally counted</span>}<span className="method-chip"><i/> provider reported</span></div></div>
    <div className="quota-grid">{cards.map((card) => {
      const stateLabel = card.state === "ok" ? "current" : card.state;
      return <article className={`quota-card ${card.provider} ${card.state}`} key={card.provider}>
        <div className="quota-card__head"><span>{card.providerLabel}</span><i>{stateLabel}</i></div>
        <div className="quota-buckets">{card.buckets.map((bucket) => {
          const percent = bucket.usedPercent === null ? null : Math.max(0, Math.min(100, bucket.usedPercent));
          return <div className={`quota-bucket ${bucket.state}`} key={bucket.id} aria-label={`${card.providerLabel} ${bucket.windowLabel}: ${percent === null ? bucket.state : `${percent.toFixed(0)}% used`}`}>
            <div className="quota-dial" style={{"--used":`${percent ?? 0}%`} as React.CSSProperties}><div><strong>{percent === null ? "—" : `${percent.toFixed(0)}%`}</strong><span>{percent === null ? bucket.state : "used"}</span></div></div>
            <div className="quota-bucket__copy">
              <div className="quota-bucket__top"><b>{bucket.windowLabel}</b><span>{percent === null ? bucket.state : bucket.detail}</span></div>
              <small>{bucket.state === "suspended" ? "Rate limit temporarily suspended" : resetCopy(bucket.resetAt, bucket.resetVerb)}</small>
              {bucket.historyWindow&&<div className="quota-history"><span>Quota reached</span><b>{bucket.reachedCount === undefined ? "Not tracked" : `${bucket.reachedCount}× observed`}</b></div>}
            </div>
          </div>;
        })}</div>
        {card.provider === "codex" && <div className="banked-resets"><div><span>Banked resets</span><b>{card.bankedResets.length} available</b></div><div className="reset-use"><span>Resets used</span><b>{quotas.history?.available ? `${card.usedResetCount} observed` : "Not tracked"}</b></div>{card.bankedResets.map((credit) => {
          const expiry = expiryCopy(credit.expiresAt);
          return <small className={expiry.urgent ? "expiring-soon" : undefined} key={credit.id}><Sparkles/> {credit.title} · {expiry.text}</small>;
        })}</div>}
      </article>;
    })}</div>
  </section>;
}

function Overview({ data, daily, sessions, agent, metricRange, onMetricRangeChange, onSession, accent, providerColors, sceneEffects }: {data:DashboardData;daily:MetricRow[];sessions:Session[];agent:string;metricRange:MetricRange;onMetricRangeChange:(range:MetricRange)=>void;onSession:(session:Session)=>void;accent:string;providerColors:ProviderColors;sceneEffects:SceneEffects}) {
  const totals = metricTotals(daily);
  const previousDaily = metricRangeRows(data.daily, metricRange, 1).map((row) => selectAgent(row, agent)).filter(Boolean) as MetricRow[];
  const previousTotals = metricTotals(previousDaily);
  const activeBlock = data.blocks.find((block) => block.isActive) ?? data.blocks.at(-1);
  const agentTotals = new Map<string, number>();
  data.daily.slice(-30).forEach((row) => row.agents?.forEach((item) => agentTotals.set(item.agent, (agentTotals.get(item.agent) ?? 0) + item.totalTokens)));
  const agentChart = [...agentTotals.entries()].map(([name, value]) => ({name,value}));
  const agentGrandTotal = agentChart.reduce((sum, item) => sum + item.value, 0);
  const recent = sessions.slice(0, 5);
  const cacheShare = totals.tokens ? Math.round(totals.cache / totals.tokens * 100) : 0;
  const previousCacheShare = previousTotals.tokens ? Math.round(previousTotals.cache / previousTotals.tokens * 100) : 0;
  const rangeLabel = metricRange === "1" ? "Latest day" : `Last ${metricRange} days`;
  const periodLabel = daily.length === 1
    ? new Date(`${daily[0].period}T12:00:00`).toLocaleDateString(undefined, {month:"short",day:"numeric",year:"numeric"})
    : daily.length > 1
      ? `${new Date(`${daily[0].period}T12:00:00`).toLocaleDateString(undefined, {month:"short",day:"numeric"})}–${new Date(`${daily.at(-1)!.period}T12:00:00`).toLocaleDateString(undefined, {month:"short",day:"numeric",year:"numeric"})}`
      : "No activity in this span";
  return <div className="view-stack page-enter">
    <section className="hero-grid">
      <div>
        <p className="kicker"><span /> LIVE LOCAL TELEMETRY</p>
        <h1>Your AI Usage <em>Observatory.</em></h1>
        <p className="hero-copy">A local-first view of where agent time, tokens, and estimated API-equivalent cost are going.</p>
      </div>
      <OrbitalScene accent={accent} effects={sceneEffects} providerColors={providerColors} headroom={providerHeadroom(data.quotas)}/>
    </section>
    <QuotaDials quotas={data.quotas}/>
    <section className="metric-summary" aria-labelledby="metric-summary-title">
      <div className="metric-summary__heading">
        <div><span className="overline">SUMMARY & TRAJECTORY</span><h2 id="metric-summary-title">{rangeLabel}</h2><p>{periodLabel} · card trends compare with the previous equal span</p></div>
        <div className="metric-range"><span>Time span</span><Segmented label="Summary and trajectory time span" value={metricRange} onChange={(value)=>onMetricRangeChange(value as MetricRange)} options={[{value:"1",label:"1 day"},{value:"7",label:"7 days"},{value:"14",label:"14 days"},{value:"30",label:"30 days"},{value:"120",label:"120 days"}]}/></div>
      </div>
      <div className="metric-grid">
        <MetricCard eyebrow="TOTAL TOKENS" value={formatCompact(totals.tokens)} detail={`${daily.length} active ${daily.length === 1 ? "day" : "days"}`} trend={percentChange(totals.tokens, previousTotals.tokens)} icon={Zap}/>
        <MetricCard eyebrow="API-EQUIVALENT COST" value={formatMoney(totals.cost)} detail="ccusage · offline pricing" trend={percentChange(totals.cost, previousTotals.cost)} icon={CircleDollarSign}/>
        <MetricCard eyebrow="OUTPUT TOKENS" value={formatCompact(totals.output)} detail={`${totals.tokens ? Math.round(totals.output / totals.tokens * 100) : 0}% of period tokens`} trend={percentChange(totals.output, previousTotals.output)} icon={Sparkles}/>
        <MetricCard eyebrow="CACHE SHARE" value={`${cacheShare}%`} detail={`${formatCompact(totals.cache)} read tokens`} trend={previousTotals.tokens ? cacheShare - previousCacheShare : undefined} trendUnit="pp" icon={Database}/>
      </div>
      <article className="panel usage-trajectory-panel">
        <div className="panel-heading"><div><span className="overline">USAGE TRAJECTORY</span><h2>Activity</h2>{metricRange === "1" && <p>Sessions grouped by their last recorded activity hour.</p>}</div><span className="method-chip"><i/> ccusage derived</span></div>
        {metricRange === "1" && daily.length === 1
          ? <HourlyProviderTimeline date={daily[0].period} sessions={sessions}/>
          : <ProviderTimeline rows={daily} projectActivity={data.projectActivity} activeProvider={agent === "all" ? null : providerKey(agent)} />}
      </article>
    </section>
    <section className="dashboard-grid">
      <article className="panel block-panel">
        <div className="panel-heading"><div><span className="overline">RECENT WINDOW</span><h2>Five-hour block</h2></div><AlarmClock/></div>
        {activeBlock ? <>
          <div className="block-ring" style={{"--progress": `${Math.min(100, activeBlock.totalTokens / 1_000_000 * 100)}%`} as any}><div><strong>{formatCompact(activeBlock.totalTokens)}</strong><span>tokens</span></div></div>
          <div className="block-stats"><div><span>Cost</span><b>{formatMoney(activeBlock.costUSD)}</b></div><div><span>Entries</span><b>{activeBlock.entries}</b></div><div><span>Scope</span><b>{data.blockScope}</b></div></div>
          <p className="scope-note"><Clock3/> {formatDate(activeBlock.startTime)} → {formatDate(activeBlock.endTime)}</p>
        </> : <Empty text="No reconstructed blocks found."/>}
      </article>
      <article className="panel agent-panel">
        <div className="panel-heading"><div><span className="overline">AGENT MIX</span><h2>Who used the context?</h2></div><Bot/></div>
        <div className="agent-mix"><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={agentChart} dataKey="value" nameKey="name" innerRadius={51} outerRadius={68} stroke="none">{agentChart.map((_,i)=><Cell key={i} fill={palette[i]}/>)}</Pie></PieChart></ResponsiveContainer><span>{agentChart.length}<small>agents</small></span></div><div className="legend">{agentChart.map((item,i)=><div key={item.name}><i style={{background:palette[i]}}/><span>{item.name}</span><b>{Math.round(item.value / Math.max(1, agentGrandTotal) * 100)}%</b></div>)}</div></div>
      </article>
      <article className="panel panel-wide recent-panel">
        <div className="panel-heading"><div><span className="overline">RECENT SIGNALS</span><h2>Latest sessions</h2></div><span>{data.sessions.length} indexed</span></div>
        <div className="recent-list">{recent.map((session) => <button key={session.sessionId} onClick={() => onSession(session)}><span className={`agent-mark ${session.agent}`}>{session.agent.slice(0,1).toUpperCase()}</span><span className="session-main"><b>{session.modelsUsed.join(", ") || "Unknown model"}</b><small>{session.cwd ?? session.period}</small></span><span className="path-tags">{session.pathTags.slice(0,2).map((tag)=><i key={tag}>{tag}</i>)}</span><span className="session-metric"><b>{formatCompact(session.totalTokens)}</b><small>{formatMoney(session.totalCost)}</small></span><ChevronRight/></button>)}</div>
      </article>
    </section>
  </div>;
}

function Explorer({ data, rows, sessions, agent, pathTag, metricRange, metric, setMetric }: {data:DashboardData;rows:MetricRow[];sessions:Session[];agent:string;pathTag:string;metricRange:MetricRange;metric:Metric;setMetric:(metric:Metric)=>void}) {
  const modelData = modelDistribution(rows, metric);
  const projectActivity = useMemo(() => {
    if (pathTag === "all") return data.projectActivity;
    const projectIds = new Set(sessions.map((session) => session.cwd?.replace(/\/+$/, "")).filter(Boolean));
    return data.projectActivity.filter((activity) => projectIds.has(activity.projectId));
  }, [data.projectActivity, pathTag, sessions]);
  const rangeLabel = metricRange === "1" ? "LATEST DAY" : `${metricRange}-DAY FIELD`;
  return <div className="view-stack page-enter"><PageTitle eyebrow="ANALYTICAL WORKSPACE" title="Usage explorer" description="Brush the timeline to focus a period. Global agent and path filters stay linked across the workspace."/>
    <section className="panel explorer-main usage-trajectory-panel"><div className="panel-heading"><div><span className="overline">{rangeLabel}</span><h2>Activity by provider</h2>{metricRange === "1" && <p>Sessions grouped by their last recorded activity hour.</p>}</div><span className="method-chip"><i/> ccusage derived</span></div>
      {metricRange === "1" && rows.length === 1
        ? <HourlyProviderTimeline date={rows[0].period} sessions={sessions}/>
        : <ProviderTimeline rows={rows} projectActivity={projectActivity} activeProvider={agent === "all" ? null : providerKey(agent)} />}
    </section>
    <section className="split-grid"><article className="panel"><div className="panel-heading"><div><span className="overline">MODEL DISTRIBUTION</span><h2>Model signals</h2></div><Segmented value={metric} onChange={(v)=>setMetric(v as Metric)} options={[{value:"totalTokens",label:"Tokens"},{value:"totalCost",label:"Cost"},{value:"outputTokens",label:"Output"}]}/></div><div className="bar-chart" style={{height:Math.max(290, modelData.length * 34 + 28)}}><ResponsiveContainer width="100%" height="100%"><BarChart data={modelData} layout="vertical" margin={{left:10,right:16}}><CartesianGrid stroke="#26312e" horizontal={false}/><XAxis type="number" hide/><YAxis type="category" dataKey="name" width={100} tick={{fill:"#a8b5b0",fontSize:12}} axisLine={false} tickLine={false}/><Tooltip content={<ChartTooltip metric={metric}/>} cursor={{fill:"#15211d"}} isAnimationActive={false} wrapperStyle={{transition:"none"}}/><Bar dataKey="value" name="Usage" fill="#58d9cf" radius={[0,6,6,0]}/></BarChart></ResponsiveContainer></div></article><article className="panel"><div className="panel-heading"><div><span className="overline">READ / CREATE / OUTPUT</span><h2>Token composition</h2></div></div><Composition rows={rows}/></article></section>
  </div>;
}

function Composition({rows}:{rows:MetricRow[]}) {
  const totals = rows.reduce((sum,row)=>({input:sum.input+row.inputTokens,output:sum.output+row.outputTokens,read:sum.read+row.cacheReadTokens,create:sum.create+row.cacheCreationTokens}),{input:0,output:0,read:0,create:0});
  const all = totals.input+totals.output+totals.read+totals.create || 1;
  const items = [{label:"Cache read",value:totals.read,color:palette[0]},{label:"Input",value:totals.input,color:palette[1]},{label:"Cache creation",value:totals.create,color:palette[2]},{label:"Output",value:totals.output,color:palette[3]}];
  return <div className="composition"><div className="composition-bar">{items.map(item=><i key={item.label} style={{width:`${item.value/all*100}%`,background:item.color}}/>)}</div>{items.map(item=><div className="composition-row" key={item.label}><i style={{background:item.color}}/><span>{item.label}</span><b>{formatCompact(item.value)}</b><small>{Math.round(item.value/all*100)}%</small></div>)}</div>;
}

function SessionDetailPanel({ session, detail, loading }: {session:Session;detail?:SessionDetail;loading:boolean}) {
  if (loading) return <div className="session-detail session-detail--loading">Reading the local session record…</div>;
  if (!detail?.available) return <div className="session-detail session-detail--empty">The indexed record is no longer available locally.</div>;
  const models = session.modelBreakdowns.length
    ? session.modelBreakdowns.map((model) => ({ modelName: model.modelName, tokens: model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens }))
    : session.modelsUsed.map((modelName) => ({ modelName, tokens: null }));
  return <div className="session-detail">
    <div className="session-detail__summary">
      <div><span>TRANSCRIPT EVENTS</span><strong>{detail.eventsRead}</strong></div>
      <div><span>TOOL CALLS</span><strong>{detail.tools.reduce((total, tool) => total + tool.count, 0)}</strong></div>
      <div><span>FILES TOUCHED</span><strong>{detail.files.length}</strong></div>
      <div className="diff-count"><span>PATCH SUMMARY</span><strong><i>+{detail.additions}</i><em>−{detail.deletions}</em></strong></div>
    </div>
    <div className="session-detail__grid">
      <section className="session-detail__section session-prompts"><div className="session-detail__head"><span className="overline">PROMPTS</span><small>{detail.prompts.length ? "Most recent first" : "No prompt events detected"}</small></div>{detail.prompts.length ? <ol>{detail.prompts.map((prompt, index) => <li key={`${index}-${prompt.slice(0, 24)}`}><pre>{prompt}</pre></li>)}</ol> : <p>Prompt text was not available in this session format.</p>}</section>
      <section className="session-detail__section"><div className="session-detail__head"><span className="overline">TOOLS</span><small>{detail.tools.length ? "Observed calls" : "No tool calls detected"}</small></div>{detail.tools.length ? <ul className="tool-list">{detail.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code><b>×{tool.count}</b></li>)}</ul> : <p>No structured tool calls were found.</p>}</section>
      <section className="session-detail__section"><div className="session-detail__head"><span className="overline">FILES & PATCHES</span><small>{detail.files.length ? `${detail.files.length} files` : "No patch payload found"}</small></div>{detail.files.length ? <ul className="file-list">{detail.files.map((file) => <li key={file.path}><span className={`file-status ${file.status}`}>{file.status[0]}</span><code title={file.path}>{file.path}</code></li>)}</ul> : <p>File changes are detected from structured patch calls only.</p>}</section>
      <section className="session-detail__section"><div className="session-detail__head"><span className="overline">MODEL MIX</span><small>{models.length} model{models.length === 1 ? "" : "s"}</small></div><ul className="model-list">{models.map((model) => <li key={model.modelName}><span>{model.modelName}</span><b>{model.tokens === null ? "—" : formatCompact(model.tokens)}</b></li>)}</ul></section>
    </div>
  </div>;
}

function Sessions({sessions,onEdit,focusSessionId}:{sessions:Session[];onEdit:(session:Session)=>void;focusSessionId?:string|null}) {
  type SortKey = "activity" | "session" | "agent" | "cwd" | "tokens" | "cost";
  const [query,setQuery] = useState(""); const [page,setPage] = useState(1); const [expanded,setExpanded] = useState<string | null>(null); const [details,setDetails] = useState<Record<string,SessionDetail>>({}); const [loadingDetail,setLoadingDetail] = useState<string | null>(null); const [sort,setSort] = useState<{key:SortKey;direction:"asc"|"desc"}>({key:"activity",direction:"desc"}); const pageSize=15;
  const filtered=sessions.filter(s=>`${s.agent} ${s.modelsUsed.join(" ")} ${s.cwd} ${s.pathTags.join(" ")} ${s.annotation.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const sorted=[...filtered].sort((left,right)=>{
    const value=(session:Session):string|number=>{
      if(sort.key==="activity") return Date.parse(String(session.metadata?.lastActivity ?? "")) || 0;
      if(sort.key==="session") return session.modelsUsed[0] ?? "";
      if(sort.key==="agent") return session.agent;
      if(sort.key==="cwd") return session.cwd ?? "";
      if(sort.key==="tokens") return session.totalTokens;
      return session.totalCost;
    };
    const a=value(left),b=value(right); const comparison=typeof a==="number"&&typeof b==="number"?a-b:String(a).localeCompare(String(b));
    return sort.direction==="asc"?comparison:-comparison;
  });
  const pages=Math.max(1,Math.ceil(sorted.length/pageSize)); const pageRows=sorted.slice((page-1)*pageSize,page*pageSize);
  useEffect(()=>setPage(1),[query,sessions]);
  const sortBy=(key:SortKey)=>{setSort(current=>current.key===key?{key,direction:current.direction==="desc"?"asc":"desc"}:{key,direction:key==="activity"||key==="tokens"||key==="cost"?"desc":"asc"});setPage(1);};
  const toggle = async (session: Session) => {
    if (expanded === session.sessionId) return setExpanded(null);
    setExpanded(session.sessionId);
    if (details[session.sessionId]) return;
    setLoadingDetail(session.sessionId);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/detail`);
      if (!response.ok) throw new Error("Session details are unavailable");
      const detail = await response.json() as SessionDetail;
      setDetails((current) => ({ ...current, [session.sessionId]: detail }));
    } catch { setDetails((current) => ({ ...current, [session.sessionId]: { available: false, prompts: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 0 } })); }
    finally { setLoadingDetail(null); }
  };
  useEffect(()=>{
    if (!focusSessionId) return;
    const index=sorted.findIndex((session)=>session.sessionId===focusSessionId);
    if(index<0)return;
    setPage(Math.floor(index/pageSize)+1);
    if(expanded!==focusSessionId) void toggle(sorted[index]);
  },[focusSessionId]);
  const header=(key:SortKey,label:string)=><th aria-sort={sort.key===key?(sort.direction==="asc"?"ascending":"descending"):"none"}><button type="button" className={`sort-header ${sort.key===key?"active":""}`} onClick={()=>sortBy(key)}>{label}<span aria-hidden="true">{sort.key===key?(sort.direction==="asc"?"↑":"↓"):"↕"}</span></button></th>;
  return <div className="view-stack page-enter"><PageTitle eyebrow="SESSION LEDGER" title="Trace every session" description="Expand a session to inspect its locally stored prompts, tool activity, and structured patch summary. Nothing leaves this machine." actions={<label className="search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search sessions…"/></label>}/><section className="panel table-panel"><div className="table-scroll"><table><thead><tr>{header("activity","Last activity")}{header("session","Session")}{header("agent","Agent")}{header("cwd","Working directory")}{header("tokens","Tokens")}{header("cost","Cost")}<th></th><th></th></tr></thead><tbody>{pageRows.map(session => <Fragment key={session.sessionId}><tr className={`session-row ${expanded === session.sessionId ? "session-row-open" : ""}`} tabIndex={0} aria-expanded={expanded === session.sessionId} aria-label={`Toggle details for ${session.modelsUsed[0] ?? "this session"}`} onClick={()=>void toggle(session)} onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){event.preventDefault();void toggle(session);}}}><td><span className="session-activity">{session.metadata?.lastActivity ? formatDate(session.metadata.lastActivity) : "—"}</span></td><td><span><b>{session.modelsUsed[0] ?? "Unknown"}</b><small>{session.period.slice(0,18)}</small></span></td><td className="session-row__agent"><span className={`agent-pill ${session.agent}`}>{session.agent}</span></td><td><span className="cwd" title={session.cwd ?? "Unavailable"}>{session.cwd ?? "Path unavailable"}</span><span className="mini-tags">{[...session.pathTags,...session.annotation.tags].slice(0,3).map(tag=><i key={tag}>{tag}</i>)}</span></td><td><b>{formatCompact(session.totalTokens)}</b><small>{formatCompact(session.outputTokens)} output</small></td><td><b>{formatMoney(session.totalCost)}</b><small>ccusage</small></td><td className="session-row__actions" onClick={event=>event.stopPropagation()}><button className="icon-button" onClick={()=>onEdit(session)} aria-label="Edit annotation"><PencilLine/></button></td><td className="session-row__toggle" onClick={event=>event.stopPropagation()}><button type="button" className="session-detail-toggle" onClick={()=>void toggle(session)} aria-label={expanded === session.sessionId ? "Close session details" : "Open session details"} aria-expanded={expanded === session.sessionId}><Plus/></button></td></tr>{expanded === session.sessionId && <tr className="session-detail-row"><td colSpan={8}><SessionDetailPanel session={session} detail={details[session.sessionId]} loading={loadingDetail === session.sessionId}/></td></tr>}</Fragment>)}</tbody></table></div>{!pageRows.length&&<Empty text="No sessions match those filters."/>}<div className="pagination"><span>{filtered.length} sessions</span><div><button disabled={page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft/></button><span>{page} / {pages}</span><button disabled={page===pages} onClick={()=>setPage(p=>p+1)}><ChevronRight/></button></div></div></section></div>;
}

function projectDayRows(trend: ProjectTrendRow[], activity: ProjectActivity[] = []) {
  const days = new Map<string, {date:string;tokens:number;cost:number;runs:number;models:Map<string,{tokens:number;cost:number}>}>();
  trend.forEach((row) => {
    const day = days.get(row.date) ?? {date:row.date,tokens:0,cost:0,runs:0,models:new Map<string,{tokens:number;cost:number}>()};
    day.tokens += row.totalTokens;
    day.cost += row.totalCost;
    day.runs++;
    row.modelBreakdowns.forEach((model) => {
      const tokens = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
      const current=day.models.get(model.modelName)??{tokens:0,cost:0};
      current.tokens+=tokens;
      current.cost+=model.cost;
      day.models.set(model.modelName,current);
    });
    days.set(row.date, day);
  });
  const providersByDay = new Map<string, ProjectActivity[]>();
  activity.forEach((item) => providersByDay.set(item.date, [...(providersByDay.get(item.date) ?? []), item]));
  return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map((day)=>({
    ...day,
    runs:providersByDay.has(day.date) ? providersByDay.get(day.date)!.reduce((sum,item)=>sum+item.sessions,0) : day.runs,
    label:new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined,{month:"short",day:"numeric"}),
    models:[...day.models.entries()].map(([name,totals])=>({name,...totals})).sort((a,b)=>b.tokens-a.tokens),
    providers:(providersByDay.get(day.date) ?? []).sort((a,b)=>providerSeries.findIndex((provider)=>provider.key===a.provider)-providerSeries.findIndex((provider)=>provider.key===b.provider)),
  }));
}

function ProjectDayTooltip({active,payload,coordinate}:{active?:boolean;payload?:any[];coordinate?:{x?:number}}) {
  const tooltipRef=useClampedTooltip(Boolean(active),coordinate);
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as ReturnType<typeof projectDayRows>[number];
  const dateLabel=new Date(`${row.date}T12:00:00`).toLocaleDateString(undefined,{weekday:"short",month:"long",day:"numeric",year:"numeric"});
  return <div className="chart-tooltip provider-tooltip" key={row.date} ref={tooltipRef}>
    <div className="tooltip-columns"><span>{dateLabel}</span><small>Tokens</small><small>API $</small></div>
    <section className="tooltip-projects">
      <div className="tooltip-projects__head"><strong>Total</strong><b>{formatCompact(row.tokens)}</b><b>{formatMoney(row.cost)}</b></div>
    </section>
    {row.providers.map((providerActivity) => {
      const provider=providerSeries.find((item)=>item.key===providerActivity.provider)!;
      const visibleModels=providerActivity.models.slice(0,3);
      return <section className="tooltip-provider" key={providerActivity.provider}>
        <div className="tooltip-provider__head"><i style={{background:provider.color}}/><strong>{provider.label}</strong><b>{formatCompact(providerActivity.tokens)}</b><b>{formatMoney(providerActivity.cost)}</b></div>
        {visibleModels.length>0&&<ul className="tooltip-provider-models">{visibleModels.map((model)=><li key={model.model}><span>{model.model}</span><b>{formatCompact(model.tokens)}</b><b>{formatMoney(model.cost)}</b></li>)}</ul>}
        {providerActivity.models.length>visibleModels.length&&<small className="tooltip-more-row tooltip-model-more"><span>+{providerActivity.models.length-visibleModels.length} more</span><b>{formatCompact(providerActivity.models.slice(3).reduce((sum,model)=>sum+model.tokens,0))}</b><b>{formatMoney(providerActivity.models.slice(3).reduce((sum,model)=>sum+model.cost,0))}</b></small>}
      </section>;
    })}
  </div>;
}

function ProjectDetails({project,activity,sessions,onOpenSession}:{project:ProjectSummary;activity:ProjectActivity[];sessions:Session[];onOpenSession:(sessionId:string)=>void}) {
  type ModelSortKey="name"|"tokens"|"cost";
  const [modelSort,setModelSort]=useState<{key:ModelSortKey;direction:"asc"|"desc"}>({key:"tokens",direction:"desc"});
  const [sessionDetails,setSessionDetails]=useState<ProjectSessionDetail[]>([]);
  const [loadingSessions,setLoadingSessions]=useState(true);
  useEffect(()=>{
    let cancelled=false;
    setLoadingSessions(true);
    Promise.all(sessions.map(async(session)=>{
      try {
        const response=await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/detail`);
        if(!response.ok)throw new Error("Session details are unavailable");
        return {session,detail:await response.json() as SessionDetail};
      } catch {
        return {session,detail:{available:false,prompts:[],tools:[],files:[],additions:0,deletions:0,eventsRead:0} satisfies SessionDetail};
      }
    })).then((details)=>{if(!cancelled){setSessionDetails(details);setLoadingSessions(false);}});
    return()=>{cancelled=true;};
  },[sessions]);
  const days=projectDayRows(project.trend,activity);
  const modelTotals=new Map<string,{tokens:number;cost:number}>();
  days.forEach(day=>day.models.forEach(model=>{const totals=modelTotals.get(model.name)??{tokens:0,cost:0};totals.tokens+=model.tokens;totals.cost+=model.cost;modelTotals.set(model.name,totals);}));
  const modelEntries=[...modelTotals.entries()].map(([name,totals])=>({name,...totals})).sort((a,b)=>b.tokens-a.tokens).map((model,colorIndex)=>({...model,colorIndex}));
  const models=[...modelEntries].sort((left,right)=>{
    const comparison=modelSort.key==="name"?left.name.localeCompare(right.name):left[modelSort.key]-right[modelSort.key];
    return modelSort.direction==="asc"?comparison:-comparison;
  });
  const sortModels=(key:ModelSortKey)=>setModelSort((current)=>current.key===key?{key,direction:current.direction==="asc"?"desc":"asc"}:{key,direction:key==="name"?"asc":"desc"});
  const modelSortButton=(key:ModelSortKey,label:string)=><button type="button" className={modelSort.key===key?"active":undefined} aria-label={`Sort models by ${label} ${modelSort.key===key&&modelSort.direction==="asc"?"descending":"ascending"}`} aria-pressed={modelSort.key===key} onClick={()=>sortModels(key)}><span>{label}</span><i aria-hidden="true">{modelSort.key===key?(modelSort.direction==="asc"?"↑":"↓"):"↕"}</i></button>;
  const first=days[0]?.date; const last=days.at(-1)?.date;
  const orderedSessionDetails=[...sessionDetails].sort((left,right)=>String(right.session.metadata?.lastActivity??"").localeCompare(String(left.session.metadata?.lastActivity??"")));
  const changedFiles=new Set(sessionDetails.flatMap(({detail})=>detail.files.map((file)=>file.path)));
  const additions=sessionDetails.reduce((sum,{detail})=>sum+detail.additions,0);
  const deletions=sessionDetails.reduce((sum,{detail})=>sum+detail.deletions,0);
  const dateCopy=first&&last ? `${new Date(`${first}T12:00:00`).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})} — ${new Date(`${last}T12:00:00`).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}` : "No dated activity";
  return <div className="project-detail" onClick={event=>event.stopPropagation()}>
    <div className="project-detail__summary">
      <div><span>Total tokens</span><strong>{project.tokens.toLocaleString()}</strong></div>
      <div><span>Activity records</span><strong>{project.trend.length}</strong></div>
      <div><span>Active days</span><strong>{days.length}</strong></div>
      <div><span>Files changed</span><strong>{loadingSessions?"…":changedFiles.size}</strong></div>
      <div><span>Time observed</span><strong className="project-time">{dateCopy}</strong></div>
    </div>
    <div className="project-detail__grid">
      <section className="project-viz">
        <div className="project-viz__head"><div><span className="overline">DAILY SIGNAL</span><h4>Runs and tokens by day</h4></div><div className="project-viz__legend"><span><i/>Tokens</span><span><i/>Records</span></div></div>
        <div className="project-chart" role="img" aria-label={`Daily token usage and activity records for ${friendlyProject(project.name)}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={days} margin={{top:12,right:4,left:-16,bottom:0}}>
              <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
              <XAxis dataKey="label" tick={{fill:"#71807b",fontSize:11}} tickLine={false} axisLine={false} minTickGap={24}/>
              <YAxis yAxisId="tokens" tickFormatter={formatCompact} tick={{fill:"#71807b",fontSize:11}} tickLine={false} axisLine={false}/>
              <YAxis yAxisId="runs" orientation="right" allowDecimals={false} hide/>
              <Tooltip content={<ProjectDayTooltip/>} cursor={{fill:"rgba(183,242,92,.05)"}} offset={0} isAnimationActive={false} wrapperStyle={{transition:"none"}}/>
              <Bar yAxisId="tokens" dataKey="tokens" name="Tokens" fill="var(--accent)" fillOpacity={0.46} radius={[4,4,0,0]}/>
              <Line yAxisId="runs" type="monotone" dataKey="runs" name="Activity records" stroke="var(--aqua)" strokeWidth={2} dot={false} activeDot={{r:4,fill:"#07100f",stroke:"var(--aqua)",strokeWidth:2}}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="project-viz model-breakdown">
        <div className="project-viz__head"><div><span className="overline">MODEL MIX</span><h4>Usage by model</h4></div><span>{models.length} {models.length===1?"model":"models"}</span></div>
        <div className="project-model-total"><span>Overall total</span><b><small>Tokens</small>{formatCompact(project.tokens)}</b><b><small>API eq.</small>{formatMoney(project.cost)}</b></div>
        <div className="project-model-sort" aria-label="Sort model usage">{modelSortButton("name","Model")}{modelSortButton("tokens","Tokens")}{modelSortButton("cost","API eq.")}</div>
        <div className="project-model-list">{models.map((model)=><div key={model.name} title={`${model.name}: ${model.tokens.toLocaleString()} tokens · ${formatMoney(model.cost)} API-equivalent`}>
          <div><span><i style={{background:palette[model.colorIndex%palette.length]}}/>{model.name}</span><b>{formatCompact(model.tokens)}</b><b>{formatMoney(model.cost)}</b></div>
          <div className="project-model-meter"><i style={{width:`${project.tokens?model.tokens/project.tokens*100:0}%`,background:palette[model.colorIndex%palette.length]}}/></div>
          <small>{project.tokens?Math.round(model.tokens/project.tokens*100):0}% of tokens</small>
        </div>)}</div>
      </section>
    </div>
    <section className="project-sessions" aria-label={`Sessions for ${friendlyProject(project.name)}`}>
      <div className="project-sessions__head">
        <div><span className="overline">SESSION CHANGES</span><h4>Diff trail</h4></div>
        <div className="project-diff-total"><span>{sessions.length} {sessions.length===1?"session":"sessions"}</span><strong><i>+{additions}</i><em>−{deletions}</em></strong></div>
      </div>
      {loadingSessions?<p className="project-sessions__state">Reading local session patches…</p>:orderedSessionDetails.length?<ol className="project-session-list">{orderedSessionDetails.map(({session,detail})=>
        <li key={session.sessionId}>
          <div className="project-session-meta"><span className={`agent-pill ${session.agent}`}>{session.agent}</span><div><b>{session.modelsUsed[0]??"Unknown model"}</b><small>{session.metadata?.lastActivity?formatDate(session.metadata.lastActivity):session.period}</small></div></div>
          <div className="project-session-files"><span>{detail.available?`${detail.files.length} ${detail.files.length===1?"file":"files"}`:"Patch unavailable"}</span>{detail.files.length>0&&<small title={detail.files.map((file)=>file.path).join("\n")}>{detail.files.slice(0,3).map((file)=>file.path.split("/").at(-1)).join(" · ")}{detail.files.length>3?` · +${detail.files.length-3}`:""}</small>}</div>
          <div className="project-session-diff"><i>+{detail.additions}</i><em>−{detail.deletions}</em></div>
          <a href={sessionHref(session.sessionId)} onClick={(event)=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenSession(session.sessionId);}}>Open session <ArrowUpRight/></a>
        </li>)}</ol>:<p className="project-sessions__state">No indexed sessions were found for this project.</p>}
    </section>
    <p className="project-detail__note">“Runs” counts source activity records. Elapsed hours are not available in the project report.</p>
  </div>;
}

function Projects({data,onOpenSession}:{data:DashboardData;onOpenSession:(sessionId:string)=>void}) {
  const [openProject,setOpenProject]=useState<string|null>(null);
  const [query,setQuery]=useState("");
  const [sort,setSort]=useState("tokens-desc");
  const visibleProjects=useMemo(()=>{
    const [key,direction]=sort.split("-") as ["name"|"tokens"|"cost"|"sessions","asc"|"desc"];
    const matches=data.projects.filter(project=>`${friendlyProject(project.name)} ${project.models.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
    return [...matches].sort((left,right)=>{
      const value=(project:ProjectSummary):string|number=>key==="name"?friendlyProject(project.name):project[key];
      const a=value(left),b=value(right);
      const comparison=typeof a==="number"&&typeof b==="number"?a-b:String(a).localeCompare(String(b));
      return direction==="asc"?comparison:-comparison;
    });
  },[data.projects,query,sort]);
  return <div className="view-stack page-enter"><PageTitle eyebrow="PROJECT CARTOGRAPHY" title="Where the work happened" description="Select a project to inspect its daily activity, model mix, and observed time range." actions={<div className="project-controls"><label className="search"><Search/><span className="sr-only">Search projects</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search projects…"/></label><label className="project-sort"><span>Sort</span><select value={sort} onChange={event=>setSort(event.target.value)}><option value="tokens-desc">Tokens: high to low</option><option value="tokens-asc">Tokens: low to high</option><option value="cost-desc">Cost: high to low</option><option value="cost-asc">Cost: low to high</option><option value="sessions-desc">Sessions: high to low</option><option value="sessions-asc">Sessions: low to high</option><option value="name-asc">Name: A to Z</option><option value="name-desc">Name: Z to A</option></select></label></div>}/><section className="card-list project-list">{visibleProjects.map((project,index)=>{
    const open=openProject===project.name;
    const maxTokens=Math.max(...project.trend.map(point=>point.totalTokens),1);
    return <article className={`project-card${open?" open":""}`} key={project.name}>
      <button className="rank-card project-row" type="button" onClick={()=>setOpenProject(open?null:project.name)} aria-expanded={open} aria-controls={`project-detail-${index}`}>
        <span className="rank">{String(index+1).padStart(2,"0")}</span><div className="rank-main"><h3>{friendlyProject(project.name)}</h3><p>{project.models.slice(0,3).join(" · ")}</p><div className="micro-chart" aria-hidden="true">{project.trend.slice(-14).map((point,i)=><i key={i} style={{height:`${Math.max(8,point.totalTokens/maxTokens*100)}%`}}/>)}</div></div><div className="rank-stat"><span>Tokens</span><b>{formatCompact(project.tokens)}</b></div><div className="rank-stat"><span>Cost</span><b>{formatMoney(project.cost)}</b></div><div className="rank-stat"><span>Active days</span><b>{projectDayRows(project.trend).length}</b></div><Plus className="project-row__toggle" aria-hidden="true"/>
      </button>
      {open&&<div id={`project-detail-${index}`}><ProjectDetails project={project} activity={data.projectActivity.filter((activity)=>activity.projectId===project.name)} sessions={data.sessions.filter((session)=>(session.cwd??"").replace(/\/+$/,"")===project.name)} onOpenSession={onOpenSession}/></div>}
    </article>;
  })}</section>{!data.projects.length?<Empty text="No source-exposed projects found in this period."/>:!visibleProjects.length&&<Empty text="No projects match that search."/>}</div>;
}

function Models({data}:{data:DashboardData}) { const max=Math.max(...data.models.map(m=>m.cost),1); return <div className="view-stack page-enter"><PageTitle eyebrow="MODEL SPECTROGRAPH" title="Model mix and efficiency" description="Compare API-equivalent cost, output volume, and cache behavior using ccusage as the sole analytical cost source."/><section className="model-grid">{data.models.map((model,index)=><article className="model-card" key={model.model}><div className="model-card__head"><span style={{background:palette[index%palette.length]}}>{model.model.startsWith("gpt")?"G":"C"}</span><div><h3>{model.model}</h3><p>{model.agents.join(" · ")}</p></div></div><div className="model-cost"><strong>{formatMoney(model.cost)}</strong><span>API-equivalent</span></div><div className="meter"><i style={{width:`${model.cost/max*100}%`,background:palette[index%palette.length]}}/></div><dl><div><dt>Total tokens</dt><dd>{formatCompact(model.tokens)}</dd></div><div><dt>Output</dt><dd>{formatCompact(model.outputTokens)}</dd></div><div><dt>Cache read</dt><dd>{formatCompact(model.cacheReadTokens)}</dd></div></dl></article>)}</section></div> }

function Limits({data,onRules}:{data:DashboardData;onRules:()=>void}) {
  const budget=Number(data.settings.monthlyBudget??250); const month=data.monthly.at(-1)?.totalCost??0; const ratio=Math.min(100,month/budget*100);
  return <div className="view-stack page-enter"><PageTitle eyebrow="LIMITS & METHODOLOGY" title="Know what every number means" description="Provider quota, locally reconstructed activity, and personal budgets stay intentionally separate." actions={<button className="secondary-button" onClick={onRules}><Tag/> Path rules</button>}/><section className="limits-grid"><article className="panel distinction"><span className="source-symbol provider"><Gauge/></span><span className="overline">PROVIDER QUOTA</span><h2>{data.quotas.available?"Connected":"Not connected"}</h2><p>{data.quotas.available?"Authoritative allowance data from quota-service.":"quota-service is optional and currently unavailable. Analytics continue normally."}</p><span className="method-chip"><i/> provider reported</span></article><article className="panel distinction"><span className="source-symbol local"><Clock3/></span><span className="overline">LOCAL ACTIVITY BLOCK</span><h2>{data.blocks.find(b=>b.isActive)?"Active window":"Recent window"}</h2><p>Reconstructed by ccusage from local {data.blockScope} records.</p><span className="method-chip local"><i/> locally calculated</span></article><article className="panel distinction"><span className="source-symbol budget"><CircleDollarSign/></span><span className="overline">PERSONAL BUDGET</span><h2>{formatMoney(month)} / {formatMoney(budget)}</h2><p>Your configurable target, not a provider billing limit.</p><div className="budget-bar"><i style={{width:`${ratio}%`}}/></div><span className="method-chip budget"><i/> user defined</span></article></section><section className="panel"><div className="panel-heading"><div><span className="overline">DATA SOURCE HEALTH</span><h2>Collection boundaries</h2></div><span>Updated {formatDate(data.collectedAt)}</span></div><div className="source-list">{data.sources.map(source=><div key={source.name}><span className={`status-dot ${source.status}`}/><div><b>{source.name}</b><small>{source.kind}</small></div><p>{source.detail}</p><span className={`status-label ${source.status}`}>{source.status}</span></div>)}</div></section></div>;
}

function PageTitle({eyebrow,title,description,actions}:{eyebrow:string;title:string;description:string;actions?:React.ReactNode}) { return <header className="page-title"><div><span className="overline">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions}</header> }
function Segmented({value,onChange,options,label}:{value:string;onChange:(v:string)=>void;options:Array<{value:string;label:string}>;label?:string}) { return <div className="segmented" aria-label={label}>{options.map(option=><button type="button" key={option.value} className={value===option.value?"active":""} aria-pressed={value===option.value} onClick={()=>onChange(option.value)}>{option.label}</button>)}</div> }
function Empty({text}:{text:string}) { return <div className="empty"><Orbit/><p>{text}</p></div> }

function InformationSources({data}:{data:DashboardData}) {
  return <footer className="information-sources" aria-label="Information sources">
    <div><span className="overline">INFORMATION SOURCES</span><p>Local analytics, metadata, and optional provider allowance data.</p></div>
    <ul>
      <li><a href="https://github.com/ccusage/ccusage" target="_blank" rel="noreferrer">ccusage</a><span>v{data.ccusageVersion} by ryoppippi · MIT · local usage analytics and offline price estimates</span></li>
      <li><b>Local agent records</b><span>Claude Code and Codex session headers · working-directory metadata only</span></li>
      <li><a href="https://github.com/anobjectn/quota-service" target="_blank" rel="noreferrer">quota-service</a><span>{data.quotas.available ? "Provider-reported allowance data" : "Optional provider allowance service unavailable; no quota estimate is substituted"}</span></li>
    </ul>
  </footer>;
}

const sceneEffectOptions:{key:"starfield"|"parallax"|"twinkle";label:string;detail:string}[]=[
  {key:"starfield",label:"Starfield",detail:"Generative star field behind the content on every view"},
  {key:"parallax",label:"Depth parallax",detail:"Stars at different distances drift at different rates"},
  {key:"twinkle",label:"Twinkle & tint",detail:"Star flicker with accent and aqua tinted highlights"},
];
const starDensityLabels = ["", "Minimal", "Sparse", "Balanced", "Dense", "Dark Sky", "Oh My!"];
const unchangedDismissals = ["fine, leaving it as is then", "nothing then? cool", "maybe next time?", "later"];
const changedDismissals = ["Gotcha!", "You Got It", "Done"];
const maxDismissals = ["Nice!!", "Oh, I see!", "Oh, its like that?"];
const minDismissals = ["Chillin", "ok then"];

function randomDismissal(options:string[]) {
  return options[Math.floor(Math.random()*options.length)];
}

function ColorControl({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}) {
  const [copied,setCopied]=useState(false);
  const copy=async()=>{try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(()=>setCopied(false),1600); } catch {}};
  return <label className="appearance-color-setting"><span>{label}</span><div className="accent-control"><input aria-label={`${label} color`} type="color" value={value} onChange={event=>onChange(event.target.value)}/><code>{value.toUpperCase()}</code><button type="button" className="accent-copy-button" onClick={()=>void copy()} aria-label={copied?`${label} color copied`:`Copy ${label.toLowerCase()} color`} title={copied?"Copied":"Copy color"}>{copied?<Check/>:<Copy/>}</button></div></label>;
}

function AppearanceModal({accent,onChange,providerColors,onProviderColorsChange,favoriteAccents,onFavoriteAccentsChange,dataTextScale,onDataTextScaleChange,sceneEffects,onSceneEffectsChange,reducedMotion,onReset,onClose}:{accent:string;onChange:(value:string)=>void;providerColors:ProviderColors;onProviderColorsChange:(value:ProviderColors)=>void;favoriteAccents:string[];onFavoriteAccentsChange:(value:string[])=>void;dataTextScale:number;onDataTextScaleChange:(value:number)=>void;sceneEffects:SceneEffects;onSceneEffectsChange:(value:SceneEffects)=>void;reducedMotion:boolean;onReset:()=>void;onClose:()=>void}) {
  const [editingFavorites,setEditingFavorites]=useState(false);
  const [dismissal,setDismissal]=useState<string|null>(null);
  const closeTimer=useRef<number|null>(null);
  const initial=useRef({accent,providerColors:{...providerColors},favoriteAccents:[...favoriteAccents],dataTextScale,sceneEffects:{...sceneEffects}});
  const replaceFavorite=(index:number)=>{onFavoriteAccentsChange(favoriteAccents.map((color,colorIndex)=>colorIndex===index?accent:color));setEditingFavorites(false);};
  const dismiss=useCallback(()=>{
    if(dismissal) return;
    const starting=initial.current;
    const sceneChanged=JSON.stringify(sceneEffects)!==JSON.stringify(starting.sceneEffects);
    const changed=accent!==starting.accent||JSON.stringify(providerColors)!==JSON.stringify(starting.providerColors)||JSON.stringify(favoriteAccents)!==JSON.stringify(starting.favoriteAccents)||dataTextScale!==starting.dataTextScale||sceneChanged;
    const setToMax=(sceneEffects.speed!==starting.sceneEffects.speed&&sceneEffects.speed===3)||(sceneEffects.starDensity!==starting.sceneEffects.starDensity&&sceneEffects.starDensity===6);
    const setToMin=(sceneEffects.speed!==starting.sceneEffects.speed&&sceneEffects.speed===0.1)||(sceneEffects.starDensity!==starting.sceneEffects.starDensity&&sceneEffects.starDensity===1);
    const options=!changed?unchangedDismissals:setToMax?maxDismissals:setToMin?minDismissals:changedDismissals;
    setDismissal(randomDismissal(options));
    closeTimer.current=window.setTimeout(onClose,2050);
  },[accent,dataTextScale,dismissal,favoriteAccents,onClose,providerColors,sceneEffects]);
  useEffect(()=>()=>{if(closeTimer.current!==null)window.clearTimeout(closeTimer.current)},[]);
  useEffect(()=>{const onKeyDown=(event:KeyboardEvent)=>{if(event.key!=="Escape")return;event.preventDefault();event.stopPropagation();dismiss()};document.addEventListener("keydown",onKeyDown,true);return()=>document.removeEventListener("keydown",onKeyDown,true)},[dismiss]);

  return <div className={`modal-backdrop appearance-backdrop${dismissal?" modal-backdrop--dismissing":""}`} onMouseDown={event=>{if(event.target===event.currentTarget)dismiss()}}>
    <div className={`modal appearance-modal${dismissal?" appearance-modal--dismissing":""}`}>
      <div className="appearance-content">
        <button className="modal-close" onClick={dismiss} aria-label="Close appearance settings"><X/></button>
        <span className="overline">LOCAL APPEARANCE</span>
        <h2>Appearance</h2>
        <p>Adjust visual signals and data readability. These preferences stay on this device.</p>
        <span className="appearance-label">Signal colors</span>
        <div className="appearance-color-grid">
          <ColorControl label="Accent" value={accent} onChange={onChange}/>
          <ColorControl label="Anthropic" value={providerColors.anthropic} onChange={value=>onProviderColorsChange({...providerColors,anthropic:value})}/>
          <ColorControl label="OpenAI" value={providerColors.openai} onChange={value=>onProviderColorsChange({...providerColors,openai:value})}/>
          <ColorControl label="Warp" value={providerColors.warp} onChange={value=>onProviderColorsChange({...providerColors,warp:value})}/>
        </div>
        <p className="signal-color-note">Provider colors identify quota headroom across satellites, charts, and limit cards.</p>
        <div className={`accent-favorites${editingFavorites?" editing":""}`} aria-label="Favorite accent colors">{favoriteAccents.map((color,index)=><button type="button" key={`${color}-${index}`} className={accent.toLowerCase()===color.toLowerCase()?"selected":""} style={{backgroundColor:color}} aria-label={editingFavorites?`Replace ${color} with ${accent}`:`Use ${color} accent`} aria-pressed={!editingFavorites&&accent.toLowerCase()===color.toLowerCase()} onClick={()=>editingFavorites?replaceFavorite(index):onChange(color)}>{editingFavorites?<PencilLine/>:<Check/>}</button>)}<button type="button" className="accent-favorite-edit" onClick={()=>setEditingFavorites(editing=>!editing)} aria-label={editingFavorites?"Finish editing favorite colors":"Edit favorite colors"} aria-pressed={editingFavorites} title={editingFavorites?"Done editing":"Edit favorites"}><PencilLine/></button></div>
        {editingFavorites&&<div className="accent-favorite-editor"><p>Pick a new color above, then choose the favorite chip to replace.</p><button type="button" onClick={()=>{onFavoriteAccentsChange(defaultFavoriteAccents);setEditingFavorites(false)}}><RotateCcw/> Reset favorites</button></div>}
        <div className="data-text-setting"><div><b>Data text size</b><small>Tables and dense data rows across every view</small></div><div className="data-text-control"><button type="button" onClick={()=>onDataTextScaleChange(Math.max(90,dataTextScale-10))} disabled={dataTextScale<=90} aria-label="Decrease data text size">−</button><output aria-live="polite">{dataTextScale}%</output><button type="button" onClick={()=>onDataTextScaleChange(Math.min(150,dataTextScale+10))} disabled={dataTextScale>=150} aria-label="Increase data text size">+</button></div></div>
        <div className="scene-effects">
          <span className="appearance-label">Observatory scene effects</span>
          {sceneEffectOptions.map(option=>{
            const systemSuppressed=option.key==="starfield"&&reducedMotion&&sceneEffects.starfield;
            return <div className="effect-row" key={option.key}><div><b>{option.label}</b><small>{option.detail}</small>{systemSuppressed&&<small className="system-motion-note">Off because Reduce Motion is enabled in system settings.</small>}</div><button type="button" role="switch" className="effect-switch" aria-checked={systemSuppressed?false:sceneEffects[option.key]} aria-label={option.label} onClick={()=>onSceneEffectsChange({...sceneEffects,[option.key]:!sceneEffects[option.key]})}/></div>;
          })}
          <div className="effect-row"><div><b>Star density</b><small>Six fixed levels, from a visible floor to extreme depth</small></div><div className="speed-control density-control"><input type="range" min={1} max={6} step={1} value={sceneEffects.starDensity} disabled={!sceneEffects.starfield||reducedMotion} aria-label="Star density" aria-valuetext={starDensityLabels[sceneEffects.starDensity]} onChange={event=>onSceneEffectsChange({...sceneEffects,starDensity:Number(event.target.value)})}/><output aria-live="polite">{starDensityLabels[sceneEffects.starDensity]}</output></div></div>
          <div className="effect-row"><div><b>Animation speed</b><small>Rate of auto-rotation, orbits, and twinkle</small></div><div className="speed-control"><input type="range" min={0.1} max={3} step={0.05} value={sceneEffects.speed} aria-label="Animation speed" onChange={event=>onSceneEffectsChange({...sceneEffects,speed:Number(event.target.value)})}/><output aria-live="polite">{sceneEffects.speed.toFixed(2)}x</output></div></div>
          <small>Motion effects pause automatically when your system prefers reduced motion.</small>
        </div>
        <button type="button" className="reset-appearance" onClick={()=>{onReset();setEditingFavorites(false)}}><RotateCcw/> Reset all appearance settings</button>
      </div>
    </div>
    {dismissal&&<div className={`appearance-dismissal${maxDismissals.includes(dismissal) ? " appearance-dismissal--max" : ""}`} role="status"><h2>{dismissal}</h2></div>}
  </div>;
}

function AnnotationModal({session,onClose,onSaved}:{session:Session;onClose:()=>void;onSaved:()=>void}) {
  const [note,setNote]=useState(session.annotation.note); const [tags,setTags]=useState(session.annotation.tags.join(", ")); const [saving,setSaving]=useState(false);
  const save=async()=>{setSaving(true);await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/annotations`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({note,tags:tags.split(",").map(t=>t.trim()).filter(Boolean)})});setSaving(false);onSaved();onClose();};
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal"><button className="modal-close" onClick={onClose}><X/></button><span className="overline">LOCAL ANNOTATION</span><h2>Mark this session</h2><p>{session.modelsUsed.join(", ")} · {formatCompact(session.totalTokens)} tokens</p><label>Tags<input value={tags} onChange={e=>setTags(e.target.value)} placeholder="feature, research, client-work"/><small>Comma separated. Manual tags remain distinct from derived path tags.</small></label><label>Notes<textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="What was this session about?" rows={5}/></label><button className="primary-button" onClick={save} disabled={saving}>{saving?<RefreshCw className="spin"/>:<Check/>} Save annotation</button></div></div>;
}

function RulesModal({data,onClose,onSaved}:{data:DashboardData;onClose:()=>void;onSaved:()=>void}) {
  const [tag,setTag]=useState(""); const [pattern,setPattern]=useState(""); const [kind,setKind]=useState<"glob"|"regex">("glob");
  const add=async()=>{if(!tag||!pattern)return;await fetch("/api/rules",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tag,pattern,kind})});setTag("");setPattern("");onSaved();};
  const remove=async(id:number)=>{await fetch(`/api/rules/${id}`,{method:"DELETE"});onSaved();};
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal rules-modal"><button className="modal-close" onClick={onClose}><X/></button><span className="overline">DERIVED METADATA</span><h2>Working-directory rules</h2><p>Rules are re-evaluated over indexed paths. Only path strings are stored; transcript content is never copied.</p><div className="rules-list">{data.rules.map(rule=><div key={rule.id}><Tag/><span><b>{rule.tag}</b><small>{rule.kind} · {rule.pattern}</small></span><button onClick={()=>remove(rule.id)} aria-label={`Delete ${rule.tag}`}><Trash2/></button></div>)}</div><div className="rule-form"><input value={tag} onChange={e=>setTag(e.target.value)} placeholder="Tag name"/><select value={kind} onChange={e=>setKind(e.target.value as "glob"|"regex")}><option value="glob">Glob</option><option value="regex">Regex</option></select><input value={pattern} onChange={e=>setPattern(e.target.value)} placeholder="**/project-worktree*"/><button className="primary-button" onClick={add}><Tag/> Add rule</button></div></div></div>;
}

export function App() {
  const {data,error,loading,load}=useDashboard(); const [view,setView]=useState<View>(initialView); const [focusSessionId,setFocusSessionId]=useState<string|null>(initialSessionId); const [agent,setAgent]=useState("all"); const [days,setDays]=useState<MetricRange>("30"); const [pathTag,setPathTag]=useState("all"); const [metric,setMetric]=useState<Metric>("totalTokens"); const [sidebar,setSidebar]=useState(false); const [sidebarCollapsed,setSidebarCollapsed]=useState(false); const [session,setSession]=useState<Session|null>(null); const [rules,setRules]=useState(false); const [appearance,setAppearance]=useState(false); const [accent,setAccent]=useState(savedAccent); const [providerColors,setProviderColors]=useState<ProviderColors>(savedProviderColors); const [favoriteAccents,setFavoriteAccents]=useState(savedFavoriteAccents); const [dataTextScale,setDataTextScale]=useState(savedDataTextScale); const [sceneEffects,setSceneEffects]=useState<SceneEffects>(savedSceneEffects); const reducedMotion=usePrefersReducedMotion();
  useEffect(()=>{ document.documentElement.style.setProperty("--accent", accent); const favicon=document.querySelector<HTMLLinkElement>("link[rel='icon']"); if(favicon) favicon.href=faviconHref(accent); try { localStorage.setItem(accentStorageKey, accent); } catch {} },[accent]);
  useEffect(()=>{ document.documentElement.style.setProperty("--anthropic-color",providerColors.anthropic); document.documentElement.style.setProperty("--openai-color",providerColors.openai); document.documentElement.style.setProperty("--warp-color",providerColors.warp); try { localStorage.setItem(providerColorsStorageKey,JSON.stringify(providerColors)); } catch {} },[providerColors]);
  useEffect(()=>{ try { localStorage.setItem(favoriteAccentsStorageKey,JSON.stringify(favoriteAccents)); } catch {} },[favoriteAccents]);
  useEffect(()=>{ try { localStorage.setItem(sceneEffectsStorageKey,JSON.stringify(sceneEffects)); } catch {} },[sceneEffects]);
  useEffect(()=>{const navigate=(event:PopStateEvent)=>{const state=event.state as {view?:View;sessionId?:string}|null;setView(state?.view??initialView());setFocusSessionId(state?.sessionId??initialSessionId());};window.addEventListener("popstate",navigate);return()=>window.removeEventListener("popstate",navigate);},[]);
  useEffect(()=>{ const scale=dataTextScale/100; document.documentElement.style.setProperty("--data-text-scale",String(scale)); document.documentElement.style.setProperty("--data-text-primary",`${12*scale}px`); document.documentElement.style.setProperty("--data-text-secondary",`${10*scale}px`); document.documentElement.style.setProperty("--data-text-compact",`${9*scale}px`); document.documentElement.style.setProperty("--data-text-strong",`${15*scale}px`); try { localStorage.setItem(dataTextScaleStorageKey,String(dataTextScale)); } catch {} },[dataTextScale]);
  useEffect(()=>{ const dismiss=(event:KeyboardEvent)=>{if(event.key!=="Escape")return;setSession(null);setRules(false);}; window.addEventListener("keydown",dismiss); return()=>window.removeEventListener("keydown",dismiss); },[]);
  const agents=useMemo(()=>data?[...new Set(data.daily.flatMap(row=>row.agents?.map(a=>a.agent)??[]))]:[],[data]);
  const pathTags=useMemo(()=>data?[...new Set(data.sessions.flatMap(s=>s.pathTags))]:[],[data]);
  const sessions=useMemo(()=>data?.sessions.filter(s=>(agent==="all"||s.agent===agent)&&(pathTag==="all"||s.pathTags.includes(pathTag)))??[],[data,agent,pathTag]);
  const daily=useMemo(()=>{
    if (!data) return [];
    const range = metricRangeRows(data.daily, days);
    if (pathTag === "all") return range.map(row=>selectAgent(row,agent)).filter(Boolean) as MetricRow[];
    return pathFilteredRows(sessions, new Set(range.map((row) => row.period)));
  },[data,agent,days,pathTag,sessions]);
  const datedSessions=useMemo(()=>{
    if (!data) return [];
    const periods = new Set(metricRangeRows(data.daily, days).map((row) => row.period));
    return sessions.filter((session) => {
      const date = sessionDate(session);
      return date !== null && periods.has(date);
    });
  },[data,days,sessions]);
  const visibleSessions=useMemo(()=>{
    if(!data)return datedSessions;
    const focused=focusSessionId?data.sessions.find((session)=>session.sessionId===focusSessionId):undefined;
    return focused&&!datedSessions.some((session)=>session.sessionId===focused.sessionId)?[focused,...datedSessions]:datedSessions;
  },[data,datedSessions,focusSessionId]);
  const openSession=(sessionId:string)=>{history.replaceState({view},"",window.location.href);history.pushState({view:"sessions",sessionId},"",sessionHref(sessionId));setFocusSessionId(sessionId);setView("sessions");window.scrollTo({top:0,behavior:"smooth"});};
  const resetAppearance=()=>{setAccent(defaultAccent);setProviderColors(defaultProviderColors);setFavoriteAccents(defaultFavoriteAccents);setDataTextScale(defaultDataTextScale);setSceneEffects(defaultSceneEffects);};
  if (loading&&!data) return <div className="boot"><div className="boot-orbit"><Orbit/></div><span>Calibrating local instruments…</span></div>;
  if (error&&!data) return <div className="boot error-state"><Database/><h1>Observatory is offline</h1><p>{error}</p><button className="primary-button" onClick={()=>load()}>Try again</button></div>;
  if (!data) return null;
  const current=nav.find(item=>item.id===view)!;
  return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <aside className={sidebar?"open":""}><div className="brand"><button type="button" className="brand-home" onClick={()=>{setView("overview");setSidebar(false)}} aria-label="Go to Overview"><Orbit/></button><div><b>AI Usage</b><small>OBSERVATORY</small></div><button className="sidebar-toggle" onClick={()=>setSidebarCollapsed(collapsed=>!collapsed)} aria-label={sidebarCollapsed?"Expand navigation":"Collapse navigation"} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed?<ChevronRight/>:<ChevronLeft/>}</button><button className="sidebar-close" onClick={()=>setSidebar(false)} aria-label="Close navigation"><X/></button></div><nav>{nav.map(item=><button key={item.id} className={view===item.id?"active":""} onClick={()=>{setView(item.id);setSidebar(false)}} aria-label={item.label} data-tooltip={item.label}><item.icon/><span>{item.label}</span>{view===item.id&&<i/>}</button>)}</nav><div className="side-status" data-tooltip={`Local systems nominal — ccusage v${data.ccusageVersion}`} aria-label={`Local systems nominal, ccusage version ${data.ccusageVersion}`} tabIndex={sidebarCollapsed ? 0 : undefined}><span className="status-dot healthy"/><div><b>Local systems nominal</b><small>ccusage v{data.ccusageVersion}</small></div></div><button className="settings-link" onClick={()=>setRules(true)} data-tooltip="Path rules"><Settings2/> <b>Path rules</b> <span>{data.rules.length}</span></button><p className="privacy-note">No raw usage records leave this machine.</p></aside>
    <main>{sceneEffects.starfield&&!reducedMotion&&<Starfield accent={accent} effects={sceneEffects}/>}<header className="topbar"><button className="menu-button" onClick={()=>setSidebar(true)}><Menu/></button><div className="breadcrumbs"><button type="button" onClick={()=>setView("overview")}>AI Usage Observatory</button><ChevronRight/><b>{current.label}</b></div><div className="global-controls"><label><span>Agent</span><select value={agent} onChange={e=>setAgent(e.target.value)}><option value="all">All agents</option>{agents.map(a=><option value={a} key={a}>{a}</option>)}</select></label><label><span>Path</span><select value={pathTag} onChange={e=>setPathTag(e.target.value)}><option value="all">All paths</option>{pathTags.map(tag=><option value={tag} key={tag}>{tag}</option>)}</select></label>{view!=="overview"&&<Segmented label="Dashboard time span" value={days} onChange={(value)=>setDays(value as MetricRange)} options={[{value:"1",label:"1d"},{value:"7",label:"7d"},{value:"14",label:"14d"},{value:"30",label:"30d"},{value:"120",label:"120d"}]}/>}<button className="appearance-button" onClick={()=>setAppearance(true)} title="Appearance settings"><Palette/><span>Appearance</span></button><button className="refresh-button" onClick={()=>load(true)} title="Refresh local sources"><RefreshCw className={loading?"spin":""}/><span>{loading?"Collecting":"Refresh"}</span></button></div></header>
      {data.refresh.stale&&<div className="stale-banner">Showing the last successful collection. {data.refresh.lastError}</div>}
      <div className="content">
        {view==="overview"&&<Overview data={data} daily={daily} sessions={sessions} agent={agent} metricRange={days} onMetricRangeChange={setDays} onSession={setSession} accent={accent} providerColors={providerColors} sceneEffects={sceneEffects}/>}
        {view==="explorer"&&<Explorer data={data} rows={daily} sessions={sessions} agent={agent} pathTag={pathTag} metricRange={days} metric={metric} setMetric={setMetric}/>}
        {view==="sessions"&&<Sessions sessions={visibleSessions} onEdit={setSession} focusSessionId={focusSessionId}/>}
        {view==="projects"&&<Projects data={data} onOpenSession={openSession}/>}
        {view==="models"&&<Models data={data}/>}
        {view==="limits"&&<Limits data={data} onRules={()=>setRules(true)}/>}
      </div>
      <InformationSources data={data}/>
    </main>
    {session&&<AnnotationModal session={session} onClose={()=>setSession(null)} onSaved={()=>load()}/>}
    {rules&&<RulesModal data={data} onClose={()=>setRules(false)} onSaved={()=>load(true)}/>}
    {appearance&&<AppearanceModal accent={accent} onChange={setAccent} providerColors={providerColors} onProviderColorsChange={setProviderColors} favoriteAccents={favoriteAccents} onFavoriteAccentsChange={setFavoriteAccents} dataTextScale={dataTextScale} onDataTextScaleChange={setDataTextScale} sceneEffects={sceneEffects} onSceneEffectsChange={setSceneEffects} reducedMotion={reducedMotion} onReset={resetAppearance} onClose={()=>setAppearance(false)}/>}
    {sidebar&&<div className="scrim" onClick={()=>setSidebar(false)}/>}
  </div>;
}
