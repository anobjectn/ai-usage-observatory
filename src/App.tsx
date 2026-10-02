import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { version as appVersion } from "../package.json";
import { systemTimeZone } from "./reporting-time";
import { providerFromAgent } from "./provider";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Gauge,
  Menu,
  Orbit,
  Palette,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  SceneEffectsContext,
  Starfield,
  TesseractCore,
  type ProviderColors,
  type SceneEffects,
} from "./scene";
import type { MetricRow, Session } from "./types";
import { AgentFilter, InformationSources, TimeRangeControl, type AgentFilterGroup } from "./views/chrome";
import {
  branchState,
  buildAgentTree,
  matchesEntry,
  matchesAgentSelection,
  modelEntry,
  selectAgentRow,
  toggleBranch,
  toggleModel,
  type AgentSelection,
} from "./agent-filter";
import { familyOf } from "./model-family";
import {
  availableDateRange,
  metricRangeRows,
  resolvedDateRange,
  type DateRange,
  type MetricRange,
} from "./time-range";
import { parseUrlFilters, writeUrlFilters } from "./url-filters";
import { type DataFacets } from "./views/data/insights";
import { ChartPinProvider } from "./components/chart-pins";
import {
  type View,
  initialView,
  initialSessionId,
  type Metric,
  savedSidebarCollapsed,
  type QuickOverviewMode,
  savedQuickOverviewMode,
  savedAccent,
  savedProviderColors,
  savedFavoriteAccents,
  savedDataTextScale,
  savedInterfaceTextScale,
  savedSceneEffects,
  usePrefersReducedMotion,
  sidebarCollapsedStorageKey,
  quickOverviewModeStorageKey,
  faviconHref,
  accentStorageKey,
  providerColorsStorageKey,
  favoriteAccentsStorageKey,
  sceneEffectsStorageKey,
  convertLegacyViewUrl,
  dataTextScaleStorageKey,
  interfaceTextScaleStorageKey,
  viewHref,
  sessionHref,
  defaultAccent,
  defaultProviderColors,
  defaultFavoriteAccents,
  defaultDataTextScale,
  defaultInterfaceTextScale,
  defaultSceneEffects,
  nav,
} from "./app/preferences";
import { providerSeries } from "./app/format";
import { withoutCacheDashboardData, pathFilteredRows, sessionDate } from "./app/analytics";
import { useDashboard } from "./hooks/use-dashboard";
import { type BenchmarkSiteId, BenchmarkSplitLauncher } from "./components/benchmark-launcher";
const Overview = lazy(() => import("./views/overview").then((module) => ({ default: module.Overview })));
const Explorer = lazy(() => import("./views/explorer").then((module) => ({ default: module.Explorer })));
const Sessions = lazy(() => import("./views/sessions").then((module) => ({ default: module.Sessions })));
const Projects = lazy(() => import("./views/projects").then((module) => ({ default: module.Projects })));
const Models = lazy(() => import("./views/models").then((module) => ({ default: module.Models })));
const Sources = lazy(() => import("./views/sources").then((module) => ({ default: module.Sources })));
const AnnotationModal = lazy(() => import("./components/app-modals").then((module) => ({ default: module.AnnotationModal })));
const RulesModal = lazy(() => import("./components/app-modals").then((module) => ({ default: module.RulesModal })));
const AnthropicWebImportModal = lazy(() => import("./components/app-modals").then((module) => ({ default: module.AnthropicWebImportModal })));
const AppearanceModal = lazy(() => import("./components/app-modals").then((module) => ({ default: module.AppearanceModal })));
const BenchmarkModal = lazy(() => import("./components/app-modals").then((module) => ({ default: module.BenchmarkModal })));
const QuickOverviewModal = lazy(() => import("./components/app-modals").then((module) => ({ default: module.QuickOverviewModal })));

