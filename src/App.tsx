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
import type { DashboardData, MetricRow, Session } from "./types";

type View = "overview" | "explorer" | "sessions" | "projects" | "models" | "limits";
type Metric = "totalTokens" | "totalCost" | "outputTokens";
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
  { key: "anthropic", label: "Anthropic", color: "#ff9e64" },
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

function MetricCard({ eyebrow, value, detail, trend, icon: Icon }: {eyebrow:string;value:string;detail:string;trend?:number;icon:typeof Orbit}) {
  return <article className="metric-card">
    <div className="metric-card__top"><span>{eyebrow}</span><Icon size={16} /></div>
    <strong>{value}</strong>
    <div className="metric-detail"><span>{detail}</span>{trend !== undefined && <span className={trend >= 0 ? "trend-up" : "trend-down"}>{trend >= 0 ? <ArrowUpRight /> : <ArrowDownRight />}{Math.abs(trend)}%</span>}</div>
  </article>;
}

function ChartTooltip({ active, payload, label, metric }: any) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><span>{label}</span>{payload.map((item:any) => <div key={item.dataKey}><i style={{background:item.color}} />{item.name}: <b>{metric === "totalCost" ? formatMoney(item.value) : formatCompact(item.value)}</b></div>)}</div>;
}

function Timeline({ rows, metric, brush = false }: {rows:MetricRow[];metric:Metric;brush?:boolean}) {
  const data = rows.map((row) => ({ ...row, label: new Date(`${row.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) }));
  return <div className="chart-wrap" aria-label={`Usage by day, measured in ${metric}`} role="img">
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: brush ? 18 : 0 }}>
        <defs><linearGradient id="usageGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b7f25c" stopOpacity={0.36}/><stop offset="100%" stopColor="#b7f25c" stopOpacity={0}/></linearGradient></defs>
        <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
        <XAxis dataKey="label" tick={{fill:"#71807b",fontSize:11}} tickLine={false} axisLine={false} minTickGap={30}/>
        <YAxis tickFormatter={(v) => metric === "totalCost" ? `$${formatCompact(v)}` : formatCompact(v)} tick={{fill:"#71807b",fontSize:11}} tickLine={false} axisLine={false}/>
        <Tooltip content={<ChartTooltip metric={metric}/>} cursor={{stroke:"#b7f25c",strokeDasharray:"3 3"}}/>
        <Area type="monotone" dataKey={metric} name={metric === "totalCost" ? "Cost" : metric === "outputTokens" ? "Output" : "Tokens"} stroke="#b7f25c" strokeWidth={2.2} fill="url(#usageGlow)" activeDot={{r:5,fill:"#07100f",stroke:"#b7f25c",strokeWidth:2}}/>
        {brush && <Brush dataKey="label" height={22} stroke="#536159" fill="#111c19" travellerWidth={6}/>}
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}

function ProviderTimeline({ rows }: {rows:MetricRow[]}) {
  const data = rows.map((row) => {
    const values = { anthropic: 0, codex: 0, warp: 0 };
    if (row.agents?.length) {
      row.agents.forEach((item) => {
        const key = providerKey(item.agent);
        if (key) values[key] += item.totalTokens;
      });
    } else {
      const key = providerKey(row.agent);
      if (key) values[key] = row.totalTokens;
    }
    return { ...values, label: new Date(`${row.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  });
  const totals = providerSeries.map((provider) => ({ ...provider, value: data.reduce((sum, row) => sum + row[provider.key], 0) }));
  return <>
    <div className="provider-legend" aria-label="Daily activity providers">{totals.map((provider) => <div key={provider.key}><i style={{background:provider.color}}/><span>{provider.label}</span><b>{formatCompact(provider.value)}</b></div>)}</div>
    <div className="chart-wrap provider-chart" aria-label="Daily token usage split into Anthropic, Codex, and Warp sections" role="img">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, left: -18, bottom: 0 }}>
          <defs>{providerSeries.map((provider) => <linearGradient key={provider.key} id={`${provider.key}Area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={provider.color} stopOpacity={0.58}/><stop offset="100%" stopColor={provider.color} stopOpacity={0.13}/></linearGradient>)}</defs>
          <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false}/>
          <XAxis dataKey="label" tick={{fill:"#71807b",fontSize:11}} tickLine={false} axisLine={false} minTickGap={30}/>
          <YAxis tickFormatter={formatCompact} tick={{fill:"#71807b",fontSize:11}} tickLine={false} axisLine={false}/>
          <Tooltip content={<ChartTooltip metric="totalTokens"/>} cursor={{stroke:"#71807b",strokeDasharray:"3 3"}}/>
          {providerSeries.map((provider) => <Area key={provider.key} type="monotone" dataKey={provider.key} name={provider.label} stackId="providers" stroke={provider.color} strokeWidth={1.8} fill={`url(#${provider.key}Area)`} activeDot={{r:4,fill:"#07100f",stroke:provider.color,strokeWidth:2}}/>)}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  </>;
}

type QuotaDial = {
  id: string;
  provider: "anthropic" | "codex" | "warp";
  providerLabel: string;
  windowLabel: string;
  usedPercent: number | null;
  resetAt: number | null;
  resetVerb: "resets" | "renews";
  state: "ok" | "stale" | "suspended" | "unavailable" | "expired";
  detail: string;
};

function quotaDials(quotas: DashboardData["quotas"]): QuotaDial[] {
  const reports = new Map(quotas.usage?.providers.map((provider) => [provider.provider, provider]) ?? []);
  const expected = [
    { provider: "anthropic", providerLabel: "Anthropic", key: "fiveHour", windowLabel: "5-hour", resetVerb: "resets" },
    { provider: "anthropic", providerLabel: "Anthropic", key: "weekly", windowLabel: "Weekly", resetVerb: "resets" },
    { provider: "codex", providerLabel: "Codex", key: "fiveHour", windowLabel: "5-hour", resetVerb: "resets" },
    { provider: "codex", providerLabel: "Codex", key: "weekly", windowLabel: "Weekly", resetVerb: "resets" },
    { provider: "warp", providerLabel: "Warp", key: "pool", windowLabel: "Monthly", resetVerb: "renews" },
  ] as const;
  return expected.map((item) => {
    const report = reports.get(item.provider);
    const window = report?.snapshot?.kind === "window" && item.key !== "pool" ? report.snapshot[item.key] : null;
    const pool = report?.snapshot?.kind === "pool" && item.key === "pool" ? report.snapshot.pool : null;
    const usedPercent = window?.usedPercent ?? pool?.usedPercent ?? null;
    const resetAt = window?.resetsAt ?? pool?.refreshesAt ?? null;
    const hasValue = usedPercent !== null && Number.isFinite(usedPercent);
    const suspended = item.provider === "codex" && item.key === "fiveHour" && report?.snapshot?.kind === "window" && !window;
    const expired = hasValue && resetAt !== null && resetAt <= Date.now();
    const state = suspended ? "suspended" : report?.status === "unavailable" || report?.status === "unknown" || !hasValue ? "unavailable" : expired ? "expired" : report?.status === "stale" ? "stale" : "ok";
    const detail = pool ? `${pool.used.toLocaleString()} / ${pool.limit.toLocaleString()} requests` : hasValue ? `${Math.max(0, 100 - usedPercent).toFixed(0)}% available` : suspended ? "temporarily suspended" : report?.error ?? "not currently reported";
    return { id: `${item.provider}-${item.key}`, provider: item.provider, providerLabel: item.providerLabel, windowLabel: item.windowLabel, usedPercent, resetAt, resetVerb: item.resetVerb, state, detail };
  });
}

function QuotaDials({ quotas }: {quotas: DashboardData["quotas"]}) {
  const dials = quotaDials(quotas);
  return <section className="quota-panel panel">
    <div className="panel-heading"><div><span className="overline">SUBSCRIPTION WINDOWS</span><h2>Usage & resets</h2></div><span className="method-chip"><i/> provider reported</span></div>
    <div className="quota-grid">{dials.map((dial) => {
      const percent = dial.usedPercent === null ? null : Math.max(0, Math.min(100, dial.usedPercent));
      const stateLabel = dial.state === "ok" ? "current" : dial.state;
      return <article className={`quota-card ${dial.provider} ${dial.state}`} key={dial.id} aria-label={`${dial.providerLabel} ${dial.windowLabel} window: ${percent === null ? stateLabel : `${percent.toFixed(0)}% used`}`}>
        <div className="quota-card__head"><span>{dial.providerLabel}</span><i>{stateLabel}</i></div>
        <div className="quota-dial" style={{"--used":`${percent ?? 0}%`} as React.CSSProperties}><div><strong>{percent === null ? "—" : `${percent.toFixed(0)}%`}</strong><span>{percent === null ? dial.state : "used"}</span></div></div>
        <div className="quota-card__copy"><b>{dial.windowLabel} window</b><span>{dial.detail}</span><small>{dial.state === "suspended" ? "5-hour rate limit is temporarily suspended" : resetCopy(dial.resetAt, dial.resetVerb)}</small></div>
      </article>;
    })}</div>
  </section>;
}

function Overview({ data, daily, agent, onSession }: {data:DashboardData;daily:MetricRow[];agent:string;onSession:(session:Session)=>void}) {
  const totals = daily.reduce((sum, row) => ({ tokens: sum.tokens + row.totalTokens, cost: sum.cost + row.totalCost, output: sum.output + row.outputTokens, cache: sum.cache + row.cacheReadTokens }), {tokens:0,cost:0,output:0,cache:0});
  const today = daily.at(-1);
  const activeBlock = data.blocks.find((block) => block.isActive) ?? data.blocks.at(-1);
  const agentTotals = new Map<string, number>();
  data.daily.slice(-30).forEach((row) => row.agents?.forEach((item) => agentTotals.set(item.agent, (agentTotals.get(item.agent) ?? 0) + item.totalTokens)));
  const agentChart = [...agentTotals.entries()].map(([name, value]) => ({name,value}));
  const agentGrandTotal = agentChart.reduce((sum, item) => sum + item.value, 0);
  const recent = data.sessions.filter((session) => agent === "all" || session.agent === agent).slice(0, 5);
  const cacheShare = totals.tokens ? Math.round(totals.cache / totals.tokens * 100) : 0;
  return <div className="view-stack page-enter">
    <section className="hero-grid">
      <div>
        <p className="kicker"><span /> LIVE LOCAL TELEMETRY</p>
        <h1>Your coding universe,<br/><em>finally observable.</em></h1>
        <p className="hero-copy">A local-first view of where agent time, tokens, and estimated API-equivalent cost are going.</p>
      </div>
      <div className="orbital-viz" aria-hidden="true"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="planet"><Telescope/></div><span className="signal signal-a"/><span className="signal signal-b"/></div>
    </section>
    <section className="metric-grid">
      <MetricCard eyebrow="PERIOD TOKENS" value={formatCompact(totals.tokens)} detail={`${daily.length} active days`} trend={12} icon={Zap}/>
      <MetricCard eyebrow="API-EQUIVALENT COST" value={formatMoney(totals.cost)} detail="ccusage · offline pricing" icon={CircleDollarSign}/>
      <MetricCard eyebrow="OUTPUT TOKENS" value={formatCompact(totals.output)} detail={`${today ? formatCompact(today.outputTokens) : 0} latest day`} trend={-4} icon={Sparkles}/>
      <MetricCard eyebrow="CACHE SHARE" value={`${cacheShare}%`} detail={`${formatCompact(totals.cache)} read tokens`} icon={Database}/>
    </section>
    <QuotaDials quotas={data.quotas}/>
    <section className="dashboard-grid">
      <article className="panel panel-wide">
        <div className="panel-heading"><div><span className="overline">USAGE TRAJECTORY</span><h2>Daily activity</h2></div><span className="method-chip"><i/> ccusage derived</span></div>
        <ProviderTimeline rows={daily} />
      </article>
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
    <section className="split-grid"><article className="panel"><div className="panel-heading"><div><span className="overline">MODEL DISTRIBUTION</span><h2>Top model signals</h2></div></div><div className="bar-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={modelData} layout="vertical" margin={{left:10,right:16}}><CartesianGrid stroke="#26312e" horizontal={false}/><XAxis type="number" hide/><YAxis type="category" dataKey="name" width={100} tick={{fill:"#a8b5b0",fontSize:11}} axisLine={false} tickLine={false}/><Tooltip content={<ChartTooltip metric={metric}/>} cursor={{fill:"#15211d"}}/><Bar dataKey="value" name="Usage" fill="#58d9cf" radius={[0,6,6,0]}/></BarChart></ResponsiveContainer></div></article><article className="panel"><div className="panel-heading"><div><span className="overline">READ / CREATE / OUTPUT</span><h2>Token composition</h2></div></div><Composition rows={rows}/></article></section>
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
function Segmented({value,onChange,options}:{value:string;onChange:(v:string)=>void;options:Array<{value:string;label:string}>}) { return <div className="segmented">{options.map(option=><button key={option.value} className={value===option.value?"active":""} onClick={()=>onChange(option.value)}>{option.label}</button>)}</div> }
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
  const {data,error,loading,load}=useDashboard(); const [view,setView]=useState<View>("overview"); const [agent,setAgent]=useState("all"); const [days,setDays]=useState("30"); const [pathTag,setPathTag]=useState("all"); const [metric,setMetric]=useState<Metric>("totalTokens"); const [sidebar,setSidebar]=useState(false); const [session,setSession]=useState<Session|null>(null); const [rules,setRules]=useState(false);
  const agents=useMemo(()=>data?[...new Set(data.daily.flatMap(row=>row.agents?.map(a=>a.agent)??[]))]:[],[data]);
  const pathTags=useMemo(()=>data?[...new Set(data.sessions.flatMap(s=>s.pathTags))]:[],[data]);
  const daily=useMemo(()=>{if(!data)return[]; const cutoff=Date.now()-Number(days)*86_400_000; return data.daily.filter(row=>new Date(`${row.period}T23:59:59`).getTime()>=cutoff).map(row=>selectAgent(row,agent)).filter(Boolean) as MetricRow[];},[data,agent,days]);
  const sessions=useMemo(()=>data?.sessions.filter(s=>(agent==="all"||s.agent===agent)&&(pathTag==="all"||s.pathTags.includes(pathTag)))??[],[data,agent,pathTag]);
  if (loading&&!data) return <div className="boot"><div className="boot-orbit"><Orbit/></div><span>Calibrating local instruments…</span></div>;
  if (error&&!data) return <div className="boot error-state"><Database/><h1>Observatory is offline</h1><p>{error}</p><button className="primary-button" onClick={()=>load()}>Try again</button></div>;
  if (!data) return null;
  const current=nav.find(item=>item.id===view)!;
  return <div className="app-shell">
    <aside className={sidebar?"open":""}><div className="brand"><span><Orbit/></span><div><b>Usage</b><small>OBSERVATORY</small></div><button onClick={()=>setSidebar(false)}><X/></button></div><nav>{nav.map(item=><button key={item.id} className={view===item.id?"active":""} onClick={()=>{setView(item.id);setSidebar(false)}}><item.icon/><span>{item.label}</span>{view===item.id&&<i/>}</button>)}</nav><div className="side-status"><span className="status-dot healthy"/><div><b>Local systems nominal</b><small>ccusage v{data.ccusageVersion}</small></div></div><button className="settings-link" onClick={()=>setRules(true)}><Settings2/> Path rules <span>{data.rules.length}</span></button><p className="privacy-note">No raw usage records leave this machine.</p></aside>
    <main><header className="topbar"><button className="menu-button" onClick={()=>setSidebar(true)}><Menu/></button><div className="breadcrumbs"><span>Observatory</span><ChevronRight/><b>{current.label}</b></div><div className="global-controls"><label><span>Agent</span><select value={agent} onChange={e=>setAgent(e.target.value)}><option value="all">All agents</option>{agents.map(a=><option value={a} key={a}>{a}</option>)}</select></label><label><span>Path</span><select value={pathTag} onChange={e=>setPathTag(e.target.value)}><option value="all">All paths</option>{pathTags.map(tag=><option value={tag} key={tag}>{tag}</option>)}</select></label><Segmented value={days} onChange={setDays} options={[{value:"7",label:"7d"},{value:"30",label:"30d"},{value:"120",label:"120d"}]}/><button className="refresh-button" onClick={()=>load(true)} title="Refresh local sources"><RefreshCw className={loading?"spin":""}/><span>{loading?"Collecting":"Refresh"}</span></button></div></header>
      {data.refresh.stale&&<div className="stale-banner">Showing the last successful collection. {data.refresh.lastError}</div>}
      <div className="content">
        {view==="overview"&&<Overview data={data} daily={daily} agent={agent} onSession={setSession}/>} {view==="explorer"&&<Explorer data={data} rows={daily} metric={metric} setMetric={setMetric}/>} {view==="sessions"&&<Sessions sessions={sessions} onEdit={setSession}/>} {view==="projects"&&<Projects data={data}/>} {view==="models"&&<Models data={data}/>} {view==="limits"&&<Limits data={data} onRules={()=>setRules(true)}/>}
      </div>
    </main>
    {session&&<AnnotationModal session={session} onClose={()=>setSession(null)} onSaved={()=>load()}/>} {rules&&<RulesModal data={data} onClose={()=>setRules(false)} onSaved={()=>load(true)}/>} {sidebar&&<div className="scrim" onClick={()=>setSidebar(false)}/>}
  </div>;
}
