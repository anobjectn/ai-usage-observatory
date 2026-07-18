import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlarmClock, ArrowDownRight, ArrowUpRight, Atom, Bot, Check,
  ChevronLeft, ChevronRight, CircleDollarSign, Clock3, Database, FolderGit2,
  Gauge, Layers3, Menu, Orbit, PencilLine, RefreshCw, Search, Settings2,
  Sparkles, Tag, Telescope, Trash2, X, Zap,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, Brush, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { DashboardData, MetricRow, ProjectActivity, Session } from "./types";

type View = "overview" | "explorer" | "sessions" | "projects" | "models" | "limits";
type Metric = "totalTokens" | "totalCost" | "outputTokens";
type MetricRange = "1" | "7" | "14" | "30" | "120";
const nav: Array<{id:View;label:string;icon:typeof Orbit}> = [
  { id: "overview", label: "Overview", icon: Orbit },
  { id: "explorer", label: "Explorer", icon: Activity },
  { id: "sessions", label: "Sessions", icon: Layers3 },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "models", label: "Models", icon: Atom },
  { id: "limits", label: "Limits & sources", icon: Gauge },
];
const palette = ["#b7f25c", "#58d9cf", "#ff9e64", "#d7b3ff", "#78a8ff", "#f2d15c"];

const formatCompact = (value: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const formatMoney = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const friendlyProject = (value: string) => value.replace(/^-Users-[^-]+-/, "").replaceAll("-", " / ");
const providerSeries = [
  { key: "anthropic", label: "Claude", color: "#ff9e64" },
  { key: "codex", label: "Codex", color: "#78a8ff" },
  { key: "warp", label: "Warp", color: "#d7b3ff" },
] as const;

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

function tooltipModels(row: any, provider: typeof providerSeries[number]["key"]) {
  return (row?.models?.[provider] ?? []) as Array<{ name: string; tokens: number }>;
}

type TooltipProject = {
  projectId: string;
  projectName: string;
  tokens: number;
  providers: ProjectActivity[];
};

function tooltipProjects(row: any): TooltipProject[] {
  const projects = new Map<string, TooltipProject>();
  const groups = (row?.projectGroups ?? {}) as Record<string,ProjectActivity[]>;
  Object.values(groups).flat().forEach((activity) => {
    const project = projects.get(activity.projectId) ?? {projectId:activity.projectId,projectName:activity.projectName,tokens:0,providers:[]};
    project.tokens += activity.tokens;
    project.providers.push(activity);
    projects.set(activity.projectId, project);
  });
  return [...projects.values()].map((project) => ({
    ...project,
    providers: project.providers.sort((a, b) => providerSeries.findIndex((provider) => provider.key === a.provider) - providerSeries.findIndex((provider) => provider.key === b.provider)),
  })).sort((a, b) => b.tokens - a.tokens);
}

function ProviderChartTooltip({ active, payload, label, coordinate }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  const projects = tooltipProjects(row);
  const visibleProjects = projects.slice(0, 4);
  const projectTotal = projects.reduce((sum, project) => sum + project.tokens, 0);
  const opensRight = coordinate?.x < 176;
  return <div className={`chart-tooltip provider-tooltip${opensRight ? " provider-tooltip--right" : ""}`} key={label}>
    <span>{label}</span>
    {payload.filter((item:any) => item.value > 0).map((item:any) => {
      const models = tooltipModels(row, item.dataKey);
      const visibleModels = models.slice(0, 3);
      return <section className="tooltip-provider" key={item.dataKey}>
        <div className="tooltip-provider__head"><i style={{background:item.color}} /><strong>{item.name}</strong><b>{formatCompact(item.value)}</b></div>
        {visibleModels.length > 0 && <ul className="tooltip-provider-models">{visibleModels.map((model) => <li key={model.name}><span>{model.name}</span><b>{formatCompact(model.tokens)}</b></li>)}</ul>}
        {models.length > visibleModels.length && <small className="tooltip-model-more">+{models.length - visibleModels.length} more · {formatCompact(models.slice(3).reduce((sum, model) => sum + model.tokens, 0))}</small>}
      </section>;
    })}
    {visibleProjects.length > 0 && <section className="tooltip-projects">
      <div className="tooltip-projects__head"><strong>Projects</strong><b>{formatCompact(projectTotal)}</b></div>
      <ol className="tooltip-project-list">{visibleProjects.map((project) => <li key={project.projectId}>
        <div className="tooltip-project-row"><span>{project.projectName}</span><b>{formatCompact(project.tokens)}</b></div>
        <div className="tooltip-project-providers">{project.providers.map((providerActivity) => {
          const provider = providerSeries.find((item) => item.key === providerActivity.provider)!;
          const visibleModels = providerActivity.models.slice(0, 3);
          return <section key={providerActivity.provider}>
            <div className="tooltip-project-provider"><i style={{background:provider.color}}/><span>{provider.label}</span><b>{formatCompact(providerActivity.tokens)}</b></div>
            {visibleModels.length > 0 && <ul className="tooltip-project-models">{visibleModels.map((model) => <li key={model.model}><span>{model.model}</span><b>{formatCompact(model.tokens)}</b></li>)}</ul>}
            {providerActivity.models.length > visibleModels.length && <small className="tooltip-model-more project">+{providerActivity.models.length - visibleModels.length} more · {formatCompact(providerActivity.models.slice(3).reduce((sum, model) => sum + model.tokens, 0))}</small>}
          </section>;
        })}</div>
      </li>)}</ol>
      {projects.length > visibleProjects.length && <small className="tooltip-project-more">+{projects.length - visibleProjects.length} more projects · {formatCompact(projects.slice(4).reduce((sum, project) => sum + project.tokens, 0))}</small>}
    </section>}
  </div>;
}

function Timeline({ rows, metric, brush = false }: {rows:MetricRow[];metric:Metric;brush?:boolean}) {
  const data = rows.map((row) => ({ ...row, label: new Date(`${row.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) }));
  return <div className="chart-wrap" aria-label={`Usage by day, measured in ${metric}`} role="img">
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: brush ? 18 : 0 }}>
        <defs><linearGradient id="usageGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b7f25c" stopOpacity={0.36}/><stop offset="100%" stopColor="#b7f25c" stopOpacity={0}/></linearGradient></defs>
        <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
        <XAxis dataKey="label" tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false} minTickGap={30}/>
        <YAxis tickFormatter={(v) => metric === "totalCost" ? `$${formatCompact(v)}` : formatCompact(v)} tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false}/>
        <Tooltip content={<ChartTooltip metric={metric}/>} cursor={{stroke:"#b7f25c",strokeDasharray:"3 3"}}/>
        <Area type="monotone" dataKey={metric} name={metric === "totalCost" ? "Cost" : metric === "outputTokens" ? "Output" : "Tokens"} stroke="#b7f25c" strokeWidth={2.2} fill="url(#usageGlow)" activeDot={{r:5,fill:"#07100f",stroke:"#b7f25c",strokeWidth:2}}/>
        {brush && <Brush dataKey="label" height={22} stroke="#536159" fill="#111c19" travellerWidth={6}/>}
      </AreaChart>
    </ResponsiveContainer>
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

function metricTotals(rows: MetricRow[]) {
  return rows.reduce((sum, row) => ({ tokens: sum.tokens + row.totalTokens, cost: sum.cost + row.totalCost, output: sum.output + row.outputTokens, cache: sum.cache + row.cacheReadTokens }), {tokens:0,cost:0,output:0,cache:0});
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
    const modelMaps = { anthropic: new Map<string, number>(), codex: new Map<string, number>(), warp: new Map<string, number>() };
    if (row.agents?.length) {
      row.agents.forEach((item) => {
        const key = providerKey(item.agent);
        if (!key) return;
        values[key] += item.totalTokens;
        item.modelBreakdowns.forEach((model) => {
          const total = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
          modelMaps[key].set(model.modelName, (modelMaps[key].get(model.modelName) ?? 0) + total);
        });
      });
    } else {
      const key = providerKey(row.agent);
      if (key) {
        values[key] = row.totalTokens;
        row.modelBreakdowns.forEach((model) => {
          const total = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
          modelMaps[key].set(model.modelName, (modelMaps[key].get(model.modelName) ?? 0) + total);
        });
      }
    }
    const models = Object.fromEntries(Object.entries(modelMaps).map(([provider, entries]) => [provider, [...entries.entries()].map(([name, tokens]) => ({name, tokens})).sort((a, b) => b.tokens - a.tokens)]));
    const projectGroups = projectsByDay.get(row.period) ?? {};
    return { ...values, models, projectGroups, label: new Date(`${row.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  });
  const totals = providerSeries.map((provider) => ({ ...provider, value: data.reduce((sum, row) => sum + row[provider.key], 0) }));
  return <>
    <div className="provider-legend" aria-label="Daily activity providers">{totals.map((provider) => <div key={provider.key}><i style={{background:provider.color}}/><span>{provider.label}</span><b>{formatCompact(provider.value)}</b></div>)}</div>
    <div className="chart-wrap provider-chart" aria-label="Daily token usage split into Claude, Codex, and Warp sections" role="img">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, left: -18, bottom: 0 }}>
          <defs>{providerSeries.map((provider) => <linearGradient key={provider.key} id={`${provider.key}Area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={provider.color} stopOpacity={0.58}/><stop offset="100%" stopColor={provider.color} stopOpacity={0.13}/></linearGradient>)}</defs>
          <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
          <XAxis dataKey="label" tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false} minTickGap={30}/>
          <YAxis tickFormatter={formatCompact} tick={{fill:"#71807b",fontSize:12}} tickLine={false} axisLine={false}/>
          <Tooltip content={<ProviderChartTooltip/>} cursor={{stroke:"#71807b",strokeDasharray:"3 3"}} offset={0} isAnimationActive={false} wrapperStyle={{transition:"none"}}/>
          {providerSeries.map((provider) => <Area key={provider.key} type="monotone" dataKey={provider.key} name={provider.label} stackId="providers" stroke={provider.color} strokeWidth={1.8} fill={`url(#${provider.key}Area)`} activeDot={{r:4,fill:"#07100f",stroke:provider.color,strokeWidth:2}}/>)}
        </AreaChart>
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
    { provider: "codex", providerLabel: "Codex", state: codex?.status === "ok" ? "ok" : codex?.status === "stale" ? "stale" : "unavailable", buckets: codexBuckets, bankedResets, usedResetCount: quotas.history?.codexBankedResets.usedCount ?? 0 },
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
        {card.provider === "codex" && <div className="banked-resets"><div><span>Banked resets</span><b>{card.bankedResets.length} available</b></div><div className="reset-use"><span>Resets used</span><b>{quotas.history?.available ? `${card.usedResetCount} observed` : "Not tracked"}</b></div>{card.bankedResets.map((credit) => <small key={credit.id}><Sparkles/> {credit.title} · {credit.expiresAt ? `expires ${new Date(credit.expiresAt).toLocaleDateString(undefined, {month:"short", day:"numeric"})}` : "no expiry reported"}</small>)}</div>}
      </article>;
    })}</div>
  </section>;
}

function Overview({ data, daily, agent, metricRange, onMetricRangeChange, onSession }: {data:DashboardData;daily:MetricRow[];agent:string;metricRange:MetricRange;onMetricRangeChange:(range:MetricRange)=>void;onSession:(session:Session)=>void}) {
  const totals = metricTotals(daily);
  const previousDaily = metricRangeRows(data.daily, metricRange, 1).map((row) => selectAgent(row, agent)).filter(Boolean) as MetricRow[];
  const previousTotals = metricTotals(previousDaily);
  const activeBlock = data.blocks.find((block) => block.isActive) ?? data.blocks.at(-1);
  const agentTotals = new Map<string, number>();
  data.daily.slice(-30).forEach((row) => row.agents?.forEach((item) => agentTotals.set(item.agent, (agentTotals.get(item.agent) ?? 0) + item.totalTokens)));
  const agentChart = [...agentTotals.entries()].map(([name, value]) => ({name,value}));
  const agentGrandTotal = agentChart.reduce((sum, item) => sum + item.value, 0);
  const recent = data.sessions.filter((session) => agent === "all" || session.agent === agent).slice(0, 5);
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
      <div className="orbital-viz" aria-hidden="true"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="planet"><Telescope/></div><span className="signal signal-a"/><span className="signal signal-b"/></div>
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
        <div className="panel-heading"><div><span className="overline">USAGE TRAJECTORY</span><h2>Daily activity</h2></div><span className="method-chip"><i/> ccusage derived</span></div>
        <ProviderTimeline rows={daily} projectActivity={data.projectActivity} activeProvider={agent === "all" ? null : providerKey(agent)} />
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

function Explorer({ data, rows, metric, setMetric }: {data:DashboardData;rows:MetricRow[];metric:Metric;setMetric:(metric:Metric)=>void}) {
  const modelData = data.models.slice(0, 8).map((model) => ({name:model.model.replace(/^claude-|^gpt-/,""),value:metric === "totalCost" ? model.cost : metric === "outputTokens" ? model.outputTokens : model.tokens}));
  return <div className="view-stack page-enter"><PageTitle eyebrow="ANALYTICAL WORKSPACE" title="Usage explorer" description="Brush the timeline to focus a period. Global agent and path filters stay linked across the workspace."/>
    <section className="panel explorer-main"><div className="panel-heading"><div><span className="overline">120-DAY FIELD</span><h2>Activity over time</h2></div><Segmented value={metric} onChange={(v)=>setMetric(v as Metric)} options={[{value:"totalTokens",label:"Tokens"},{value:"totalCost",label:"Cost"},{value:"outputTokens",label:"Output"}]}/></div><Timeline rows={rows} metric={metric} brush/></section>
    <section className="split-grid"><article className="panel"><div className="panel-heading"><div><span className="overline">MODEL DISTRIBUTION</span><h2>Top model signals</h2></div></div><div className="bar-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={modelData} layout="vertical" margin={{left:10,right:16}}><CartesianGrid stroke="#26312e" horizontal={false}/><XAxis type="number" hide/><YAxis type="category" dataKey="name" width={100} tick={{fill:"#a8b5b0",fontSize:12}} axisLine={false} tickLine={false}/><Tooltip content={<ChartTooltip metric={metric}/>} cursor={{fill:"#15211d"}}/><Bar dataKey="value" name="Usage" fill="#58d9cf" radius={[0,6,6,0]}/></BarChart></ResponsiveContainer></div></article><article className="panel"><div className="panel-heading"><div><span className="overline">READ / CREATE / OUTPUT</span><h2>Token composition</h2></div></div><Composition rows={rows}/></article></section>
  </div>;
}

function Composition({rows}:{rows:MetricRow[]}) {
  const totals = rows.reduce((sum,row)=>({input:sum.input+row.inputTokens,output:sum.output+row.outputTokens,read:sum.read+row.cacheReadTokens,create:sum.create+row.cacheCreationTokens}),{input:0,output:0,read:0,create:0});
  const all = totals.input+totals.output+totals.read+totals.create || 1;
  const items = [{label:"Cache read",value:totals.read,color:palette[0]},{label:"Input",value:totals.input,color:palette[1]},{label:"Cache creation",value:totals.create,color:palette[2]},{label:"Output",value:totals.output,color:palette[3]}];
  return <div className="composition"><div className="composition-bar">{items.map(item=><i key={item.label} style={{width:`${item.value/all*100}%`,background:item.color}}/>)}</div>{items.map(item=><div className="composition-row" key={item.label}><i style={{background:item.color}}/><span>{item.label}</span><b>{formatCompact(item.value)}</b><small>{Math.round(item.value/all*100)}%</small></div>)}</div>;
}

function Sessions({sessions,onEdit}:{sessions:Session[];onEdit:(session:Session)=>void}) {
  const [query,setQuery] = useState(""); const [page,setPage] = useState(1); const pageSize=15;
  const filtered=sessions.filter(s=>`${s.agent} ${s.modelsUsed.join(" ")} ${s.cwd} ${s.pathTags.join(" ")} ${s.annotation.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize)); const pageRows=filtered.slice((page-1)*pageSize,page*pageSize);
  useEffect(()=>setPage(1),[query,sessions]);
  return <div className="view-stack page-enter"><PageTitle eyebrow="SESSION LEDGER" title="Trace every session" description="Search agent history, inspect working directories, and add local tags or notes without storing transcript content." actions={<label className="search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search sessions…"/></label>}/><section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Session</th><th>Agent</th><th>Working directory</th><th>Tokens</th><th>Cost</th><th>Last activity</th><th></th></tr></thead><tbody>{pageRows.map(session=><tr key={session.sessionId}><td><b>{session.modelsUsed[0] ?? "Unknown"}</b><small>{session.period.slice(0,18)}</small></td><td><span className={`agent-pill ${session.agent}`}>{session.agent}</span></td><td><span className="cwd" title={session.cwd ?? "Unavailable"}>{session.cwd ?? "Path unavailable"}</span><span className="mini-tags">{[...session.pathTags,...session.annotation.tags].slice(0,3).map(tag=><i key={tag}>{tag}</i>)}</span></td><td><b>{formatCompact(session.totalTokens)}</b><small>{formatCompact(session.outputTokens)} output</small></td><td><b>{formatMoney(session.totalCost)}</b><small>ccusage</small></td><td>{session.metadata?.lastActivity ? formatDate(session.metadata.lastActivity) : "—"}</td><td><button className="icon-button" onClick={()=>onEdit(session)} aria-label="Edit annotation"><PencilLine/></button></td></tr>)}</tbody></table></div>{!pageRows.length&&<Empty text="No sessions match those filters."/>}<div className="pagination"><span>{filtered.length} sessions</span><div><button disabled={page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft/></button><span>{page} / {pages}</span><button disabled={page===pages} onClick={()=>setPage(p=>p+1)}><ChevronRight/></button></div></div></section></div>;
}

function Projects({data}:{data:DashboardData}) { return <div className="view-stack page-enter"><PageTitle eyebrow="PROJECT CARTOGRAPHY" title="Where the work happened" description="Project grouping is source-dependent. Claude project instances are shown here; path rules extend working-directory visibility across agents."/><section className="card-list">{data.projects.map((project,index)=><article className="rank-card" key={project.name}><span className="rank">{String(index+1).padStart(2,"0")}</span><div className="rank-main"><h3>{friendlyProject(project.name)}</h3><p>{project.models.slice(0,3).join(" · ")}</p><div className="micro-chart">{project.trend.slice(-14).map((point,i)=><i key={i} style={{height:`${Math.max(8,point.totalTokens/Math.max(...project.trend.map(p=>p.totalTokens))*100)}%`}}/>)}</div></div><div className="rank-stat"><span>Tokens</span><b>{formatCompact(project.tokens)}</b></div><div className="rank-stat"><span>Cost</span><b>{formatMoney(project.cost)}</b></div><div className="rank-stat"><span>Active days</span><b>{project.sessions}</b></div></article>)}</section>{!data.projects.length&&<Empty text="No source-exposed projects found in this period."/>}</div> }

function Models({data}:{data:DashboardData}) { const max=Math.max(...data.models.map(m=>m.cost),1); return <div className="view-stack page-enter"><PageTitle eyebrow="MODEL SPECTROGRAPH" title="Model mix and efficiency" description="Compare API-equivalent cost, output volume, and cache behavior using ccusage as the sole analytical cost source."/><section className="model-grid">{data.models.map((model,index)=><article className="model-card" key={model.model}><div className="model-card__head"><span style={{background:palette[index%palette.length]}}>{model.model.startsWith("gpt")?"G":"C"}</span><div><h3>{model.model}</h3><p>{model.agents.join(" · ")}</p></div></div><div className="model-cost"><strong>{formatMoney(model.cost)}</strong><span>API-equivalent</span></div><div className="meter"><i style={{width:`${model.cost/max*100}%`,background:palette[index%palette.length]}}/></div><dl><div><dt>Total tokens</dt><dd>{formatCompact(model.tokens)}</dd></div><div><dt>Output</dt><dd>{formatCompact(model.outputTokens)}</dd></div><div><dt>Cache read</dt><dd>{formatCompact(model.cacheReadTokens)}</dd></div></dl></article>)}</section></div> }

function Limits({data,onRules}:{data:DashboardData;onRules:()=>void}) {
  const budget=Number(data.settings.monthlyBudget??250); const month=data.monthly.at(-1)?.totalCost??0; const ratio=Math.min(100,month/budget*100);
  return <div className="view-stack page-enter"><PageTitle eyebrow="LIMITS & METHODOLOGY" title="Know what every number means" description="Provider quota, locally reconstructed activity, and personal budgets stay intentionally separate." actions={<button className="secondary-button" onClick={onRules}><Tag/> Path rules</button>}/><section className="limits-grid"><article className="panel distinction"><span className="source-symbol provider"><Gauge/></span><span className="overline">PROVIDER QUOTA</span><h2>{data.quotas.available?"Connected":"Not connected"}</h2><p>{data.quotas.available?"Authoritative allowance data from quota-service.":"quota-service is optional and currently unavailable. Analytics continue normally."}</p><span className="method-chip"><i/> provider reported</span></article><article className="panel distinction"><span className="source-symbol local"><Clock3/></span><span className="overline">LOCAL ACTIVITY BLOCK</span><h2>{data.blocks.find(b=>b.isActive)?"Active window":"Recent window"}</h2><p>Reconstructed by ccusage from local {data.blockScope} records.</p><span className="method-chip local"><i/> locally calculated</span></article><article className="panel distinction"><span className="source-symbol budget"><CircleDollarSign/></span><span className="overline">PERSONAL BUDGET</span><h2>{formatMoney(month)} / {formatMoney(budget)}</h2><p>Your configurable target, not a provider billing limit.</p><div className="budget-bar"><i style={{width:`${ratio}%`}}/></div><span className="method-chip budget"><i/> user defined</span></article></section><section className="panel"><div className="panel-heading"><div><span className="overline">DATA SOURCE HEALTH</span><h2>Collection boundaries</h2></div><span>Updated {formatDate(data.collectedAt)}</span></div><div className="source-list">{data.sources.map(source=><div key={source.name}><span className={`status-dot ${source.status}`}/><div><b>{source.name}</b><small>{source.kind}</small></div><p>{source.detail}</p><span className={`status-label ${source.status}`}>{source.status}</span></div>)}</div></section></div>;
}

function PageTitle({eyebrow,title,description,actions}:{eyebrow:string;title:string;description:string;actions?:React.ReactNode}) { return <header className="page-title"><div><span className="overline">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions}</header> }
function Segmented({value,onChange,options,label}:{value:string;onChange:(v:string)=>void;options:Array<{value:string;label:string}>;label?:string}) { return <div className="segmented" aria-label={label}>{options.map(option=><button type="button" key={option.value} className={value===option.value?"active":""} aria-pressed={value===option.value} onClick={()=>onChange(option.value)}>{option.label}</button>)}</div> }
function Empty({text}:{text:string}) { return <div className="empty"><Orbit/><p>{text}</p></div> }

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
  const {data,error,loading,load}=useDashboard(); const [view,setView]=useState<View>("overview"); const [agent,setAgent]=useState("all"); const [days,setDays]=useState<MetricRange>("30"); const [pathTag,setPathTag]=useState("all"); const [metric,setMetric]=useState<Metric>("totalTokens"); const [sidebar,setSidebar]=useState(false); const [sidebarCollapsed,setSidebarCollapsed]=useState(false); const [session,setSession]=useState<Session|null>(null); const [rules,setRules]=useState(false);
  const agents=useMemo(()=>data?[...new Set(data.daily.flatMap(row=>row.agents?.map(a=>a.agent)??[]))]:[],[data]);
  const pathTags=useMemo(()=>data?[...new Set(data.sessions.flatMap(s=>s.pathTags))]:[],[data]);
  const daily=useMemo(()=>data ? metricRangeRows(data.daily, days).map(row=>selectAgent(row,agent)).filter(Boolean) as MetricRow[] : [],[data,agent,days]);
  const sessions=useMemo(()=>data?.sessions.filter(s=>(agent==="all"||s.agent===agent)&&(pathTag==="all"||s.pathTags.includes(pathTag)))??[],[data,agent,pathTag]);
  if (loading&&!data) return <div className="boot"><div className="boot-orbit"><Orbit/></div><span>Calibrating local instruments…</span></div>;
  if (error&&!data) return <div className="boot error-state"><Database/><h1>Observatory is offline</h1><p>{error}</p><button className="primary-button" onClick={()=>load()}>Try again</button></div>;
  if (!data) return null;
  const current=nav.find(item=>item.id===view)!;
  return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <aside className={sidebar?"open":""}><div className="brand"><span><Orbit/></span><div><b>Usage</b><small>OBSERVATORY</small></div><button className="sidebar-toggle" onClick={()=>setSidebarCollapsed(collapsed=>!collapsed)} aria-label={sidebarCollapsed?"Expand navigation":"Collapse navigation"} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed?<ChevronRight/>:<ChevronLeft/>}</button><button className="sidebar-close" onClick={()=>setSidebar(false)} aria-label="Close navigation"><X/></button></div><nav>{nav.map(item=><button key={item.id} className={view===item.id?"active":""} onClick={()=>{setView(item.id);setSidebar(false)}} title={sidebarCollapsed?item.label:undefined}><item.icon/><span>{item.label}</span>{view===item.id&&<i/>}</button>)}</nav><div className="side-status"><span className="status-dot healthy"/><div><b>Local systems nominal</b><small>ccusage v{data.ccusageVersion}</small></div></div><button className="settings-link" onClick={()=>setRules(true)} title={sidebarCollapsed?"Path rules":undefined}><Settings2/> <b>Path rules</b> <span>{data.rules.length}</span></button><p className="privacy-note">No raw usage records leave this machine.</p></aside>
    <main><header className="topbar"><button className="menu-button" onClick={()=>setSidebar(true)}><Menu/></button><div className="breadcrumbs"><span>Observatory</span><ChevronRight/><b>{current.label}</b></div><div className="global-controls"><label><span>Agent</span><select value={agent} onChange={e=>setAgent(e.target.value)}><option value="all">All agents</option>{agents.map(a=><option value={a} key={a}>{a}</option>)}</select></label><label><span>Path</span><select value={pathTag} onChange={e=>setPathTag(e.target.value)}><option value="all">All paths</option>{pathTags.map(tag=><option value={tag} key={tag}>{tag}</option>)}</select></label>{view!=="overview"&&<Segmented label="Dashboard time span" value={days} onChange={(value)=>setDays(value as MetricRange)} options={[{value:"1",label:"1d"},{value:"7",label:"7d"},{value:"14",label:"14d"},{value:"30",label:"30d"},{value:"120",label:"120d"}]}/>}<button className="refresh-button" onClick={()=>load(true)} title="Refresh local sources"><RefreshCw className={loading?"spin":""}/><span>{loading?"Collecting":"Refresh"}</span></button></div></header>
      {data.refresh.stale&&<div className="stale-banner">Showing the last successful collection. {data.refresh.lastError}</div>}
      <div className="content">
        {view==="overview"&&<Overview data={data} daily={daily} agent={agent} metricRange={days} onMetricRangeChange={setDays} onSession={setSession}/>}
        {view==="explorer"&&<Explorer data={data} rows={daily} metric={metric} setMetric={setMetric}/>}
        {view==="sessions"&&<Sessions sessions={sessions} onEdit={setSession}/>}
        {view==="projects"&&<Projects data={data}/>}
        {view==="models"&&<Models data={data}/>}
        {view==="limits"&&<Limits data={data} onRules={()=>setRules(true)}/>}
      </div>
    </main>
    {session&&<AnnotationModal session={session} onClose={()=>setSession(null)} onSaved={()=>load()}/>} {rules&&<RulesModal data={data} onClose={()=>setRules(false)} onSaved={()=>load(true)}/>} {sidebar&&<div className="scrim" onClick={()=>setSidebar(false)}/>}
  </div>;
}