export function App() {
  const { data: collectedData, error, loading, load, lastSuccessAt } = useDashboard();
  const [initialFilters] = useState(() => parseUrlFilters(window.location.search));
  const [showCache, setShowCache] = useState(initialFilters.showCache);
  const [dataFacets, setDataFacets] = useState<DataFacets>(() => ({
    outliers: "all",
    finding: "all",
    effort: "all",
    findingPage: 1,
    // The allowance target policy is a durable preference, not a per-visit facet.
    policy: localStorage.getItem("allowance-policy") === "headroom" ? "headroom" : "capture",
  }));
  const data = useMemo(
    () =>
      collectedData && !showCache
        ? withoutCacheDashboardData(collectedData)
        : collectedData,
    [collectedData, showCache],
  );
  const [view, setView] = useState<View>(initialView);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(
    initialSessionId,
  );
  const [agent, setAgent] = useState<AgentSelection>(initialFilters.agent);
  const [days, setDays] = useState<MetricRange>(initialFilters.range);
  const [customRange, setCustomRange] = useState<DateRange | null>(initialFilters.customRange);
  const [pathTag, setPathTag] = useState(initialFilters.pathTag);
  const [metric, setMetric] = useState<Metric>("totalTokens");
  const [sidebar, setSidebar] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const filtersButton = useRef<HTMLButtonElement | null>(null);
  const filtersTray = useRef<HTMLDivElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(savedSidebarCollapsed);
  const sidebarHoverTimeout = useRef<number | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [rules, setRules] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [webImport, setWebImport] = useState(false);
  const [benchmarkSite, setBenchmarkSite] = useState<BenchmarkSiteId | null>(null);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [quickOverview, setQuickOverview] = useState(false);
  const [quickOverviewMode, setQuickOverviewMode] = useState<QuickOverviewMode>(
    savedQuickOverviewMode,
  );
  const [accent, setAccent] = useState(savedAccent);
  const [providerColors, setProviderColors] =
    useState<ProviderColors>(savedProviderColors);
  const [favoriteAccents, setFavoriteAccents] = useState(savedFavoriteAccents);
  const [dataTextScale, setDataTextScale] = useState(savedDataTextScale);
  const [interfaceTextScale, setInterfaceTextScale] = useState(savedInterfaceTextScale);
  const [sceneEffects, setSceneEffects] =
    useState<SceneEffects>(savedSceneEffects);
  const reducedMotion = usePrefersReducedMotion();
  const cancelSidebarHover = useCallback(() => {
    if (sidebarHoverTimeout.current === null) return;
    window.clearTimeout(sidebarHoverTimeout.current);
    sidebarHoverTimeout.current = null;
  }, []);
  const beginSidebarHover = useCallback(() => {
    if (!sidebarCollapsed || sidebarHoverTimeout.current !== null) return;
    sidebarHoverTimeout.current = window.setTimeout(() => {
      sidebarHoverTimeout.current = null;
      setSidebarCollapsed(false);
    }, 560);
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(sidebarCollapsedStorageKey, String(sidebarCollapsed));
    } catch {}
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(quickOverviewModeStorageKey, quickOverviewMode);
    } catch {}
  }, [quickOverviewMode]);
  useEffect(() => {
    if (!sidebarCollapsed) cancelSidebarHover();
  }, [cancelSidebarHover, sidebarCollapsed]);
  useEffect(() => cancelSidebarHover, [cancelSidebarHover]);
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
    const favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (favicon) favicon.href = faviconHref(accent);
    try {
      localStorage.setItem(accentStorageKey, accent);
    } catch {}
  }, [accent]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--anthropic-color",
      providerColors.anthropic,
    );
    document.documentElement.style.setProperty(
      "--openai-color",
      providerColors.openai,
    );
    document.documentElement.style.setProperty(
      "--warp-color",
      providerColors.warp,
    );
    try {
      localStorage.setItem(
        providerColorsStorageKey,
        JSON.stringify(providerColors),
      );
    } catch {}
  }, [providerColors]);
  useEffect(() => {
    try {
      localStorage.setItem(
        favoriteAccentsStorageKey,
        JSON.stringify(favoriteAccents),
      );
    } catch {}
  }, [favoriteAccents]);
  useEffect(() => {
    try {
      localStorage.setItem(
        sceneEffectsStorageKey,
        JSON.stringify(sceneEffects),
      );
    } catch {}
  }, [sceneEffects]);
  // The mobile drawer takes focus when it opens and returns it to the menu button when it
  // closes. Escape dismisses it, as the scrim and the close button do.
  useEffect(() => {
    if (!sidebar) return;
    const opener = menuButton.current;
    sidebarRef.current?.querySelector<HTMLElement>(".sidebar-close")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebar(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (sidebarRef.current?.contains(document.activeElement)) opener?.focus();
    };
  }, [sidebar]);
  useEffect(() => {
    if (!filtersOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The Agent popover and the date popover handle their own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (filtersTray.current?.querySelector("[aria-expanded='true']")) return;
      setFiltersOpen(false);
      filtersButton.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (filtersTray.current?.contains(target) || filtersButton.current?.contains(target)) return;
      setFiltersOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [filtersOpen]);
  useEffect(() => {
    const navigate = () => {
      convertLegacyViewUrl();
      setView(initialView());
      setFocusSessionId(initialSessionId());
      const filters = parseUrlFilters(window.location.search);
      setAgent(filters.agent);
      setDays(filters.range);
      setCustomRange(filters.customRange);
      setPathTag(filters.pathTag);
      setShowCache(filters.showCache);
    };
    convertLegacyViewUrl();
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);
  // A filter change rewrites the current history entry; it is not a navigation, so Back still
  // returns to the previous view.
  useEffect(() => {
    const url = new URL(window.location.href);
    writeUrlFilters(url.searchParams, { range: days, customRange, agent, pathTag, showCache });
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`)
      window.history.replaceState(window.history.state, "", next);
  }, [days, customRange, agent, pathTag, showCache]);
  useEffect(() => {
    const scale = dataTextScale / 100;
    document.documentElement.style.setProperty(
      "--data-text-scale",
      String(scale),
    );
    document.documentElement.style.setProperty(
      "--data-text-primary",
      `${12 * scale}px`,
    );
    document.documentElement.style.setProperty(
      "--data-text-secondary",
      `${10 * scale}px`,
    );
    document.documentElement.style.setProperty(
      "--data-text-compact",
      `${9 * scale}px`,
    );
    document.documentElement.style.setProperty(
      "--data-text-strong",
      `${15 * scale}px`,
    );
    try {
      localStorage.setItem(dataTextScaleStorageKey, String(dataTextScale));
    } catch {}
  }, [dataTextScale]);
  // One scalar; the type tokens in styles/tokens.css multiply their base sizes by it in calc().
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--type-scale-ui",
      String(interfaceTextScale / 100),
    );
    try {
      localStorage.setItem(interfaceTextScaleStorageKey, String(interfaceTextScale));
    } catch {}
  }, [interfaceTextScale]);
  const agents = useMemo(
    () =>
      data
        ? [...new Set(data.sessions.map((session) => session.agent))]
        : [],
    [data],
  );
  // Both grains of the Agent filter come from the same snapshot, so a model can never be offered
  // for a provider that has no activity in the loaded data.
  const agentTree = useMemo(() => {
    const families = data
      ? [
          ...new Set(
            data.sessions.flatMap((session) =>
              session.modelBreakdowns.map((model) => familyOf(model.modelName)),
            ),
          ),
        ].sort((left, right) => left.localeCompare(right))
      : [];
    return buildAgentTree(agents, families);
  }, [agents, data]);
  const agentFilterGroups = useMemo<AgentFilterGroup[]>(() => {
    const groups: AgentFilterGroup[] = agentTree.branches
      // A model family is parented by its name, so an agent with no recognized provider (Copilot
      // running gpt-5.4) never gets one. It still has sessions, and the agent entry is the only
      // way to select them, so its branch stays, without children.
      .filter((branch) => branch.models.length > 0 || providerFromAgent(branch.agent) === null)
      .map((branch) => ({
        label: branch.agent,
        ...(branch.models.length === 0
          ? { note: "Provider not recognized; its models are listed under the provider their names match." }
          : {}),
        summaryColor: providerSeries.find(
          (provider) => provider.key === providerFromAgent(branch.agent),
        )?.color,
        parent: {
          label: branch.agent,
          state: branchState(agent, branch),
          onToggle: () => setAgent(toggleBranch(agent, branch, agentTree)),
        },
        options: branch.models.map((family) => ({
          value: modelEntry(family),
          label: family,
          checked: matchesEntry(agent, branch, family),
          onToggle: () => setAgent(toggleModel(agent, family, agentTree)),
        })),
      }));
    if (agentTree.unparented.length > 0) {
      groups.push({
        label: `Other models (${agentTree.unparented.length})`,
        note: "Provider not recognized; model remains filterable.",
        options: agentTree.unparented.map((family) => ({
          value: modelEntry(family),
          label: family,
          checked: agent.includes(modelEntry(family)),
          onToggle: () => setAgent(toggleModel(agent, family, agentTree)),
        })),
      });
    }
    return groups;
  }, [agent, agentTree]);
  const pathTags = useMemo(
    () => (data ? [...new Set(data.sessions.flatMap((s) => s.pathTags))] : []),
    [data],
  );
  // A bookmarked Path tag can outlive its rule. Fall back to every path instead of an empty view.
  useEffect(() => {
    if (data && pathTag !== "all" && !pathTags.includes(pathTag)) setPathTag("all");
  }, [data, pathTag, pathTags]);
  const sessions = useMemo(
    () =>
      data?.sessions.filter(
        (s) =>
          matchesAgentSelection(s, agent) &&
          (pathTag === "all" || s.pathTags.includes(pathTag)),
      ) ?? [],
    [data, agent, pathTag],
  );
  const availableRange = useMemo(
    () => (data ? availableDateRange(data.daily) : null),
    [data],
  );
  const resolvedRange = useMemo(
    () => (data ? resolvedDateRange(data.daily, days, customRange) : null),
    [data, days, customRange],
  );
  const activeDateRange = days === "all" ? null : resolvedRange;
  const rangeRows = useMemo(
    () => (data ? metricRangeRows(data.daily, days, customRange) : []),
    [data, days, customRange],
  );
  const daily = useMemo(() => {
    if (!data) return [];
    if (pathTag === "all")
      return rangeRows
        .map((row) => selectAgentRow(row, agent))
        .filter(Boolean) as MetricRow[];
    return pathFilteredRows(sessions, new Set(rangeRows.map((row) => row.period)), data.timeZone);
  }, [data, agent, pathTag, rangeRows, sessions]);
  const rangeSessions = useMemo(() => {
    if (!data) return [];
    const periods = new Set(rangeRows.map((row) => row.period));
    return data.sessions.filter((session) => {
      const date = sessionDate(session, data.timeZone);
      return date !== null && periods.has(date);
    });
  }, [data, rangeRows]);
  const datedSessions = useMemo(() => {
    const periods = new Set(rangeRows.map((row) => row.period));
    return sessions.filter((session) => {
      const date = sessionDate(session, data?.timeZone ?? systemTimeZone());
      return date !== null && periods.has(date);
    });
  }, [rangeRows, sessions]);
  const changeTimeRange = (range: MetricRange, nextCustomRange?: DateRange) => {
    if (range === "custom" && nextCustomRange) setCustomRange(nextCustomRange);
    setDays(range);
  };
  const visibleSessions = useMemo(() => {
    if (!data) return datedSessions;
    const focused = focusSessionId
      ? data.sessions.find((session) => session.sessionId === focusSessionId)
      : undefined;
    return focused &&
      !datedSessions.some((session) => session.sessionId === focused.sessionId)
      ? [focused, ...datedSessions]
      : datedSessions;
  }, [data, datedSessions, focusSessionId]);
  const navigateToView = (nextView: View) => {
    setSidebar(false);
    if (nextView === view && !focusSessionId) return;
    window.history.pushState({ view: nextView }, "", viewHref(nextView));
    setFocusSessionId(null);
    setView(nextView);
  };
  const openSession = (sessionId: string) => {
    window.history.pushState(
      { view: "sessions", sessionId },
      "",
      sessionHref(sessionId),
    );
    setFocusSessionId(sessionId);
    setView("sessions");
  };
  const openBenchmark = (siteId: BenchmarkSiteId) => {
    setBenchmarkSite(siteId);
    setBenchmarkOpen(true);
  };
  const resetAppearance = () => {
    setAccent(defaultAccent);
    setProviderColors(defaultProviderColors);
    setFavoriteAccents(defaultFavoriteAccents);
    setDataTextScale(defaultDataTextScale);
    setInterfaceTextScale(defaultInterfaceTextScale);
    setSceneEffects(defaultSceneEffects);
  };
  if (loading && !data)
    return (
      <div className="boot">
        {sceneEffects.tesseract ? (
          <TesseractCore accent={accent} className="boot-tesseract" />
        ) : (
          <div className="boot-orbit">
            <Orbit />
          </div>
        )}
        <span>Calibrating local instruments…</span>
      </div>
    );
  if (error && !data)
    return (
      <div className="boot error-state">
        <Database />
        <h1>Observatory is offline</h1>
        <p>{error}</p>
        <button className="primary-button" onClick={() => load()}>
          Try again
        </button>
      </div>
    );
  if (!data) return null;
  const current = nav.find((item) => item.id === view)!;
  const showScopeFilters = view !== "models" && view !== "projects";
  const activeFilterCount =
    (showScopeFilters && agent.length > 0 ? 1 : 0) +
    (showScopeFilters && pathTag !== "all" ? 1 : 0) +
    (showCache ? 0 : 1);
  const cacheControl = (
    <label
      className="cache-control"
      data-tooltip="Includes cache read and creation tokens in usage graphs and session, project, and model totals. Cost estimates, cache metrics, and the recent five-hour block are unchanged."
    >
      <input
        type="checkbox"
        checked={showCache}
        onChange={(event) => setShowCache(event.target.checked)}
      />
      <span>Show cache</span>
    </label>
  );
  const pricingIncomplete = Boolean(data.unpricedModels?.length);
  // `error` beside loaded data means a later request failed; the figures on screen are retained.
  const disconnected = Boolean(error);
  const sideStatusLabel = disconnected
    ? "Local server unreachable"
    : pricingIncomplete
      ? "Cost data incomplete"
      : "Local systems nominal";
  // In development Vite serves the UI and proxies the API; a built app serves both from one port.
  const uiPort = window.location.port;
  const portsLabel = Number(uiPort) === data.apiPort
    ? `port ${data.apiPort}`
    : uiPort
      ? `UI :${uiPort} · API :${data.apiPort}`
      : `API :${data.apiPort}`;
  return (
    <SceneEffectsContext.Provider value={sceneEffects}>
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className={sidebar ? "open" : ""} ref={sidebarRef} id="app-sidebar">
        <div className="brand">
          <a
            className={`brand-home${view === "overview" ? " active" : ""}`}
            href={viewHref("overview")}
            onMouseEnter={beginSidebarHover}
            onMouseLeave={cancelSidebarHover}
            onClick={(event) => {
              cancelSidebarHover();
              event.preventDefault();
              navigateToView("overview");
            }}
            aria-current={view === "overview" ? "page" : undefined}
          >
            <span className="brand-orbit">
              <Orbit />
            </span>
            <span className="brand-label">
              <b>AI Usage</b>
              <small>OBSERVATORY</small>
              <em className="brand-version">v{appVersion}</em>
            </span>
          </a>
          <button
            className="sidebar-close"
            onClick={() => setSidebar(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
        </div>
        <button
          className="sidebar-toggle"
          onMouseEnter={beginSidebarHover}
          onMouseLeave={cancelSidebarHover}
          onClick={() => {
            cancelSidebarHover();
            setSidebarCollapsed((collapsed) => !collapsed);
          }}
          aria-label={
            sidebarCollapsed ? "Expand navigation" : "Collapse navigation"
          }
          aria-expanded={!sidebarCollapsed}
        >
          <ChevronLeft className={sidebarCollapsed ? "is-collapsed" : undefined} />
        </button>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => navigateToView(item.id)}
              aria-label={item.label}
              data-tooltip={item.label}
            >
              <item.icon />
              <span>{item.label}</span>
              {view === item.id && <i />}
            </button>
          ))}
        </nav>
        <div
          className="side-status"
          data-tooltip={`${sideStatusLabel} — ccusage v${data.ccusageVersion} — ${portsLabel}`}
          aria-label={`${sideStatusLabel}, ccusage version ${data.ccusageVersion}, ${portsLabel}`}
          tabIndex={sidebarCollapsed ? 0 : undefined}
        >
          <span
            className={`status-dot ${disconnected || pricingIncomplete ? "degraded" : "healthy"}`}
          />
          <div>
            <b>{sideStatusLabel}</b>
            <small>ccusage v{data.ccusageVersion}</small>
            <small>{portsLabel}</small>
          </div>
        </div>
        <button
          className="settings-link"
          onClick={() => setRules(true)}
          data-tooltip="Path rules"
        >
          <Settings2 /> <b>Path rules</b> <span>{data.rules.length}</span>
        </button>
        <p className="privacy-note">No raw usage records leave this machine.</p>
      </aside>
      <main>
        {sceneEffects.starfield && !reducedMotion && (
          <Starfield accent={accent} effects={sceneEffects} />
        )}
        <header className="topbar">
          <button
            ref={menuButton}
            className="menu-button"
            onClick={() => setSidebar(true)}
            aria-label="Open navigation"
            aria-expanded={sidebar}
            aria-controls="app-sidebar"
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="breadcrumbs">
            <button type="button" onClick={() => navigateToView("overview")}>
              AI Usage Observatory
            </button>
            <ChevronRight />
            <b>{current.label}</b>
          </div>
          <div className="global-controls">
            <button
              type="button"
              className="quick-overview-button"
              onClick={() => setQuickOverview(true)}
              title="Quick quota overview"
              aria-label="Open quick quota overview"
            >
              <Gauge />
            </button>
            <BenchmarkSplitLauncher onOpen={openBenchmark} />
            {/* Below 900px the topbar cannot fit the filters, so this button opens them as a
                tray under the topbar. Above it the tray is `display: contents`. */}
            <button
              ref={filtersButton}
              type="button"
              className={`filters-button${activeFilterCount ? " has-active" : ""}`}
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              aria-controls="global-filters"
              aria-label={
                activeFilterCount
                  ? `Filters, ${activeFilterCount} active`
                  : "Filters"
              }
            >
              <SlidersHorizontal aria-hidden="true" />
              {activeFilterCount > 0 && <b aria-hidden="true">{activeFilterCount}</b>}
            </button>
            <div
              ref={filtersTray}
              id="global-filters"
              className={`filter-tray${filtersOpen ? " open" : ""}`}
              role="group"
              aria-label="Filters"
            >
              {/* A div, not a label: the popover contains its own checkboxes, and a wrapping
                  label would forward stray clicks into the first of them. */}
              {showScopeFilters && (
                <div className="global-filter global-filter--agent">
                  <span>Agent</span>
                  <AgentFilter
                    selection={agent}
                    onChange={setAgent}
                    groups={agentFilterGroups}
                  />
                </div>
              )}
              {showScopeFilters && (
                <label className="global-filter global-filter--path">
                  <span>Path</span>
                  <select
                    value={pathTag}
                    onChange={(e) => setPathTag(e.target.value)}
                  >
                    <option value="all">All paths</option>
                    {pathTags.map((tag) => (
                      <option value={tag} key={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* The tray's copy of Show cache; CSS shows exactly one of the two. */}
              <span className="cache-control-slot cache-control-slot--tray">{cacheControl}</span>
            </div>
            {view !== "overview" && (
              <TimeRangeControl
                value={days}
                customRange={customRange}
                availableRange={availableRange}
                resolvedRange={resolvedRange}
                onChange={changeTimeRange}
              />
            )}
            <span className="cache-control-slot cache-control-slot--bar">{cacheControl}</span>
            <button
              className="appearance-button"
              onClick={() => setAppearance(true)}
              title="Appearance settings"
            >
              <Palette />
              <span>Appearance</span>
            </button>
            <button
              className="refresh-button"
              onClick={() => load(true)}
              title="Refresh local sources"
            >
              <RefreshCw className={loading ? "spin" : ""} />
              <span>{loading ? "Collecting" : "Refresh"}</span>
            </button>
          </div>
        </header>
        {disconnected && (
          <div className="stale-banner connection-banner" role="status">
            <span>
              A request to the local server failed ({error}). These figures are from the last
              successful refresh
              {lastSuccessAt
                ? ` at ${new Date(lastSuccessAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : ""}
              .
            </span>
            <button type="button" onClick={() => load()} disabled={loading}>
              {loading ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {data.refresh.stale && (
          <div className="stale-banner">
            Showing the last successful collection. {data.refresh.lastError}
          </div>
        )}
        {Boolean(data.unpricedModels?.length) && (
          <div className="stale-banner">
            ccusage has no pricing for {data.unpricedModels.join(", ")}. Token
            counts are complete, but every cost figure below excludes{" "}
            {data.unpricedModels.length > 1 ? "these models" : "this model"}.
          </div>
        )}
        <ChartPinProvider key={view}>
          <div className="content">
          <Suspense fallback={<div className="empty" role="status">Loading view…</div>}>
          {view === "overview" && (
            <Overview
              data={data}
              daily={daily}
              sessions={datedSessions}
              windowSessions={sessions}
              agent={agent}
              pathTag={pathTag}
              metricRange={days}
              customRange={customRange}
              dateRange={activeDateRange}
              availableRange={availableRange}
              onMetricRangeChange={changeTimeRange}
              onOpenSession={openSession}
              onOpenSessions={() => navigateToView("sessions")}
              onOpenData={() => navigateToView("sources")}
              onTagSession={setSession}
              onUpdateWebCredits={() => setWebImport(true)}
              onOpenBenchmark={openBenchmark}
              accent={accent}
              providerColors={providerColors}
              sceneEffects={sceneEffects}
            />
          )}
          {view === "explorer" && (
            <Explorer
              data={data}
              rows={daily}
              sessions={sessions}
              agent={agent}
              pathTag={pathTag}
              metricRange={days}
              customRange={customRange}
              dateRange={activeDateRange}
              metric={metric}
              setMetric={setMetric}
            />
          )}
          {view === "sessions" && (
            <Sessions
              sessions={visibleSessions}
              rateCard={data.rateCard}
              unpricedModels={data.unpricedModels}
              showCache={showCache}
              onEdit={setSession}
              focusSessionId={focusSessionId}
              focusOutsideRange={Boolean(
                focusSessionId && !datedSessions.some((session) => session.sessionId === focusSessionId),
              )}
              quotaHistory={data.quotas.history}
            />
          )}
          {view === "projects" && (
            <Projects
              data={data}
              daily={rangeRows}
              sessions={rangeSessions}
              metricRange={days}
              customRange={customRange}
              dateRange={activeDateRange}
              showCache={showCache}
              onOpenSession={openSession}
            />
          )}
          {view === "models" && (
            <Models
              data={data}
              daily={rangeRows}
              sessions={rangeSessions}
              dateRange={activeDateRange}
              showCache={showCache}
              onOpenSession={openSession}
            />
          )}
          {view === "sources" && (
            <Sources
              data={data}
              onRules={() => setRules(true)}
              onUpdateWebCredits={() => setWebImport(true)}
              days={days}
              dateRange={activeDateRange}
              agent={agent}
              pathTag={pathTag}
              showCache={showCache}
              facets={dataFacets}
              onFacets={(next) =>
                setDataFacets((current) => {
                  if (next.policy) localStorage.setItem("allowance-policy", next.policy);
                  return { ...current, ...next };
                })
              }
              onOpenSession={openSession}
            />
          )}
          </Suspense>
          </div>
        </ChartPinProvider>
        <InformationSources data={data} />
      </main>
      <Suspense fallback={<div className="modal-backdrop" role="status">Loading dialog…</div>}>
      {session && (
        <AnnotationModal
          session={session}
          onClose={() => setSession(null)}
          onSaved={() => load()}
        />
      )}
      {rules && (
        <RulesModal
          data={data}
          onClose={() => setRules(false)}
          onSaved={() => load(true)}
        />
      )}
      {webImport && (
        <AnthropicWebImportModal
          credits={
            data.quotas.usage?.providers.find(
              (provider) => provider.provider === "anthropic",
            )?.anthropicWebCredits ?? null
          }
          onClose={() => setWebImport(false)}
          onSaved={() => load(true)}
        />
      )}
      {appearance && (
        <AppearanceModal
          accent={accent}
          onChange={setAccent}
          providerColors={providerColors}
          onProviderColorsChange={setProviderColors}
          favoriteAccents={favoriteAccents}
          onFavoriteAccentsChange={setFavoriteAccents}
          dataTextScale={dataTextScale}
          onDataTextScaleChange={setDataTextScale}
          interfaceTextScale={interfaceTextScale}
          onInterfaceTextScaleChange={setInterfaceTextScale}
          sceneEffects={sceneEffects}
          onSceneEffectsChange={setSceneEffects}
          reducedMotion={reducedMotion}
          onReset={resetAppearance}
          onClose={() => setAppearance(false)}
        />
      )}
      {benchmarkSite && (
        <BenchmarkModal
          initialSiteId={benchmarkSite}
          open={benchmarkOpen}
          onClose={() => setBenchmarkOpen(false)}
        />
      )}
      {quickOverview && (
        <QuickOverviewModal
          quotas={data.quotas}
          mode={quickOverviewMode}
          onModeChange={setQuickOverviewMode}
          accent={accent}
          providerColors={providerColors}
          sceneEffects={sceneEffects}
          onClose={() => setQuickOverview(false)}
        />
      )}
      </Suspense>
      {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
    </div>
    </SceneEffectsContext.Provider>
  );
}
