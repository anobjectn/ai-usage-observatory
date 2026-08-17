import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { version as appVersion } from "../package.json";
import {
  buildEffortDaySeries,
  compareEffort,
  effortRank,
  type EffortDayPoint,
} from "./effort-model";
import { dateKeyInTimeZone, hourInTimeZone, systemTimeZone } from "./reporting-time";
import {
  ComboFacetSelect,
  ComboPill,
  EffortBadge,
  EffortCoverage,
  EffortStack,
  EffortState,
  EFFORT_HELP,
  effortColor,
  effortLabel,
  familyLabel,
  sharePercent,
} from "./components/effort";
import {
  buildComboDaySeries,
  comboKey,
  comboLabel,
  compareComboKeys,
  comboOf,
  comboSeriesColor,
  comboSeriesLabel,
  parseComboFacet,
  parseComboKey,
} from "./combo";
import { providerFromAgent } from "./provider";
import { PageJump } from "./components/page-jump";
import {
  decodeEffortDigest,
  effortSearchText,
  effortSummaryLabel,
  matchesSessionEffortFilter,
  sessionEffortSortValue,
  useEffortAggregate,
  useEffortComboDays,
  setSessionVerdict,
  useEffortRefreshOnIndexChange,
  useEffortSessions,
  useEffortStatus,
  type DecodedSessionEffort,
  type EffortScopeInput,
} from "./hooks/use-effort";
import {
  Activity,
  AlarmClock,
  ArrowDownRight,
  ArrowUpRight,
  Atom,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  Database,
  EllipsisVertical,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderOpen,
  Copy,
  Gauge,
  Layers3,
  Menu,
  Orbit,
  Palette,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  HeadroomOrrery,
  SceneEffectsContext,
  Starfield,
  TesseractCore,
  type ProviderColors,
  type SceneEffects,
} from "./scene";
import { providerHeadroom } from "./quota-headroom";
import {
  buildAnthropicCreditView,
  buildCodexCreditView,
  formatCredit,
  type AnthropicCreditView,
  type CodexCreditView,
  type CreditFreshness,
} from "./quota-credits";
import { warpQuotaSummary } from "./warp-quota";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DashboardData,
  EffortComboBucket,
  SessionAnnotation,
  SessionVerdict,
  EffortIndexStatus,
  EffortSummary,
  MetricRow,
  ModelBreakdown,
  ProjectActivity,
  ProjectTrendRow,
  Session,
  SessionDetail,
  AnthropicWebCredits,
  QuotaProvider,
  WarpSessionStats,
} from "./types";
import {
  dailyQuotaMarkers,
  hourlyQuotaMarkers,
  quotaMarkersAt,
  type QuotaMarker,
} from "./quota-markers";
import {
  AgentFilter,
  Empty,
  InformationSources,
  PageTitle,
  Segmented,
  TimeRangeControl,
  type AgentFilterGroup,
} from "./views/chrome";
import {
  agentEntry,
  agentSelectionParams,
  branchState,
  buildAgentTree,
  matchesEntry,
  matchesAgentSelection,
  modelEntry,
  selectAgentRow,
  selectionProvider,
  toggleBranch,
  toggleModel,
  type AgentSelection,
} from "./agent-filter";
import { familyOf } from "./model-family";
import { filterEmptyMessage } from "./filter-summary";
import {
  availableDateRange,
  dateRangeLabel,
  metricRangeLabel,
  metricRangeRows,
  resolvedDateRange,
  type DateRange,
  type MetricRange,
} from "./time-range";
import { aggregateModels } from "./model-aggregation";
import { UsageIntelligence } from "./views/data/intelligence";
import type { DataFacets } from "./views/data/insights";
import {
  ChartPinProvider,
  ChartTooltipContext,
  PinnableChartTooltip,
  useChartTooltipHold,
} from "./components/chart-pins";
import { chartTooltipDateLabel } from "./chart-pins";

type View =
  "overview" | "explorer" | "sessions" | "projects" | "models" | "sources";
type Metric = "totalTokens" | "totalCost" | "outputTokens";
type ProjectSummary = DashboardData["projects"][number];
type ProjectSessionDetail = { session: Session; detail: SessionDetail };
const nav: Array<{ id: View; label: string; icon: typeof Orbit }> = [
  { id: "overview", label: "Overview", icon: Orbit },
  { id: "explorer", label: "Explorer", icon: Activity },
  { id: "sessions", label: "Sessions", icon: Layers3 },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "models", label: "Models", icon: Atom },
  { id: "sources", label: "Data", icon: Gauge },
];
const palette = [
  "#b7f25c",
  "#58d9cf",
  "#ff9e64",
  "#d7b3ff",
  "#78a8ff",
  "#f2d15c",
];
const defaultAccent = "#78a8ff";
const defaultProviderColors: ProviderColors = {
  anthropic: "#d97757",
  openai: "#eaeaea",
  warp: "#d7b3ff",
};
const defaultFavoriteAccents = [
  "#78a8ff",
  "#b7f25c",
  "#58d9cf",
  "#f08bb4",
  "#f2d15c",
  "#ff786f",
];
const accentStorageKey = "usage-observatory:accent";
const providerColorsStorageKey = "usage-observatory:provider-colors";
const favoriteAccentsStorageKey = "usage-observatory:favorite-accents";
const dataTextScaleStorageKey = "usage-observatory:data-text-scale";
const sidebarCollapsedStorageKey = "usage-observatory:sidebar-collapsed";
const defaultDataTextScale = 125;

function faviconHref(accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 1.5 21 21" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2" fill="${accent}"/><circle cx="5" cy="19" r="2" fill="${accent}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function savedAccent() {
  try {
    const value = localStorage.getItem(accentStorageKey);
    return value && /^#[0-9a-f]{6}$/i.test(value) ? value : defaultAccent;
  } catch {
    return defaultAccent;
  }
}

function savedFavoriteAccents() {
  try {
    const value = JSON.parse(
      localStorage.getItem(favoriteAccentsStorageKey) ?? "[]",
    );
    return Array.isArray(value) &&
      value.length === defaultFavoriteAccents.length &&
      value.every(
        (color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
      )
      ? value
      : defaultFavoriteAccents;
  } catch {
    return defaultFavoriteAccents;
  }
}

function savedProviderColors(): ProviderColors {
  try {
    const value = JSON.parse(
      localStorage.getItem(providerColorsStorageKey) ?? "{}",
    );
    return {
      anthropic:
        typeof value.anthropic === "string" &&
        /^#[0-9a-f]{6}$/i.test(value.anthropic)
          ? value.anthropic
          : defaultProviderColors.anthropic,
      openai:
        typeof value.openai === "string" && /^#[0-9a-f]{6}$/i.test(value.openai)
          ? value.openai
          : defaultProviderColors.openai,
      warp:
        typeof value.warp === "string" && /^#[0-9a-f]{6}$/i.test(value.warp)
          ? value.warp
          : defaultProviderColors.warp,
    };
  } catch {
    return defaultProviderColors;
  }
}

function savedDataTextScale() {
  try {
    const value = Number(localStorage.getItem(dataTextScaleStorageKey));
    return Number.isFinite(value) && value >= 90 && value <= 150
      ? value
      : defaultDataTextScale;
  } catch {
    return defaultDataTextScale;
  }
}

function savedSidebarCollapsed() {
  try {
    return localStorage.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

function initialView(): View {
  const value = new URLSearchParams(window.location.search).get("view");
  if (value === "limits") return "sources";
  return nav.some((item) => item.id === value) ? (value as View) : "overview";
}

function convertLegacyViewUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("view") !== "limits") return;
  url.searchParams.set("view", "sources");
  window.history.replaceState(
    { ...window.history.state, view: "sources" },
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
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

function viewHref(view: View) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", view);
  return `${url.pathname}${url.search}`;
}

function modelIdsFromUrl() {
  return [
    ...new Set(
      new URLSearchParams(window.location.search)
        .getAll("model")
        .filter(Boolean),
    ),
  ];
}

function modelsHref(models: Iterable<string>) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", "models");
  for (const model of models) url.searchParams.append("model", model);
  return `${url.pathname}${url.search}`;
}

function transitionModelGrid(update: () => void) {
  const transitionDocument = document as Document & {
    startViewTransition?: (callback: () => void) => unknown;
  };
  if (typeof transitionDocument.startViewTransition === "function") {
    transitionDocument.startViewTransition(() => flushSync(update));
  } else {
    update();
  }
}

const autoScrollDelayMs = 200;
const userScrollCancelWindowMs = 260;

function useUserScrollIntent() {
  const lastUserScrollAt = useRef(0);

  useEffect(() => {
    const markUserScrollIntent = () => {
      lastUserScrollAt.current = performance.now();
    };

    const markKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "PageDown",
          "PageUp",
          "Home",
          "End",
        ].includes(event.key)
      ) {
        markUserScrollIntent();
      }
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener("wheel", markUserScrollIntent, options);
    window.addEventListener("touchmove", markUserScrollIntent, options);
    window.addEventListener("keydown", markKeyboardScrollIntent);
    return () => {
      window.removeEventListener("wheel", markUserScrollIntent, options);
      window.removeEventListener("touchmove", markUserScrollIntent, options);
      window.removeEventListener("keydown", markKeyboardScrollIntent);
    };
  }, []);

  return lastUserScrollAt;
}

function useModalFocusTrap(onEscape: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusInitial = window.requestAnimationFrame(() => {
      const initial =
        dialog.querySelector<HTMLElement>("[data-autofocus], [autofocus]") ??
        dialog.querySelector<HTMLElement>(focusableSelector);
      (initial ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return dialogRef;
}

const sceneEffectsStorageKey = "usage-observatory:scene-effects";
const defaultSceneEffects: SceneEffects = {
  starfield: true,
  parallax: true,
  twinkle: false,
  tesseract: true,
  speed: 0.3,
  starDensity: 3,
};

function savedSceneEffects(): SceneEffects {
  try {
    const value = JSON.parse(
      localStorage.getItem(sceneEffectsStorageKey) ?? "",
    );
    const speed = Number(value.speed);
    const starDensity = Number(value.starDensity);
    return {
      starfield: value.starfield !== false,
      parallax: value.parallax !== false,
      twinkle: value.twinkle === true,
      tesseract: value.tesseract === true,
      speed:
        Number.isFinite(speed) && speed >= 0.1 && speed <= 3
          ? speed
          : defaultSceneEffects.speed,
      starDensity:
        Number.isInteger(starDensity) && starDensity >= 1 && starDensity <= 6
          ? starDensity
          : defaultSceneEffects.starDensity,
    };
  } catch {
    return defaultSceneEffects;
  }
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

const formatCompact = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const formatMoney = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatWarpCredits = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const formatDate = (value: string, timeZone?: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" as const } : {}),
  });
const formatPromptTimestamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Time unavailable";
const friendlyProject = (value: string) =>
  value.startsWith("/")
    ? (value.split("/").filter(Boolean).at(-1) ?? value)
    : value.replace(/^-Users-[^-]+-/, "").replaceAll("-", " / ");
const providerSeries = [
  { key: "anthropic", label: "Claude", color: "var(--anthropic-color)" },
  { key: "codex", label: "Codex", color: "var(--openai-color)" },
  { key: "warp", label: "Warp", color: "var(--warp-color)" },
] as const;
const stackedProviderSeries = [...providerSeries].reverse();

type ActivityAxisTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string };
  tokens: Array<{ color: string; value: number }>;
};

function ActivityAxisTick({ x = 0, y = 0, payload, tokens }: ActivityAxisTickProps) {
  const visibleTokens = tokens.filter((item) => item.value > 0);
  const labels = visibleTokens.length
    ? visibleTokens
    : [{ color: "var(--dim)", value: 0 }];
  return (
    <g transform={`translate(${Number(x)} ${Number(y)})`}>
      <text
        x={0}
        y={4}
        fill="#71807b"
        fontSize={11}
        fontFamily="var(--font-label)"
        textAnchor="middle"
        dominantBaseline="hanging"
      >
        {periodTickLabel(String(payload?.value ?? ""))}
      </text>
      {labels.map((item, index) => (
        <text
          key={`${item.color}-${index}`}
          x={0}
          y={19 + index * 12}
          fill={item.color}
          fontSize={9}
          fontFamily="var(--font-label)"
          fontWeight={600}
          textAnchor="middle"
          dominantBaseline="hanging"
        >
          {formatCompact(item.value)}
        </text>
      ))}
    </g>
  );
}

function providerKey(agent: string) {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic"))
    return "anthropic";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("warp")) return "warp";
  return null;
}

function resetCopy(timestamp: number | null, verb = "resets") {
  if (!timestamp || !Number.isFinite(timestamp))
    return verb === "renews"
      ? "no renewal time reported"
      : "no reset time reported";
  const delta = timestamp - Date.now();
  const absolute = new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (delta <= 0) return `expired · was due ${absolute}`;
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const countdown =
    days > 0
      ? `${days}d ${hours}h`
      : hours > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${remainingMinutes}m`;
  return `${verb} in ${countdown} · ${absolute}`;
}

function expiryCopy(timestamp: string | null) {
  if (!timestamp) return { text: "no expiry reported", urgent: false };
  const expiresAt = Date.parse(timestamp);
  if (!Number.isFinite(expiresAt))
    return { text: "expiry time unavailable", urgent: false };
  const delta = expiresAt - Date.now();
  const absolute = new Date(expiresAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (delta <= 0)
    return { text: `expired · was due ${absolute}`, urgent: false };
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const countdown =
    days > 0
      ? `${days}d ${hours}h`
      : hours > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${remainingMinutes}m`;
  return {
    text: `expires in ${countdown} · ${absolute}`,
    urgent: delta <= 24 * 60 * 60 * 1_000,
  };
}

function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dashboardEtag = useRef<string | null>(null);
  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      if (refresh) await fetch("/api/refresh", { method: "POST" });
      const response = await fetch("/api/dashboard", {
        headers: dashboardEtag.current ? { "If-None-Match": dashboardEtag.current } : undefined,
      });
      if (response.status === 304) return;
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      dashboardEtag.current = response.headers.get("ETag");
      setData(await response.json());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, []);
  return { data, error, loading, load };
}

/** Maps the global Agent / range / path-tag controls onto an effort scope. Dashboard and
 * Explorer read calendar activity, so both use the timeline basis. */
function globalEffortScope(
  agent: AgentSelection,
  dateRange: DateRange | null,
  pathTag: string,
) {
  const { providers, modelFamilies } = agentSelectionParams(agent);
  return {
    basis: "timeline" as const,
    fromDate: dateRange?.from,
    toDate: dateRange?.to,
    providers,
    modelFamilies,
    pathTag,
  };
}

function timeEffortScope(
  dateRange: DateRange | null,
  basis: "timeline" | "sessions" = "timeline",
) {
  return {
    basis,
    fromDate: dateRange?.from,
    toDate: dateRange?.to,
    pathTag: "all",
  } satisfies EffortScopeInput;
}

type MetricCardAverage = {
  label: string;
  value: string;
  trend?: number;
};

function MetricTrend({
  value,
  unit = "%",
  context = "previous equal span",
}: {
  value: number;
  unit?: "%" | "pp";
  context?: string;
}) {
  const direction = value >= 0 ? "up" : "down";
  return (
    <span
      className={direction === "up" ? "trend-up" : "trend-down"}
      aria-label={`${direction === "up" ? "Up" : "Down"} ${Math.abs(value)}${unit}, ${context}`}
    >
      {direction === "up" ? <ArrowUpRight /> : <ArrowDownRight />}
      {Math.abs(value)}
      {unit}
    </span>
  );
}

function MetricCard({
  eyebrow,
  value,
  detail,
  trend,
  trendUnit = "%",
  averages,
  icon: Icon,
}: {
  eyebrow: string;
  value: string;
  detail: string;
  trend?: number;
  trendUnit?: "%" | "pp";
  averages?: MetricCardAverage[];
  icon: typeof Orbit;
}) {
  return (
    <article className="metric-card">
      <div className="metric-card__top">
        <span>{eyebrow}</span>
        <Icon size={16} />
      </div>
      <strong aria-live="polite">{value}</strong>
      <div className="metric-detail">
        <span>{detail}</span>
        {trend !== undefined && <MetricTrend value={trend} unit={trendUnit} />}
      </div>
      {averages && (
        <div className="metric-card__averages" aria-label={`${eyebrow} averages`}>
          <div className="metric-card__averages-heading">
            <span>AVERAGES</span>
            <small>active days · vs prior span</small>
          </div>
          <div className="metric-card__average-grid">
            {averages.map((average) => (
              <div className="metric-card__average" key={average.label}>
                <span>{average.label}</span>
                <strong>{average.value}</strong>
                {average.trend === undefined ? (
                  <span
                    className="metric-card__average-trend metric-card__average-trend--empty"
                    aria-label="No previous matching slice"
                  >
                    —
                  </span>
                ) : (
                  <MetricTrend
                    value={average.trend}
                    unit={trendUnit}
                    context="previous matching slice"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

type ChartTooltipPayload = {
  color?: string;
  dataKey?: string;
  name?: string;
  payload?: unknown;
  value?: number;
};

type ChartTooltipProps = {
  active?: boolean;
  coordinate?: { x?: number };
  label?: string | number;
  payload?: ChartTooltipPayload[];
};

const chartTooltipWrapperStyle = {
  transition: "none",
} as const;

function ChartTooltip({
  active,
  payload,
  label,
  metric,
}: ChartTooltipProps & { metric: Metric }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>{label}</span>
      {payload.map((item) => (
        <div key={item.dataKey ?? item.name}>
          <i style={{ background: item.color }} />
          {item.name}:{" "}
          <b>
            {metric === "totalCost"
              ? formatMoney(item.value ?? 0)
              : formatCompact(item.value ?? 0)}
          </b>
        </div>
      ))}
    </div>
  );
}

type ModelSignalRow = ReturnType<typeof modelDistribution>[number] & {
  effort: EffortSummary | null;
};

function ModelSignalTooltip({
  active,
  payload,
  coordinate,
  metric,
}: {
  active?: boolean;
  payload?: Array<{ payload: ModelSignalRow; color?: string; value?: number }>;
  coordinate?: { x?: number };
  metric: Metric;
}) {
  const pinSource = useId();
  const liveRow = payload?.[0]?.payload;
  const claimKey =
    active && liveRow
      ? `${liveRow.provider ?? "unknown"}:${liveRow.rawName}:${metric}`
      : null;
  const hold = useChartTooltipHold(
    active && liveRow ? { row: liveRow, coordinate, metric } : null,
    claimKey,
  );
  const tooltipRef = useClampedTooltip(
    Boolean(hold.snapshot),
    hold.snapshot?.coordinate,
  );
  if (!hold.snapshot) return null;
  const { row, metric: snapshotMetric } = hold.snapshot;
  const summary = row.effort;
  return (
    <PinnableChartTooltip
      id={`${pinSource}:${row.provider ?? "unknown"}:${row.rawName}:${snapshotMetric}`}
      ariaLabel={`${row.rawName} model details`}
      contextLabel="Model usage"
      contextDescription="Model tokens or estimated API cost, with recorded reasoning effort when available."
      className="model-signal-tooltip"
      forwardedRef={tooltipRef}
      interactionRef={hold.cardRef}
      retained={hold.retained}
      cardInteractionProps={hold.cardInteractionProps}
      pinInteractionProps={hold.pinInteractionProps}
    >
      <span>{row.rawName}</span>
      <div>
        <i style={{ background: row.color }} aria-hidden="true" />
        Usage:{" "}
        <b>
          {snapshotMetric === "totalCost"
            ? formatMoney(row.value)
            : formatCompact(row.value)}
        </b>
      </div>
      {summary?.dominant && (
        <div className="model-signal-tooltip__effort">
          {/* The model is known here, so the dominant value is shown as the combo it actually
           * is. An effort label on its own would invite comparison across families. */}
          <ComboPill combo={{ family: familyOf(row.rawName), effort: summary.dominant }} />
          <small>
            {summary.tokenCoverage === null
              ? "Token coverage unavailable"
              : `${Math.round(summary.tokenCoverage * 100)}% token coverage`}
          </small>
          {summary.levels
            .filter((level) => level.tokens > 0)
            .map((level) => (
              <span key={level.effort}>
                {effortLabel(level.effort)}{" "}
                {sharePercent(level.tokens, summary.attributedTokens)}
              </span>
            ))}
        </div>
      )}
    </PinnableChartTooltip>
  );
}

function useClampedTooltip(active: boolean, coordinate?: { x?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tooltip = ref.current;
    const chart = tooltip?.closest(".recharts-wrapper");
    const wrapper = tooltip?.parentElement;
    if (
      !active ||
      !tooltip ||
      !(chart instanceof HTMLElement) ||
      !wrapper ||
      typeof coordinate?.x !== "number"
    )
      return;

    const chartBounds = chart.getBoundingClientRect();
    const edgePadding = 8;
    tooltip.style.setProperty(
      "--tooltip-width",
      `${Math.max(0, Math.min(410, chartBounds.width - edgePadding * 2))}px`,
    );
    const wrapperBounds = wrapper.getBoundingClientRect();
    const centeredOffset =
      chartBounds.left +
      coordinate.x -
      wrapperBounds.left -
      tooltip.offsetWidth / 2;
    tooltip.style.setProperty("--tooltip-x", `${centeredOffset}px`);

    const tooltipBounds = tooltip.getBoundingClientRect();
    const leftBoundary = Math.max(chartBounds.left, 0) + edgePadding;
    const rightBoundary =
      Math.min(chartBounds.right, window.innerWidth) - edgePadding;
    const shift =
      tooltipBounds.left < leftBoundary
        ? leftBoundary - tooltipBounds.left
        : tooltipBounds.right > rightBoundary
          ? rightBoundary - tooltipBounds.right
          : 0;
    tooltip.style.setProperty("--tooltip-x", `${centeredOffset + shift}px`);
  });
  return ref;
}

type TimelineTooltipRow = {
  period?: string;
  hour?: string;
  label?: string;
  costs?: Partial<Record<(typeof providerSeries)[number]["key"], number>>;
  models?: Partial<
    Record<
      (typeof providerSeries)[number]["key"],
      Array<{
        name: string;
        tokens: number;
        cost: number;
      }>
    >
  >;
  projectGroups?: Record<string, ProjectActivity[]>;
};

function tooltipModels(
  row: unknown,
  provider: (typeof providerSeries)[number]["key"],
) {
  return (row as TimelineTooltipRow | undefined)?.models?.[provider] ?? [];
}

type TooltipProject = {
  projectId: string;
  projectName: string;
  tokens: number;
  cost: number;
  providers: ProjectActivity[];
};

function tooltipProjects(row: unknown): TooltipProject[] {
  const projects = new Map<string, TooltipProject>();
  const groups = (row as TimelineTooltipRow | undefined)?.projectGroups ?? {};
  Object.values(groups)
    .flat()
    .forEach((activity) => {
      const project = projects.get(activity.projectId) ?? {
        projectId: activity.projectId,
        projectName: activity.projectName,
        tokens: 0,
        cost: 0,
        providers: [],
      };
      project.tokens += activity.tokens;
      project.cost += activity.cost;
      project.providers.push(activity);
      projects.set(activity.projectId, project);
    });
  return [...projects.values()]
    .map((project) => ({
      ...project,
      providers: project.providers.sort(
        (a, b) =>
          providerSeries.findIndex((provider) => provider.key === a.provider) -
          providerSeries.findIndex((provider) => provider.key === b.provider),
      ),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function ProviderChartTooltip({
  active,
  payload,
  label,
  coordinate,
  quotaMarkers = [],
  timeZone = systemTimeZone(),
}: ChartTooltipProps & { quotaMarkers?: QuotaMarker[]; timeZone?: string }) {
  const pinSource = useId();
  const liveRow = payload?.[0]?.payload as TimelineTooltipRow | undefined;
  // Days with no recorded activity still emit a zero-valued payload; showing a
  // card with nothing but a date in it is noise, so treat them as no hover —
  // unless a quota marker stands there, which is worth reading on its own.
  const hasActivity = Boolean(
    payload?.some((item) => typeof item.value === "number" && item.value > 0),
  );
  const point = liveRow?.period ?? liveRow?.hour ?? String(label);
  const worthShowing = hasActivity || quotaMarkersAt(quotaMarkers, point).length > 0;
  const claimKey = active && payload?.length && worthShowing ? point : null;
  const hold = useChartTooltipHold(
    active && payload?.length && worthShowing
      ? { payload, label, coordinate }
      : null,
    claimKey,
  );
  const tooltipRef = useClampedTooltip(
    Boolean(hold.snapshot),
    hold.snapshot?.coordinate,
  );
  if (!hold.snapshot) return null;
  const { payload: snapshotPayload, label: snapshotLabel } = hold.snapshot;
  const row = snapshotPayload[0]?.payload;
  const timelineRow = row as TimelineTooltipRow | undefined;
  const projects = tooltipProjects(row);
  const visibleProjects = projects.slice(0, 4);
  const projectTotal = projects.reduce(
    (sum, project) => sum + project.tokens,
    0,
  );
  const projectCost = projects.reduce((sum, project) => sum + project.cost, 0);
  const tooltipLabel = timelineRow?.period
    ? chartTooltipDateLabel(timelineRow.period)
    : timelineRow?.label ?? snapshotLabel;
  return (
    <PinnableChartTooltip
      id={`${pinSource}:${timelineRow?.period ?? timelineRow?.hour ?? String(snapshotLabel)}`}
      ariaLabel={`activity details for ${tooltipLabel}`}
      contextLabel="Activity"
      contextDescription="Tokens and API cost grouped by provider, model, and project for this point in time."
      contextPlacement="inline"
      className="provider-tooltip"
      forwardedRef={tooltipRef}
      interactionRef={hold.cardRef}
      retained={hold.retained}
      cardInteractionProps={hold.cardInteractionProps}
      pinInteractionProps={hold.pinInteractionProps}
    >
      <div className="tooltip-columns">
        <div className="tooltip-columns__date">
          <span className="tooltip-date-label">{tooltipLabel}</span>
          <ChartTooltipContext
            label="Activity"
            description="Tokens and API cost grouped by provider, model, and project for this point in time."
            className="chart-tooltip__context--inline"
          />
        </div>
        <small>Tokens</small>
        <small>API $</small>
      </div>
      <QuotaReachNotes
        markers={quotaMarkersAt(
          quotaMarkers,
          timelineRow?.period ?? timelineRow?.hour ?? snapshotLabel,
        )}
        timeZone={timeZone}
      />
      {providerSeries
        .map((provider) =>
          snapshotPayload.find((item) => item.dataKey === provider.key),
        )
        .filter(
          (
            item,
          ): item is ChartTooltipPayload & { dataKey: string; value: number } =>
            typeof item?.dataKey === "string" &&
            typeof item.value === "number" &&
            item.value > 0,
        )
        .map((item) => {
          const models = tooltipModels(
            row,
            item.dataKey as (typeof providerSeries)[number]["key"],
          );
          const visibleModels = models.slice(0, 3);
          return (
            <section className="tooltip-provider" key={item.dataKey}>
              <div className="tooltip-provider__head">
                <i style={{ background: item.color }} />
                <strong>{item.name}</strong>
                <b>{formatCompact(item.value)}</b>
                <b>
                  {formatMoney(
                    timelineRow?.costs?.[
                      item.dataKey as (typeof providerSeries)[number]["key"]
                    ] ?? 0,
                  )}
                </b>
              </div>
              {visibleModels.length > 0 && (
                <ul className="tooltip-provider-models">
                  {visibleModels.map((model) => (
                    <li key={model.name}>
                      <span>{model.name}</span>
                      <b>{formatCompact(model.tokens)}</b>
                      <b>{formatMoney(model.cost)}</b>
                    </li>
                  ))}
                </ul>
              )}
              {models.length > visibleModels.length && (
                <small className="tooltip-more-row tooltip-model-more">
                  <span>+{models.length - visibleModels.length} more</span>
                  <b>
                    {formatCompact(
                      models
                        .slice(3)
                        .reduce((sum, model) => sum + model.tokens, 0),
                    )}
                  </b>
                  <b>
                    {formatMoney(
                      models
                        .slice(3)
                        .reduce((sum, model) => sum + model.cost, 0),
                    )}
                  </b>
                </small>
              )}
            </section>
          );
        })}
      {visibleProjects.length > 0 && (
        <section className="tooltip-projects">
          <div className="tooltip-projects__head">
            <strong>Projects</strong>
            <b>{formatCompact(projectTotal)}</b>
            <b>{formatMoney(projectCost)}</b>
          </div>
          <ol className="tooltip-project-list">
            {visibleProjects.map((project) => (
              <li key={project.projectId}>
                <div className="tooltip-project-row">
                  <span>{project.projectName}</span>
                  <b>{formatCompact(project.tokens)}</b>
                  <b>{formatMoney(project.cost)}</b>
                </div>
                <div className="tooltip-project-providers">
                  {project.providers.map((providerActivity) => {
                    const provider = providerSeries.find(
                      (item) => item.key === providerActivity.provider,
                    )!;
                    const visibleModels = providerActivity.models.slice(0, 3);
                    return (
                      <section key={providerActivity.provider}>
                        <div className="tooltip-project-provider">
                          <i style={{ background: provider.color }} />
                          <span>{provider.label}</span>
                          <b>{formatCompact(providerActivity.tokens)}</b>
                          <b>{formatMoney(providerActivity.cost)}</b>
                        </div>
                        {visibleModels.length > 0 && (
                          <ul className="tooltip-project-models">
                            {visibleModels.map((model) => (
                              <li key={model.model}>
                                <span>{model.model}</span>
                                <b>{formatCompact(model.tokens)}</b>
                                <b>{formatMoney(model.cost)}</b>
                              </li>
                            ))}
                          </ul>
                        )}
                        {providerActivity.models.length >
                          visibleModels.length && (
                          <small className="tooltip-more-row tooltip-model-more project">
                            <span>
                              +
                              {providerActivity.models.length -
                                visibleModels.length}{" "}
                              more
                            </span>
                            <b>
                              {formatCompact(
                                providerActivity.models
                                  .slice(3)
                                  .reduce(
                                    (sum, model) => sum + model.tokens,
                                    0,
                                  ),
                              )}
                            </b>
                            <b>
                              {formatMoney(
                                providerActivity.models
                                  .slice(3)
                                  .reduce((sum, model) => sum + model.cost, 0),
                              )}
                            </b>
                          </small>
                        )}
                      </section>
                    );
                  })}
                </div>
              </li>
            ))}
          </ol>
          {projects.length > visibleProjects.length && (
            <small className="tooltip-more-row tooltip-project-more">
              <span>
                +{projects.length - visibleProjects.length} more projects
              </span>
              <b>
                {formatCompact(
                  projects
                    .slice(4)
                    .reduce((sum, project) => sum + project.tokens, 0),
                )}
              </b>
              <b>
                {formatMoney(
                  projects
                    .slice(4)
                    .reduce((sum, project) => sum + project.cost, 0),
                )}
              </b>
            </small>
          )}
        </section>
      )}
    </PinnableChartTooltip>
  );
}

function sessionDate(session: Session, timeZone = systemTimeZone()) {
  const activityDate = dateKeyInTimeZone(session.metadata?.lastActivity, timeZone);
  if (activityDate) return activityDate;
  const match = session.period.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function withoutCacheBreakdown(model: ModelBreakdown): ModelBreakdown {
  return { ...model, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function withoutCacheMetricRow<T extends MetricRow>(row: T): T {
  return {
    ...row,
    totalTokens: row.inputTokens + row.outputTokens,
    modelBreakdowns: row.modelBreakdowns.map(withoutCacheBreakdown),
    agents: row.agents?.map((agent) => withoutCacheMetricRow(agent)),
  };
}

function withoutCacheProjectTrend(row: ProjectTrendRow): ProjectTrendRow {
  return {
    ...row,
    totalTokens: row.inputTokens + row.outputTokens,
    modelBreakdowns: row.modelBreakdowns.map(withoutCacheBreakdown),
  };
}

function withoutCacheProjectActivity(
  activity: ProjectActivity[],
  sessions: Session[],
  timeZone: string,
) {
  const totals = new Map<
    string,
    { tokens: number; models: Map<string, { tokens: number; cost: number }> }
  >();
  sessions.forEach((session) => {
    const date = sessionDate(session, timeZone);
    const provider = providerKey(session.agent);
    const projectId = session.cwd?.replace(/\/+$/, "");
    if (
      !date ||
      !projectId ||
      !provider
    )
      return;
    const key = `${date}\0${provider}\0${projectId}`;
    const current = totals.get(key) ?? { tokens: 0, models: new Map() };
    current.tokens += session.inputTokens + session.outputTokens;
    session.modelBreakdowns.forEach((model) => {
      const modelTotal = current.models.get(model.modelName) ?? {
        tokens: 0,
        cost: 0,
      };
      modelTotal.tokens += model.inputTokens + model.outputTokens;
      modelTotal.cost += model.cost;
      current.models.set(model.modelName, modelTotal);
    });
    totals.set(key, current);
  });
  return activity.map((item) => {
    const total = totals.get(
      `${item.date}\0${item.provider}\0${item.projectId}`,
    );
    return {
      ...item,
      tokens: total?.tokens ?? 0,
      models: total
        ? [...total.models.entries()]
            .map(([model, values]) => ({ model, ...values }))
            .sort((left, right) => right.tokens - left.tokens)
        : [],
    };
  });
}

export function withoutCacheDashboardData(data: DashboardData): DashboardData {
  const sessions = data.sessions.map(withoutCacheMetricRow);
  const projects = data.projects.map((project) => {
    const trend = project.trend.map(withoutCacheProjectTrend);
    return {
      ...project,
      trend,
      tokens: trend.reduce((sum, row) => sum + row.totalTokens, 0),
    };
  });
  return {
    ...data,
    daily: data.daily.map(withoutCacheMetricRow),
    weekly: data.weekly.map(withoutCacheMetricRow),
    monthly: data.monthly.map(withoutCacheMetricRow),
    totals: {
      ...data.totals,
      totalTokens: data.totals.inputTokens + data.totals.outputTokens,
    },
    sessions,
    projectActivity: withoutCacheProjectActivity(data.projectActivity, sessions, data.timeZone),
    projects,
    models: data.models.map((model) => ({
      ...model,
      tokens: model.inputTokens + model.outputTokens,
    })),
  };
}

function metricRowTraffic(row: MetricRow) {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheReadTokens +
    row.cacheCreationTokens
  );
}

export function metricRowCacheShare(row: MetricRow) {
  const traffic = metricRowTraffic(row);
  return traffic > 0 ? (row.cacheReadTokens / traffic) * 100 : null;
}

function metricTotals(rows: MetricRow[]) {
  return rows.reduce(
    (sum, row) => ({
      tokens: sum.tokens + row.totalTokens,
      cost: sum.cost + row.totalCost,
      output: sum.output + row.outputTokens,
      cache: sum.cache + row.cacheReadTokens,
      traffic: sum.traffic + metricRowTraffic(row),
    }),
    { tokens: 0, cost: 0, output: 0, cache: 0, traffic: 0 },
  );
}

type MetricAverageSlice = "day" | "weekday" | "weekend";
export type MetricAverageSlices = Record<MetricAverageSlice, number | null>;
type MetricChange = (current: number, previous: number) => number | undefined;

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function metricAverageSlice(period: string): Exclude<MetricAverageSlice, "day"> {
  const day = new Date(`${period}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

/** Averages over rows with activity. The dashboard's daily rows are sparse, so this keeps
 * the denominator consistent with the existing active-day count shown on the cards. */
export function averageMetricSlices(
  rows: MetricRow[],
  select: (row: MetricRow) => number | null,
): MetricAverageSlices {
  const values: Record<MetricAverageSlice, number[]> = {
    day: [],
    weekday: [],
    weekend: [],
  };
  rows.forEach((row) => {
    const value = select(row);
    if (value === null || !Number.isFinite(value)) return;
    values.day.push(value);
    values[metricAverageSlice(row.period)].push(value);
  });
  return {
    day: average(values.day),
    weekday: average(values.weekday),
    weekend: average(values.weekend),
  };
}

const metricAverageSliceLabels: Array<{ key: MetricAverageSlice; label: string }> = [
  { key: "day", label: "DAY" },
  { key: "weekday", label: "WEEKDAY" },
  { key: "weekend", label: "WEEKEND" },
];

function metricAverageCardItems(
  current: MetricAverageSlices,
  previous: MetricAverageSlices,
  format: (value: number) => string,
  calculateTrend: MetricChange = percentChange,
): MetricCardAverage[] {
  return metricAverageSliceLabels.map(({ key, label }) => {
    const value = current[key];
    const previousValue = previous[key];
    return {
      label,
      value: value === null ? "—" : format(value),
      trend:
        value !== null && previousValue !== null
          ? calculateTrend(value, previousValue)
          : undefined,
    };
  });
}

function modelDistribution(rows: MetricRow[], metric: Metric) {
  const models = new Map<
    string,
    {
      name: string;
      provider: ReturnType<typeof providerKey>;
      tokens: number;
      cost: number;
      outputTokens: number;
    }
  >();
  rows.forEach((row) => {
    const sources = row.agents?.length ? row.agents : [row];
    sources.forEach((source) => {
      const provider = providerKey(source.agent);
      source.modelBreakdowns.forEach((model) => {
        const modelKey = `${provider ?? "unknown"}:${model.modelName}`;
        const current = models.get(modelKey) ?? {
          name: model.modelName,
          provider,
          tokens: 0,
          cost: 0,
          outputTokens: 0,
        };
        current.tokens +=
          model.inputTokens +
          model.outputTokens +
          model.cacheReadTokens +
          model.cacheCreationTokens;
        current.cost += model.cost;
        current.outputTokens += model.outputTokens;
        models.set(modelKey, current);
      });
    });
  });
  const key =
    metric === "totalCost"
      ? "cost"
      : metric === "outputTokens"
        ? "outputTokens"
        : "tokens";
  return [...models.values()]
    .map((values) => ({
      rawName: values.name,
      name: values.name.replace(/^claude-|^gpt-/, ""),
      value: values[key],
      provider: values.provider,
      color:
        providerSeries.find((series) => series.key === values.provider)?.color ??
        "var(--aqua)",
    }))
    .sort((a, b) => b.value - a.value);
}

function modelSignalColor(baseColor: string, dominant: string | null) {
  if (dominant === "low")
    return `color-mix(in oklch, ${baseColor} 82%, white)`;
  if (dominant === "high")
    return `color-mix(in oklch, ${baseColor} 82%, black)`;
  if (dominant === "xhigh")
    return `color-mix(in oklch, ${baseColor} 66%, black)`;
  return baseColor;
}

function combineMetricRows(
  rows: MetricRow[],
  agent: string,
  period: string,
): MetricRow {
  const models = new Map<string, ModelBreakdown>();
  const totals = rows.reduce(
    (total, row) => {
      row.modelBreakdowns.forEach((model) => {
        const current = models.get(model.modelName) ?? {
          modelName: model.modelName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: 0,
        };
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
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  );
  return {
    agent,
    period,
    ...totals,
    modelsUsed: [...models.keys()],
    modelBreakdowns: [...models.values()],
  };
}

export function pathFilteredRows(sessions: Session[], periods: Set<string>, timeZone = systemTimeZone()) {
  const sessionsByPeriod = new Map<string, Session[]>();
  sessions.forEach((session) => {
    const date = sessionDate(session, timeZone);
    if (date === null || !periods.has(date)) return;
    sessionsByPeriod.set(date, [
      ...(sessionsByPeriod.get(date) ?? []),
      session,
    ]);
  });
  return [...sessionsByPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, daySessions]) => {
      const agents = [
        ...new Set(daySessions.map((session) => session.agent)),
      ].map((agent) =>
        combineMetricRows(
          daySessions.filter((session) => session.agent === agent),
          agent,
          period,
        ),
      );
      return { ...combineMetricRows(daySessions, "all", period), agents };
    });
}

function percentChange(current: number, previous: number) {
  return previous > 0
    ? Math.round(((current - previous) / previous) * 100)
    : undefined;
}

function percentagePointChange(current: number, previous: number) {
  return Math.round(current - previous);
}

const quotaMarkerColors = {
  anthropic: "var(--anthropic-color)",
  codex: "var(--openai-color)",
} as const;

function QuotaMarkerLegend({ markers }: { markers: QuotaMarker[] }) {
  if (markers.length === 0) return null;
  const hasClaude = markers.some((marker) => marker.provider === "anthropic");
  const hasCodex = markers.some((marker) => marker.provider === "codex");
  return (
    <div className="quota-marker-legend" aria-label="Quota event markers">
      {hasClaude && <span><i className="anthropic" />Claude events</span>}
      {hasCodex && <span><i className="codex" />Codex events</span>}
    </div>
  );
}

/** Restates the quota markers standing at one chart point inside the tooltip
 * card, which opens directly over the marker's own rotated label and hides it. */
function QuotaReachNotes({
  markers,
  timeZone,
}: {
  markers: QuotaMarker[];
  timeZone: string;
}) {
  if (markers.length === 0) return null;
  return (
    <section className="tooltip-quota" aria-label="Quota events">
      {markers.flatMap((marker) => {
        const name = marker.provider === "anthropic" ? "Claude" : "Codex";
        return marker.entries.map((entry) => (
          <div className="tooltip-quota__row" key={`${marker.key}:${entry.kind}`}>
            <i style={{ background: quotaMarkerColors[marker.provider] }} />
            <span>
              {name} {entry.label}
              {entry.count > 1 ? ` ×${entry.count}` : ""}
            </span>
            <b>
              {entry.timestamps
                .map((timestamp) =>
                  new Date(timestamp).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone,
                  }),
                )
                .join(", ")}
            </b>
          </div>
        ));
      })}
    </section>
  );
}

function QuotaReferenceLines({
  markers,
  yAxisId,
}: {
  markers: QuotaMarker[];
  yAxisId?: string;
}) {
  return markers.map((marker, markerIndex) => {
    const sharedXIndex = markers
      .slice(0, markerIndex)
      .filter((candidate) => candidate.x === marker.x).length;
    return (
      <ReferenceLine
        key={marker.key}
        x={marker.x}
        yAxisId={yAxisId}
        stroke={quotaMarkerColors[marker.provider]}
        strokeWidth={1.5}
        strokeDasharray="3 3"
        strokeDashoffset={sharedXIndex * 3}
        ifOverflow="extendDomain"
        label={{
          content: ({ viewBox }) => {
            if (!viewBox || !("x" in viewBox) || !("y" in viewBox)) return null;
            const labelX = Number(viewBox.x) - 2 - sharedXIndex * 7;
            const labelY = Number(viewBox.y) + 4;
            const labelWidth = marker.label.length * 5.4;
            return (
              <g transform={`translate(${labelX} ${labelY}) rotate(-90)`}>
                <rect
                  x={-labelWidth - 1}
                  y={-10}
                  width={labelWidth + 3}
                  height={11}
                  rx={1.5}
                  fill="#000"
                  fillOpacity={0.6}
                />
                <text
                  x={0}
                  y={0}
                  fill={quotaMarkerColors[marker.provider]}
                  fontSize={9}
                  fontFamily="var(--font-label)"
                  textAnchor="end"
                >
                  {marker.label}
                </text>
              </g>
            );
          },
        }}
      />
    );
  });
}

function ProviderTimeline({
  rows,
  projectActivity,
  activeProvider,
  quotaHistory,
  timeZone,
  emptyText,
}: {
  rows: MetricRow[];
  projectActivity: ProjectActivity[];
  activeProvider: (typeof providerSeries)[number]["key"] | null;
  quotaHistory: DashboardData["quotas"]["history"];
  timeZone: string;
  emptyText: string;
}) {
  const projectsByDay = new Map<string, Record<string, ProjectActivity[]>>();
  projectActivity.forEach((project) => {
    if (activeProvider && project.provider !== activeProvider) return;
    const day = projectsByDay.get(project.date) ?? {};
    day[project.provider] = [...(day[project.provider] ?? []), project];
    projectsByDay.set(project.date, day);
  });
  const data = rows.map((row) => {
    const values = { anthropic: 0, codex: 0, warp: 0 };
    const costs = { anthropic: 0, codex: 0, warp: 0 };
    const modelMaps = {
      anthropic: new Map<string, { tokens: number; cost: number }>(),
      codex: new Map<string, { tokens: number; cost: number }>(),
      warp: new Map<string, { tokens: number; cost: number }>(),
    };
    if (row.agents?.length) {
      row.agents.forEach((item) => {
        const key = providerKey(item.agent);
        if (!key) return;
        values[key] += item.totalTokens;
        costs[key] += item.totalCost;
        item.modelBreakdowns.forEach((model) => {
          const total =
            model.inputTokens +
            model.outputTokens +
            model.cacheReadTokens +
            model.cacheCreationTokens;
          const current = modelMaps[key].get(model.modelName) ?? {
            tokens: 0,
            cost: 0,
          };
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
          const total =
            model.inputTokens +
            model.outputTokens +
            model.cacheReadTokens +
            model.cacheCreationTokens;
          const current = modelMaps[key].get(model.modelName) ?? {
            tokens: 0,
            cost: 0,
          };
          current.tokens += total;
          current.cost += model.cost;
          modelMaps[key].set(model.modelName, current);
        });
      }
    }
    const models = Object.fromEntries(
      Object.entries(modelMaps).map(([provider, entries]) => [
        provider,
        [...entries.entries()]
          .map(([name, values]) => ({ name, ...values }))
          .sort((a, b) => b.tokens - a.tokens),
      ]),
    );
    const projectGroups = projectsByDay.get(row.period) ?? {};
    return {
      ...values,
      period: row.period,
      costs,
      models,
      projectGroups,
      label: new Date(`${row.period}T12:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    };
  });
  const totals = providerSeries.map((provider) => ({
    ...provider,
    value: data.reduce((sum, row) => sum + row[provider.key], 0),
  }));
  const visibleProviders = totals.filter((provider) => provider.value > 0);
  const quotaMarkers = dailyQuotaMarkers(
    quotaHistory,
    rows.map((row) => row.period),
    activeProvider,
    timeZone,
  );
  if (visibleProviders.length === 0) return <Empty text={emptyText} />;
  return (
    <>
      <div className="provider-legend" aria-label="Activity providers">
        {visibleProviders.map((provider) => (
          <div key={provider.key}>
            <i style={{ background: provider.color }} />
            <span>{provider.label}</span>
            <b>{formatCompact(provider.value)}</b>
          </div>
        ))}
      </div>
      <QuotaMarkerLegend markers={quotaMarkers} />
      <div
        className="chart-wrap provider-chart"
        aria-label="Token usage by day, split into Claude, Codex, and Warp sections"
        role="img"
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 10, right: 8, left: -18, bottom: 0 }}
          >
            <defs>
              {visibleProviders.map((provider) => (
                <linearGradient
                  key={provider.key}
                  id={`${provider.key}Area`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={provider.color}
                    stopOpacity={0.58}
                  />
                  <stop
                    offset="100%"
                    stopColor={provider.color}
                    stopOpacity={0.13}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid
              stroke="#26312e"
              strokeDasharray="2 5"
              vertical={false}
            />
            <XAxis
              dataKey="period"
              tick={(props) => {
                const row = data.find(
                  (item) => item.period === String(props.payload?.value ?? ""),
                );
                return (
                  <ActivityAxisTick
                    {...props}
                    tokens={visibleProviders.map((provider) => ({
                      color: provider.color,
                      value: row?.[provider.key] ?? 0,
                    }))}
                  />
                );
              }}
              tickLine={false}
              axisLine={false}
              minTickGap={30}
              height={64}
            />
            <YAxis
              domain={[0, "auto"]}
              tickFormatter={formatCompact}
              tick={{ fill: "#71807b", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={
                <ProviderChartTooltip
                  quotaMarkers={quotaMarkers}
                  timeZone={timeZone}
                />
              }
              cursor={{ stroke: "#71807b", strokeDasharray: "3 3" }}
              offset={0}
              isAnimationActive={false}
              wrapperStyle={chartTooltipWrapperStyle}
            />
            <QuotaReferenceLines markers={quotaMarkers} />
            {visibleProviders.map((provider) => (
              <Area
                key={provider.key}
                type="monotone"
                dataKey={provider.key}
                name={provider.label}
                stroke={provider.color}
                strokeWidth={1.8}
                fill={`url(#${provider.key}Area)`}
                activeDot={{
                  r: 4,
                  fill: "#07100f",
                  stroke: provider.color,
                  strokeWidth: 2,
                }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export function periodTickLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  const weekday = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][
    date.getDay()
  ];
  const period = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${weekday} ${period}`;
}

function hourTickLabel(value: string) {
  return new Date(Date.UTC(2000, 0, 1, Number(value))).toLocaleTimeString(undefined, {
    hour: "numeric",
    timeZone: "UTC",
  });
}

function HourlyProviderTimeline({
  date,
  sessions,
  quotaHistory,
  timeZone,
  activeProvider,
  emptyText,
}: {
  date: string;
  sessions: Session[];
  quotaHistory: DashboardData["quotas"]["history"];
  timeZone: string;
  activeProvider: (typeof providerSeries)[number]["key"] | null;
  emptyText: string;
}) {
  const data = Array.from({ length: 24 }, (_, hour) => ({
    anthropic: 0,
    codex: 0,
    warp: 0,
    costs: { anthropic: 0, codex: 0, warp: 0 },
    models: {
      anthropic: [] as Array<{ name: string; tokens: number; cost: number }>,
      codex: [] as Array<{ name: string; tokens: number; cost: number }>,
      warp: [] as Array<{ name: string; tokens: number; cost: number }>,
    },
    modelMaps: {
      anthropic: new Map<string, { tokens: number; cost: number }>(),
      codex: new Map<string, { tokens: number; cost: number }>(),
      warp: new Map<string, { tokens: number; cost: number }>(),
    },
    projectGroups: {} as Record<string, ProjectActivity[]>,
    projectMaps: {
      anthropic: new Map<
        string,
        {
          projectId: string;
          projectName: string;
          tokens: number;
          cost: number;
          sessions: number;
          models: Map<string, { tokens: number; cost: number }>;
        }
      >(),
      codex: new Map<
        string,
        {
          projectId: string;
          projectName: string;
          tokens: number;
          cost: number;
          sessions: number;
          models: Map<string, { tokens: number; cost: number }>;
        }
      >(),
    },
    hour: String(hour),
    label: new Date(Date.UTC(2000, 0, 1, hour)).toLocaleTimeString(undefined, {
      hour: "numeric",
      timeZone: "UTC",
    }),
  }));
  sessions.forEach((session) => {
    const activity = session.metadata?.lastActivity;
    if (typeof activity !== "string" || dateKeyInTimeZone(activity, timeZone) !== date) return;
    const hour = hourInTimeZone(activity, timeZone);
    const provider = providerKey(session.agent);
    if (!provider || hour === null) return;
    const bucket = data[hour];
    bucket[provider] += session.totalTokens;
    bucket.costs[provider] += session.totalCost;
    session.modelBreakdowns.forEach((model) => {
      const tokens =
        model.inputTokens +
        model.outputTokens +
        model.cacheReadTokens +
        model.cacheCreationTokens;
      const current = bucket.modelMaps[provider].get(model.modelName) ?? {
        tokens: 0,
        cost: 0,
      };
      current.tokens += tokens;
      current.cost += model.cost;
      bucket.modelMaps[provider].set(model.modelName, current);
    });
    if (session.cwd && provider !== "warp") {
      const projectId = session.cwd.replace(/\/+$/, "");
      const project = bucket.projectMaps[provider].get(projectId) ?? {
        projectId,
        projectName: projectId.split("/").at(-1) ?? projectId,
        tokens: 0,
        cost: 0,
        sessions: 0,
        models: new Map<string, { tokens: number; cost: number }>(),
      };
      project.tokens += session.totalTokens;
      project.cost += session.totalCost;
      project.sessions++;
      session.modelBreakdowns.forEach((model) => {
        const tokens =
          model.inputTokens +
          model.outputTokens +
          model.cacheReadTokens +
          model.cacheCreationTokens;
        const current = project.models.get(model.modelName) ?? {
          tokens: 0,
          cost: 0,
        };
        current.tokens += tokens;
        current.cost += model.cost;
        project.models.set(model.modelName, current);
      });
      bucket.projectMaps[provider].set(projectId, project);
    }
  });
  data.forEach((bucket) =>
    providerSeries.forEach((provider) => {
      bucket.models[provider.key] = [
        ...bucket.modelMaps[provider.key].entries(),
      ]
        .map(([name, values]) => ({ name, ...values }))
        .sort((a, b) => b.tokens - a.tokens);
    }),
  );
  data.forEach((bucket) =>
    (["anthropic", "codex"] as const).forEach((provider) => {
      bucket.projectGroups[provider] = [
        ...bucket.projectMaps[provider].values(),
      ]
        .map((project) => ({
          ...project,
          provider,
          date,
          models: [...project.models.entries()]
            .map(([model, values]) => ({ model, ...values }))
            .sort((a, b) => b.tokens - a.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens);
    }),
  );
  const totals = providerSeries.map((provider) => ({
    ...provider,
    value: data.reduce((sum, bucket) => sum + bucket[provider.key], 0),
  }));
  const visibleProviders = totals.filter((provider) => provider.value > 0);
  const visibleStackedProviders = [...visibleProviders].reverse();
  const quotaMarkers = hourlyQuotaMarkers(quotaHistory, date, activeProvider, timeZone);
  if (visibleProviders.length === 0) return <Empty text={emptyText} />;
  return (
    <>
      <div className="provider-legend" aria-label="Activity providers">
        {visibleProviders.map((provider) => (
          <div key={provider.key}>
            <i style={{ background: provider.color }} />
            <span>{provider.label}</span>
            <b>{formatCompact(provider.value)}</b>
          </div>
        ))}
      </div>
      <QuotaMarkerLegend markers={quotaMarkers} />
      <div
        className="chart-wrap provider-chart"
        aria-label="Session token usage by last activity hour, split into Claude, Codex, and Warp sections"
        role="img"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 10, right: 8, left: -18, bottom: 0 }}
          >
            <CartesianGrid
              stroke="#26312e"
              strokeDasharray="2 5"
              vertical={false}
            />
            <XAxis
              dataKey="hour"
              tickFormatter={hourTickLabel}
              interval={2}
              tick={{ fill: "#71807b", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={formatCompact}
              tick={{ fill: "#71807b", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={
                <ProviderChartTooltip
                  quotaMarkers={quotaMarkers}
                  timeZone={timeZone}
                />
              }
              cursor={{ fill: "#15211d" }}
              offset={0}
              isAnimationActive={false}
              wrapperStyle={chartTooltipWrapperStyle}
            />
            <QuotaReferenceLines markers={quotaMarkers} />
            {visibleStackedProviders.map((provider) => (
              <Bar
                key={provider.key}
                dataKey={provider.key}
                name={provider.label}
                stackId="providers"
                fill={provider.color}
                maxBarSize={26}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
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
  reachedAt?: number[];
};

type QuotaCard = {
  provider: "anthropic" | "codex" | "warp";
  providerLabel: string;
  state: QuotaState;
  buckets: QuotaBucket[];
  bankedResets: Array<{ id: string; title: string; expiresAt: string | null }>;
  usedResetCount: number;
  usedResets: Array<{ id: string; title: string; usedAt: number }>;
};

function quotaBucket(
  id: string,
  windowLabel: string,
  usedPercent: number | null,
  resetAt: number | null,
  resetVerb: "resets" | "renews",
  reportStatus: string | undefined,
  detail?: string,
  suspended = false,
  historyWindow?: "fiveHour" | "weekly",
  reachedCount?: number,
  reachedAt?: number[],
): QuotaBucket {
  const hasValue = usedPercent !== null && Number.isFinite(usedPercent);
  const expired = hasValue && resetAt !== null && resetAt <= Date.now();
  const state = suspended
    ? "suspended"
    : reportStatus === "unavailable" || reportStatus === "unknown" || !hasValue
      ? "unavailable"
      : expired
        ? "expired"
        : reportStatus === "stale"
          ? "stale"
          : "ok";
  return {
    id,
    windowLabel,
    usedPercent,
    resetAt,
    resetVerb,
    state,
    detail:
      detail ??
      (hasValue
        ? `${Math.max(0, 100 - usedPercent).toFixed(0)}% available`
        : suspended
          ? "temporarily suspended"
          : "not currently reported"),
    historyWindow,
    reachedCount,
    reachedAt,
  };
}

function quotaCards(quotas: DashboardData["quotas"]): QuotaCard[] {
  const reports = new Map(
    quotas.usage?.providers.map((provider) => [provider.provider, provider]) ??
      [],
  );
  const reachHistory = (
    provider: "codex" | "anthropic",
    window: "fiveHour" | "weekly",
  ) =>
    quotas.history?.windows.find(
      (item) => item.provider === provider && item.window === window,
    );
  const anthropic = reports.get("anthropic");
  const anthropicSnapshot =
    anthropic?.snapshot?.kind === "window" ? anthropic.snapshot : null;
  const anthropicBuckets = [
    quotaBucket(
      "anthropic-five-hour",
      "5-hour",
      anthropicSnapshot?.fiveHour?.usedPercent ?? null,
      anthropicSnapshot?.fiveHour?.resetsAt ?? null,
      "resets",
      anthropic?.status,
      anthropic?.error,
      false,
      "fiveHour",
      reachHistory("anthropic", "fiveHour")?.reachedCount,
      reachHistory("anthropic", "fiveHour")?.reachedAt,
    ),
    quotaBucket(
      "anthropic-weekly",
      "Weekly",
      anthropicSnapshot?.weekly?.usedPercent ?? null,
      anthropicSnapshot?.weekly?.resetsAt ?? null,
      "resets",
      anthropic?.status,
      anthropic?.error,
      false,
      "weekly",
      reachHistory("anthropic", "weekly")?.reachedCount,
      reachHistory("anthropic", "weekly")?.reachedAt,
    ),
    ...Object.entries(anthropicSnapshot?.modelWindows ?? {}).map(
      ([model, window]) =>
        quotaBucket(
          `anthropic-${model}`,
          `${model} bucket`,
          window.usedPercent,
          window.resetsAt,
          "resets",
          anthropic?.status,
        ),
    ),
  ];
  const codex = reports.get("codex");
  const codexSnapshot =
    codex?.snapshot?.kind === "window" ? codex.snapshot : null;
  const codexBuckets = [
    quotaBucket(
      "codex-five-hour",
      "5-hour",
      codexSnapshot?.fiveHour?.usedPercent ?? null,
      codexSnapshot?.fiveHour?.resetsAt ?? null,
      "resets",
      codex?.status,
      codex?.error,
      Boolean(codexSnapshot && !codexSnapshot.fiveHour),
      "fiveHour",
      reachHistory("codex", "fiveHour")?.reachedCount,
      reachHistory("codex", "fiveHour")?.reachedAt,
    ),
    quotaBucket(
      "codex-weekly",
      "Weekly",
      codexSnapshot?.weekly?.usedPercent ?? null,
      codexSnapshot?.weekly?.resetsAt ?? null,
      "resets",
      codex?.status,
      codex?.error,
      false,
      "weekly",
      reachHistory("codex", "weekly")?.reachedCount,
      reachHistory("codex", "weekly")?.reachedAt,
    ),
  ];
  const warp = reports.get("warp");
  const pool = warp?.snapshot?.kind === "pool" ? warp.snapshot.pool : null;
  const warpBuckets = [
    quotaBucket(
      "warp-monthly",
      pool?.cadence ?? "Monthly",
      pool?.usedPercent ?? null,
      pool?.refreshesAt ?? null,
      "renews",
      warp?.status,
      pool
        ? `${pool.used.toLocaleString()} / ${pool.limit.toLocaleString()} requests`
        : warp?.error,
    ),
  ];
  const banked = quotas.resets?.codexBankedResetCredits;
  const bankedResets =
    banked?.credits
      .filter((credit) => credit.status === "available")
      .map(({ id, title, expiresAt }) => ({ id, title, expiresAt })) ?? [];
  return [
    {
      provider: "anthropic",
      providerLabel: "Anthropic",
      state:
        anthropic?.status === "ok"
          ? "ok"
          : anthropic?.status === "stale"
            ? "stale"
            : "unavailable",
      buckets: anthropicBuckets,
      bankedResets: [],
      usedResetCount: 0,
      usedResets: [],
    },
    {
      provider: "codex",
      providerLabel: "OpenAI",
      state:
        codex?.status === "ok"
          ? "ok"
          : codex?.status === "stale"
            ? "stale"
            : "unavailable",
      buckets: codexBuckets,
      bankedResets,
      usedResetCount: quotas.history?.codexBankedResets.usedCount ?? 0,
      usedResets: quotas.history?.codexBankedResets.used ?? [],
    },
    {
      provider: "warp",
      providerLabel: "Warp",
      state:
        warp?.status === "ok"
          ? "ok"
          : warp?.status === "stale"
            ? "stale"
            : "unavailable",
      buckets: warpBuckets,
      bankedResets: [],
      usedResetCount: 0,
      usedResets: [],
    },
  ];
}

function WarpQuotaDetails({ report }: { report: QuotaProvider | undefined }) {
  const summary = warpQuotaSummary(report);
  const freshness =
    summary.dataAgeMs === null ? "unknown" : `${formatDuration(summary.dataAgeMs)} ago`;
  const hasVoice =
    summary.voiceRequestsUsed !== null ||
    summary.voiceRequestLimit !== null ||
    summary.voiceUnlimited !== null;
  const hasCodebase =
    summary.codebaseIndicesLimit !== null ||
    summary.codebaseIndicesUnlimited !== null ||
    summary.maxFilesPerRepo !== null;
  const hasDetails =
    summary.remainingRequests !== null ||
    summary.dataAgeMs !== null ||
    summary.addonCredits !== null ||
    hasVoice ||
    hasCodebase;

  if (!hasDetails) return null;

  const addonMeta =
    summary.addonCreditNote ??
    (summary.addonCreditUpdatedAt === null
      ? "manually reported"
      : `updated ${formatDate(new Date(summary.addonCreditUpdatedAt).toISOString())}`);
  const voiceParts = [
    summary.voiceRequestsUsed === null
      ? null
      : `${summary.voiceRequestsUsed.toLocaleString()} used`,
    summary.voiceRequestLimit === null
      ? summary.voiceUnlimited === true
        ? "unlimited"
        : null
      : `of ${summary.voiceRequestLimit.toLocaleString()}`,
  ].filter((part): part is string => part !== null);

  return (
    <div className="warp-quota-details" aria-label="Warp quota details">
      <div className="warp-quota-facts">
        {summary.remainingRequests !== null && (
          <div>
            <span>Remaining</span>
            <b>{summary.remainingRequests.toLocaleString()} requests</b>
          </div>
        )}
        <div>
          <span>Freshness</span>
          <b>{freshness}</b>
        </div>
      </div>
      {summary.addonCredits !== null && (
        <div className="warp-quota-credit">
          <div className="warp-quota-detail-head">
            <span>Manual add-on credits</span>
            <b>{formatWarpCredits(summary.addonCredits)}</b>
          </div>
          <small>{addonMeta} · separate from the request pool</small>
        </div>
      )}
      {(hasVoice || hasCodebase) && (
        <div className="warp-quota-features">
          <div className="warp-quota-detail-head">
            <span>Feature limits</span>
            <small>provider reported</small>
          </div>
          <dl>
            {hasVoice && (
              <div>
                <dt>Voice requests</dt>
                <dd>{voiceParts.length ? voiceParts.join(" ") : "not reported"}</dd>
              </div>
            )}
            {summary.codebaseIndicesLimit !== null || summary.codebaseIndicesUnlimited !== null ? (
              <div>
                <dt>Codebase indices</dt>
                <dd>
                  {summary.codebaseIndicesUnlimited === true
                    ? "Unlimited"
                    : summary.codebaseIndicesLimit === null
                      ? "not reported"
                      : `max ${summary.codebaseIndicesLimit.toLocaleString()}`}
                </dd>
              </div>
            ) : null}
            {summary.maxFilesPerRepo !== null && (
              <div>
                <dt>Files per repository</dt>
                <dd>max {summary.maxFilesPerRepo.toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <small>Feature limits are separate from monthly request usage.</small>
        </div>
      )}
    </div>
  );
}

const CLAUDE_USAGE_URL = "https://claude.ai/new#settings/usage";

const freshnessLabel: Record<CreditFreshness, string> = {
  fresh: "fresh",
  aging: "aging",
  stale: "stale",
};

function importedAgo(capturedAt: number): string {
  const ms = Date.now() - capturedAt;
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AnthropicCredits({
  view,
  onUpdate,
}: {
  view: AnthropicCreditView;
  onUpdate?: () => void;
}) {
  const { usageCredit, prepaid, fable, importedAt, importFreshness } = view;
  if (!usageCredit && !prepaid && !fable) {
    // Nothing to show, but still offer the import affordance so a first-time
    // user can seed the Claude Web snapshot.
    return onUpdate ? (
      <div className="quota-credits quota-credits--empty">
        <button type="button" className="ghost-button" onClick={onUpdate}>
          <CircleDollarSign /> Add Claude Web credits
        </button>
      </div>
    ) : null;
  }
  return (
    <div className="quota-credits">
      {usageCredit && (
        <div className="credit-line">
          <span className="credit-line__label">
            <Zap /> Usage credit spend
          </span>
          <b>
            {formatCredit(usageCredit.spent, usageCredit.currency)}
            {usageCredit.limit !== null && (
              <span className="credit-line__cap">
                {" / "}
                {formatCredit(usageCredit.limit, usageCredit.currency)}
              </span>
            )}
          </b>
          <small>
            {usageCredit.percent !== null ? `${usageCredit.percent.toFixed(0)}% used · ` : ""}
            {usageCredit.enabled ? "enabled" : "disabled"} · live OAuth
          </small>
        </div>
      )}
      {prepaid && (
        <div className="credit-line">
          <span className="credit-line__label">
            <CircleDollarSign /> Prepaid balance
          </span>
          <b>{formatCredit(prepaid.balance, prepaid.currency)}</b>
          <small>
            imported {importedAgo(prepaid.capturedAt)}
            {prepaid.freshness && prepaid.freshness !== "fresh"
              ? ` · ${freshnessLabel[prepaid.freshness]}`
              : ""}{" "}
            · Claude Web import
          </small>
        </div>
      )}
      {fable && (
        <div className={`fable-credit${fable.expired ? " fable-credit--expired" : ""}`}>
          <div className="fable-credit__head">
            <span>
              <Sparkles /> Fable transition credit
            </span>
            {fable.expired && <i className="fable-credit__badge">expired</i>}
          </div>
          <strong>{formatCredit(fable.remaining, fable.currency)}</strong>
          <div className="fable-credit__meta">
            {fable.grant !== null && (
              <span>of {formatCredit(fable.grant, fable.currency)} granted</span>
            )}
            {fable.expiresOn && (
              <span>
                {fable.expired ? "expired" : "expires"} {fable.expiresOn}
              </span>
            )}
            {fable.campaignId && (
              <span>
                {fable.campaignId}
                {fable.campaignGranted === false ? " · not granted" : ""}
              </span>
            )}
            {importedAt !== null && (
              <span>
                imported {importedAgo(importedAt)}
                {importFreshness && importFreshness !== "fresh"
                  ? ` · ${freshnessLabel[importFreshness]}`
                  : ""}
              </span>
            )}
          </div>
        </div>
      )}
      {onUpdate && (
        <button type="button" className="ghost-button credit-update" onClick={onUpdate}>
          <RefreshCw /> Update Claude Web snapshot
        </button>
      )}
    </div>
  );
}

function CodexCredits({ view }: { view: CodexCreditView }) {
  if (!view) return null;
  return (
    <div className="quota-credits">
      <div className="credit-line">
        <span className="credit-line__label">
          <Sparkles /> Codex credits
        </span>
        <b>{view.unlimited ? "Unlimited" : view.balance === null ? "—" : view.balance.toLocaleString()}</b>
        <small>{view.hasCredits ? "available · OpenAI account balance" : "not currently available · OpenAI account balance"}</small>
      </div>
    </div>
  );
}

function QuotaDials({
  quotas,
  onUpdateWebCredits,
}: {
  quotas: DashboardData["quotas"];
  onUpdateWebCredits?: () => void;
}) {
  const cards = quotaCards(quotas);
  const anthropicCredits = buildAnthropicCreditView(
    quotas.usage?.providers.find((provider) => provider.provider === "anthropic"),
  );
  const codexCredits = buildCodexCreditView(
    quotas.usage?.providers.find((provider) => provider.provider === "codex"),
  );
  const warpReport = quotas.usage?.providers.find(
    (provider) => provider.provider === "warp",
  );
  const trackingSince = quotas.history?.trackingSince
    ? new Date(quotas.history.trackingSince).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  return (
    <section className="quota-panel panel">
      <div className="panel-heading">
        <div>
          <span className="overline">SUBSCRIPTION WINDOWS</span>
          <h2>Usage & resets</h2>
        </div>
        <div className="quota-heading-meta">
          {trackingSince && <span>History since {trackingSince}</span>}
          {quotas.history?.available && (
            <span className="method-chip local">
              <i /> locally counted
            </span>
          )}
          <span className="method-chip">
            <i /> provider reported
          </span>
        </div>
      </div>
      <div className="quota-grid">
        {cards.map((card) => {
          const stateLabel = card.state === "ok" ? "current" : card.state;
          return (
            <article
              className={`quota-card ${card.provider} ${card.state}`}
              key={card.provider}
            >
              <div className="quota-card__head">
                <span>{card.providerLabel}</span>
                <i>{stateLabel}</i>
              </div>
              <div className="quota-buckets">
                {card.buckets.map((bucket) => {
                  const percent =
                    bucket.usedPercent === null
                      ? null
                      : Math.max(0, Math.min(100, bucket.usedPercent));
                  return (
                    <div
                      className={`quota-bucket ${bucket.state}`}
                      key={bucket.id}
                      aria-label={`${card.providerLabel} ${bucket.windowLabel}: ${percent === null ? bucket.state : `${percent.toFixed(0)}% used`}`}
                    >
                      <div
                        className="quota-dial"
                        style={
                          {
                            "--used": `${percent ?? 0}%`,
                          } as React.CSSProperties
                        }
                      >
                        <div>
                          <strong>
                            {percent === null ? "—" : `${percent.toFixed(0)}%`}
                          </strong>
                          <span>
                            {percent === null ? bucket.state : "used"}
                          </span>
                        </div>
                      </div>
                      <div className="quota-bucket__copy">
                        <div className="quota-bucket__top">
                          <b>{bucket.windowLabel}</b>
                          <span>
                            {percent === null ? bucket.state : bucket.detail}
                          </span>
                        </div>
                        <small>
                          {bucket.state === "suspended"
                            ? "Rate limit temporarily suspended"
                            : resetCopy(bucket.resetAt, bucket.resetVerb)}
                        </small>
                        {bucket.historyWindow && (
                          <div className="quota-history">
                            <div className="quota-history__head">
                              <span>Recorded reaches</span>
                              <b>
                                {bucket.reachedCount === undefined
                                  ? "Not tracked"
                                  : `${bucket.reachedCount}× observed`}
                              </b>
                            </div>
                            {bucket.reachedAt && bucket.reachedAt.length > 0 && (
                              <ol aria-label={`${card.providerLabel} ${bucket.windowLabel} quota reaches`}>
                                {bucket.reachedAt.map((reachedAt) => (
                                  <li key={reachedAt}>
                                    <time dateTime={new Date(reachedAt).toISOString()}>
                                      {new Date(reachedAt).toLocaleString(undefined, {
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                        hour: "numeric",
                                        minute: "2-digit",
                                      })}
                                    </time>
                                  </li>
                                ))}
                              </ol>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {card.provider === "warp" && <WarpQuotaDetails report={warpReport} />}
              {card.provider === "anthropic" && (
                <AnthropicCredits
                  view={anthropicCredits}
                  onUpdate={onUpdateWebCredits}
                />
              )}
              {card.provider === "codex" && <CodexCredits view={codexCredits} />}
              {card.provider === "codex" && (
                <div className="banked-resets">
                  <div className="reset-summary">
                    <div className="reset-summary__heading">
                      <span>Banked resets</span>
                      <b>{card.bankedResets.length} available</b>
                    </div>
                    {card.bankedResets.map((credit) => {
                      const expiry = expiryCopy(credit.expiresAt);
                      return (
                        <small
                          className={expiry.urgent ? "expiring-soon" : undefined}
                          key={credit.id}
                        >
                          <Sparkles /> {credit.title} · {expiry.text}
                        </small>
                      );
                    })}
                  </div>
                  <div className="reset-summary reset-use">
                    <div className="reset-summary__heading">
                      <span>Resets used</span>
                      <b>
                        {quotas.history?.available
                          ? `${card.usedResetCount} observed`
                          : "Not tracked"}
                      </b>
                    </div>
                    {card.usedResets.map((reset) => (
                      <small key={reset.id}>
                        <Sparkles /> {reset.title} · used {new Date(reset.usedAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </small>
                    ))}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Overview({
  data,
  daily,
  sessions,
  agent,
  pathTag,
  metricRange,
  customRange,
  dateRange,
  availableRange,
  onMetricRangeChange,
  onOpenSession,
  onTagSession,
  onUpdateWebCredits,
  accent,
  providerColors,
  sceneEffects,
}: {
  data: DashboardData;
  daily: MetricRow[];
  sessions: Session[];
  agent: AgentSelection;
  pathTag: string;
  metricRange: MetricRange;
  customRange: DateRange | null;
  dateRange: DateRange | null;
  availableRange: DateRange | null;
  onMetricRangeChange: (range: MetricRange, customRange?: DateRange) => void;
  onOpenSession: (sessionId: string) => void;
  onTagSession: (session: Session) => void;
  onUpdateWebCredits: () => void;
  accent: string;
  providerColors: ProviderColors;
  sceneEffects: SceneEffects;
}) {
  const [benchmarkModal, setBenchmarkModal] = useState(false);
  // Effort follows the same global range, provider, and path-tag controls as everything else on
  // this page; the headline token and cost cards are untouched.
  const effortRequest = useEffortAggregate(
    "provider",
    globalEffortScope(agent, dateRange, pathTag),
  );
  const digestRequest = useEffortSessions({});
  // Combos are the primary reading: an effort value is only comparable beside the model that
  // recorded it. The aggregate stack remains useful as secondary context.
  const comboDaysRequest = useEffortComboDays(
    globalEffortScope(agent, dateRange, pathTag),
  );
  const statusRequest = useEffortStatus();
  const effort = effortRequest.data;
  const effortDigest = digestRequest.data;
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [
    effortRequest.load,
    digestRequest.load,
    comboDaysRequest.load,
  ]);
  const effortBySession = useMemo(
    () => decodeEffortDigest(effortDigest),
    [effortDigest],
  );
  const { topCombos, comboTotalTokens } = useMemo(() => {
    const totals = new Map<string, { family: string; effort: string; tokens: number }>();
    for (const row of comboDaysRequest.data?.rows ?? []) {
      if (row.suppressed) continue;
      for (const bucket of row.buckets) {
        if (!bucket.effort || bucket.tokens <= 0) continue;
        const key = comboKey(bucket);
        const entry = totals.get(key) ?? { family: bucket.family, effort: bucket.effort, tokens: 0 };
        entry.tokens += bucket.tokens;
        totals.set(key, entry);
      }
    }
    const ranked = [...totals.values()].sort((a, b) => b.tokens - a.tokens);
    return {
      topCombos: ranked.slice(0, 4),
      comboTotalTokens: ranked.reduce((sum, combo) => sum + combo.tokens, 0),
    };
  }, [comboDaysRequest.data]);
  const totals = metricTotals(daily);
  const previousDaily = metricRangeRows(data.daily, metricRange, customRange, 1)
    .map((row) => selectAgentRow(row, agent))
    .filter(Boolean) as MetricRow[];
  const previousTotals = metricTotals(previousDaily);
  const tokenAverages = averageMetricSlices(daily, (row) => row.totalTokens);
  const previousTokenAverages = averageMetricSlices(
    previousDaily,
    (row) => row.totalTokens,
  );
  const costAverages = averageMetricSlices(daily, (row) => row.totalCost);
  const previousCostAverages = averageMetricSlices(
    previousDaily,
    (row) => row.totalCost,
  );
  const outputAverages = averageMetricSlices(daily, (row) => row.outputTokens);
  const previousOutputAverages = averageMetricSlices(
    previousDaily,
    (row) => row.outputTokens,
  );
  const cacheShareAverages = averageMetricSlices(daily, metricRowCacheShare);
  const previousCacheShareAverages = averageMetricSlices(
    previousDaily,
    metricRowCacheShare,
  );
  const activeBlock =
    data.blocks.find((block) => block.isActive) ?? data.blocks.at(-1);
  const blockStart = activeBlock ? Date.parse(activeBlock.startTime) : 0;
  const blockEnd = activeBlock ? Date.parse(activeBlock.endTime) : 0;
  const blockElapsed = !activeBlock
    ? 0
    : activeBlock.isActive
      ? Math.min(
          100,
          Math.max(
            0,
            ((Date.now() - blockStart) / Math.max(1, blockEnd - blockStart)) *
              100,
          ),
        )
      : 100;
  const agentTotals = new Map<string, number>();
  daily.forEach((row) =>
    (row.agents ?? [row]).forEach((item) =>
      agentTotals.set(
        item.agent,
        (agentTotals.get(item.agent) ?? 0) + item.totalTokens,
      ),
    ),
  );
  const agentChart = [...agentTotals.entries()].map(([name, value], index) => {
    const provider = providerKey(name);
    const color =
      provider === "anthropic"
        ? providerColors.anthropic
        : provider === "codex"
          ? providerColors.openai
          : provider === "warp"
            ? providerColors.warp
            : palette[index % palette.length];
    return { name, value, color };
  });
  const agentGrandTotal = agentChart.reduce((sum, item) => sum + item.value, 0);
  const recent = sessions.slice(0, 5);
  const cacheShare = totals.traffic
    ? Math.round((totals.cache / totals.traffic) * 100)
    : 0;
  const previousCacheShare = previousTotals.traffic
    ? Math.round((previousTotals.cache / previousTotals.traffic) * 100)
    : 0;
  const rangeLabel = metricRangeLabel(metricRange, customRange);
  const periodLabel =
    daily.length === 1
      ? new Date(`${daily[0].period}T12:00:00`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : daily.length > 1
        ? `${new Date(`${daily[0].period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${new Date(`${daily.at(-1)!.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
        : "No activity in this span";
  return (
    <div className="view-stack page-enter">
      <section className="hero-grid">
        <div>
          <p className="kicker">
            <span /> LIVE LOCAL TELEMETRY
          </p>
          <h1>
            Your AI Usage <em>Observatory.</em>
          </h1>
          <p className="hero-copy">
            A local-first view of where agent time, tokens, and estimated
            API-equivalent cost are going.
          </p>
        </div>
        <HeadroomOrrery
          accent={accent}
          effects={sceneEffects}
          providerColors={providerColors}
          headroom={providerHeadroom(data.quotas)}
        />
      </section>
      <QuotaDials quotas={data.quotas} onUpdateWebCredits={onUpdateWebCredits} />
      <section
        className="metric-summary"
        aria-labelledby="metric-summary-title"
      >
        <div className="metric-summary__heading">
          <div>
            <span className="overline">SUMMARY & TRAJECTORY</span>
            <h2 id="metric-summary-title">{rangeLabel}</h2>
            <p>
              {periodLabel}
              {metricRange === "all" && " · totals across all collected history"}
              {metricRange !== "all" &&
                " · card trends compare with the previous equal span"}
            </p>
          </div>
          <div className="metric-range">
            <span>Time span</span>
            <TimeRangeControl
              label="Summary and trajectory time span"
              value={metricRange}
              customRange={customRange}
              availableRange={availableRange}
              resolvedRange={dateRange}
              expandedLabels
              onChange={onMetricRangeChange}
            />
          </div>
        </div>
        <div className="metric-grid">
          <MetricCard
            eyebrow="TOTAL TOKENS"
            value={formatCompact(totals.tokens)}
            detail={`${daily.length} active ${daily.length === 1 ? "day" : "days"}`}
            trend={percentChange(totals.tokens, previousTotals.tokens)}
            averages={metricAverageCardItems(
              tokenAverages,
              previousTokenAverages,
              formatCompact,
            )}
            icon={Zap}
          />
          <MetricCard
            eyebrow="API-EQUIVALENT COST"
            value={formatMoney(totals.cost)}
            detail="ccusage · offline pricing"
            trend={percentChange(totals.cost, previousTotals.cost)}
            averages={metricAverageCardItems(
              costAverages,
              previousCostAverages,
              formatMoney,
            )}
            icon={CircleDollarSign}
          />
          <MetricCard
            eyebrow="OUTPUT TOKENS"
            value={formatCompact(totals.output)}
            detail={`${totals.tokens ? Math.round((totals.output / totals.tokens) * 100) : 0}% of period tokens`}
            trend={percentChange(totals.output, previousTotals.output)}
            averages={metricAverageCardItems(
              outputAverages,
              previousOutputAverages,
              formatCompact,
            )}
            icon={Sparkles}
          />
          <MetricCard
            eyebrow="CACHE SHARE"
            value={`${cacheShare}%`}
            detail={`${formatCompact(totals.cache)} read tokens`}
            trend={
              previousTotals.traffic
                ? cacheShare - previousCacheShare
                : undefined
            }
            trendUnit="pp"
            averages={metricAverageCardItems(
              cacheShareAverages,
              previousCacheShareAverages,
              (value) => `${Math.round(value)}%`,
              percentagePointChange,
            )}
            icon={Database}
          />
        </div>
        <article className="panel usage-trajectory-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">USAGE TRAJECTORY</span>
              <h2>Activity</h2>
              {metricRange === "1" && (
                <p>Sessions grouped by their last recorded activity hour.</p>
              )}
            </div>
            <span className="method-chip">
              <i /> ccusage derived
            </span>
          </div>
          {metricRange === "1" && daily.length === 1 ? (
            <HourlyProviderTimeline
              date={daily[0].period}
              sessions={sessions}
              quotaHistory={data.quotas.history}
              timeZone={data.timeZone}
              activeProvider={selectionProvider(agent)}
              emptyText={filterEmptyMessage(agent, metricRange, pathTag, customRange)}
            />
          ) : (
            <ProviderTimeline
              rows={daily}
              projectActivity={data.projectActivity}
              activeProvider={selectionProvider(agent)}
              quotaHistory={data.quotas.history}
              timeZone={data.timeZone}
              emptyText={filterEmptyMessage(agent, metricRange, pathTag, customRange)}
            />
          )}
        </article>
      </section>
      <section className="dashboard-grid">
        <article className="panel block-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">RECENT WINDOW</span>
              <h2>Five-hour block</h2>
            </div>
            <AlarmClock />
          </div>
          {activeBlock ? (
            <>
              <div
                className="block-ring"
                role="img"
                aria-label={`${Math.round(blockElapsed)}% of the five-hour window elapsed; ${formatCompact(activeBlock.totalTokens)} tokens used`}
                style={{ "--progress": `${blockElapsed}%` } as any}
              >
                <div>
                  <strong>{formatCompact(activeBlock.totalTokens)}</strong>
                  <span>tokens</span>
                </div>
              </div>
              <div className="block-stats">
                <div>
                  <span>Cost</span>
                  <b>{formatMoney(activeBlock.costUSD)}</b>
                </div>
                <div>
                  <span>Entries</span>
                  <b>{activeBlock.entries}</b>
                </div>
                <div>
                  <span>Scope</span>
                  <b>{data.blockScope}</b>
                </div>
              </div>
              <p className="scope-note">
                <Clock3 /> {formatDate(activeBlock.startTime)} →{" "}
                {formatDate(activeBlock.endTime)} · ring shows{" "}
                {activeBlock.isActive
                  ? `${Math.round(blockElapsed)}% of the window elapsed`
                  : "a completed window"}
              </p>
            </>
          ) : (
            <Empty text="No reconstructed blocks found." />
          )}
        </article>
        <article className="panel agent-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">AGENT MIX</span>
              <h2>Who used the context?</h2>
              <p>{rangeLabel} · follows the active filters</p>
            </div>
            <div className="panel-heading-actions">
              <button
                type="button"
                className="accent-icon-button benchmark-trigger"
                onClick={() => setBenchmarkModal(true)}
                aria-label="Compare model cost and efficiency benchmarks"
                title="Compare model cost and efficiency benchmarks"
              >
                <BenchmarkTriggerIcons />
              </button>
              <Bot />
            </div>
          </div>
          {benchmarkModal && <BenchmarkModal onClose={() => setBenchmarkModal(false)} />}
          <div className="agent-mix">
            <div className="donut-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={agentChart}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={51}
                    outerRadius={68}
                    stroke="none"
                  >
                    {agentChart.map((item) => (
                      <Cell key={item.name} fill={item.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <span>
                {agentChart.length}
                <small>agents</small>
              </span>
            </div>
            <div className="legend">
              {agentChart.map((item) => (
                <div key={item.name}>
                  <i style={{ background: item.color }} />
                  <span>{item.name}</span>
                  <b>
                    {Math.round(
                      (item.value / Math.max(1, agentGrandTotal)) * 100,
                    )}
                    %
                  </b>
                </div>
              ))}
            </div>
          </div>
        </article>
        <article className="panel effort-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">REASONING SIGNAL</span>
              <h2>Effort mix</h2>
            </div>
            <Gauge aria-hidden="true" />
          </div>
          {topCombos.length > 0 && (
            <div className="effort-panel__combos">
              <span className="overline">TOP MODEL × EFFORT</span>
              <div>
                {topCombos.map((combo) => (
                  <ComboPill
                    key={comboKey(combo)}
                    combo={combo}
                    trailing={sharePercent(combo.tokens, comboTotalTokens)}
                  />
                ))}
              </div>
            </div>
          )}
          <EffortState status={effort?.status ?? null} summary={effort?.total}>
            {effort?.total && (
              <div className="effort-panel__aggregate">
                <span className="overline">AGGREGATE EFFORT</span>
                <div className="effort-provider-bars">
                  {/* Combined first, then one bar per provider, so a mix that reads as balanced
                   * overall can still be seen to come from two different distributions. */}
                  <div className="effort-provider-bar">
                    <div>
                      <h3>All providers</h3>
                      <EffortBadge summary={effort.total} />
                    </div>
                    <EffortStack summary={effort.total} height={12} />
                    <EffortCoverage
                      summary={effort.total}
                      indexing={effort.status.phase === "indexing"}
                    />
                  </div>
                  {effort.rows.map((row) => (
                    <div className="effort-provider-bar" key={row.key}>
                      <div>
                        <h3>{row.label}</h3>
                        <EffortBadge summary={row.summary} />
                      </div>
                      <EffortStack
                        summary={row.summary}
                        height={10}
                        showLegend={false}
                      />
                      <EffortCoverage summary={row.summary} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </EffortState>
          <p className="effort-help">{EFFORT_HELP}</p>
        </article>
        <article className="panel panel-wide recent-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">RECENT SIGNALS</span>
              <h2>Latest sessions</h2>
            </div>
            <span>{data.sessions.length} indexed</span>
          </div>
          <div className="recent-list">
            {recent.map((session, index) => {
              const modelName =
                session.modelsUsed.join(", ") || "Unknown model";
              const tooltipId = `recent-session-tag-tooltip-${index}`;
              return (
                <div className="recent-session" key={session.sessionId}>
                  <a
                    className="recent-session__details"
                    href={sessionHref(session.sessionId)}
                    aria-label={`Open session details for ${modelName}`}
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      onOpenSession(session.sessionId);
                    }}
                  >
                    <span className={`agent-mark ${session.agent}`}>
                      {session.agent.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="session-main">
                      <b>{modelName}</b>
                      <small>{session.cwd ?? session.period}</small>
                    </span>
                    <span className="path-tags">
                      {session.pathTags.slice(0, 2).map((tag) => (
                        <i key={tag}>{tag}</i>
                      ))}
                    </span>
                    <span className="session-effort">
                      <SessionEffortCell
                        decoded={effortBySession.get(session.sessionId)}
                        enabled={Boolean(effort?.status.enabled)}
                      />
                    </span>
                    <span className="session-metric">
                      <b>{formatCompact(session.totalTokens)}</b>
                      <small>{formatMoney(session.totalCost)}</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </a>
                  <button
                    type="button"
                    className="recent-session__tag"
                    onClick={() => onTagSession(session)}
                    aria-label={`Edit tags and notes for ${modelName}`}
                    aria-describedby={tooltipId}
                  >
                    <Tag aria-hidden="true" />
                    <span
                      className="recent-session__tag-tooltip"
                      id={tooltipId}
                      role="tooltip"
                    >
                      Add or edit tags and notes for this session
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </article>
      </section>
    </div>
  );
}

const effortBasisLabel = { tokens: "tokens", observations: "observations" } as const;
type EffortDayMode = "combo" | "effort";

/** Project and path tag are session-derived proxies for the user's task, so this block is
 * labelled "Session context": not every event in a multi-day transcript was directly attributed
 * to the project or tag shown here. */
type EffortDayContext = { title: string; items: Array<{ label: string; tokens: number }>; more: number };
type EffortDayContextSource =
  | { kind: "project"; activity: ProjectActivity[] }
  | { kind: "pathTag"; sessions: Session[] };

const CONTEXT_LIMIT = 3;

function buildSessionContextByDay(source: EffortDayContextSource, timeZone: string) {
  const byDay = new Map<string, Map<string, number>>();
  const add = (date: string, label: string, tokens: number) => {
    const totals = byDay.get(date) ?? new Map<string, number>();
    totals.set(label, (totals.get(label) ?? 0) + tokens);
    byDay.set(date, totals);
  };
  if (source.kind === "project") {
    for (const row of source.activity) add(row.date, friendlyProject(row.projectId), row.tokens);
  } else {
    for (const session of source.sessions) {
      const date = dateKeyInTimeZone(session.metadata?.lastActivity, timeZone) ?? session.period;
      // A session with no tag contributes no context rather than an invented "untagged" cohort.
      for (const tag of session.pathTags) add(date, tag, session.totalTokens);
    }
  }
  const title = source.kind === "project" ? "Top projects" : "Top path tags";
  return new Map(
    [...byDay.entries()].map(([date, totals]) => {
      const ranked = [...totals.entries()]
        .map(([label, tokens]) => ({ label, tokens }))
        .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
      return [date, { title, items: ranked.slice(0, CONTEXT_LIMIT), more: Math.max(0, ranked.length - CONTEXT_LIMIT) }] as const;
    }),
  );
}

/** One row of the drawn stack, in either mode. Keeping both modes on one shape is what lets the
 * tooltip, the `sr-only` summary, and the bars stay in lockstep with the active mode. */
type EffortDayViewPoint = {
  date: string;
  suppressed: boolean;
  total: number;
  values: Record<string, number>;
  tokenCoverage: number | null;
  /** Combo buckets recorded that day; drives reasoning share and the effort-only model subline. */
  buckets: EffortComboBucket[];
};

/** Daily stacked distribution of model family × provider-recorded effort. Effort alone is a
 * secondary mode: `High` is only comparable beside the model that recorded it. Tokens is the
 * primary basis; Observations is available because one Claude assistant response and one Codex
 * turn context are counted alike, and the two bases can disagree. */
function EffortByDay({
  scope,
  providerLabel,
  hasActivity,
  contextSource,
  timeZone,
  emptyText,
}: {
  scope: EffortScopeInput;
  providerLabel: string;
  /** Whether anything at all survived the surrounding filters, so an empty scope reads as a
   * filter result rather than as missing effort data. */
  hasActivity: boolean;
  contextSource: EffortDayContextSource;
  timeZone: string;
  emptyText: string;
}) {
  const [mode, setMode] = useState<EffortDayMode>("combo");
  const [basis, setBasis] = useState<"tokens" | "observations">("tokens");
  // Combo days are fetched in both modes: effort-only rows still name the model families that
  // recorded them, and that subline has to come from combo buckets rather than raw model context.
  const comboRequest = useEffortComboDays(scope);
  const aggregateRequest = useEffortAggregate("day", scope, mode === "effort");
  const statusRequest = useEffortStatus();
  const combos = comboRequest.data;
  const aggregate = aggregateRequest.data;
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [comboRequest.load, aggregateRequest.load]);

  const comboSeries = useMemo(() => buildComboDaySeries(combos?.rows ?? [], basis), [combos, basis]);
  const effortSeries = useMemo(() => buildEffortDaySeries(aggregate?.rows ?? [], basis), [aggregate, basis]);
  const bucketsByDay = useMemo(
    () => new Map((combos?.rows ?? []).map((row) => [row.key, row.buckets])),
    [combos],
  );

  const isCombo = mode === "combo";
  const keys = isCombo ? comboSeries.keys : effortSeries.keys;
  const suppressedDays = isCombo ? comboSeries.suppressedDays : effortSeries.suppressedDays;
  const points = useMemo<EffortDayViewPoint[]>(
    () => isCombo
      ? comboSeries.points.map((point) => ({
          date: point.date,
          suppressed: point.suppressed,
          total: point.total,
          values: point.values,
          tokenCoverage: point.row.coverage.tokenCoverage,
          buckets: point.row.buckets,
        }))
      : effortSeries.points.map((point) => ({
          date: point.date,
          suppressed: point.suppressed,
          total: point.total,
          values: point.values,
          tokenCoverage: point.summary.tokenCoverage,
          buckets: bucketsByDay.get(point.date) ?? [],
        })),
    [isCombo, comboSeries, effortSeries, bucketsByDay],
  );

  const status = isCombo ? combos?.status ?? null : aggregate?.status ?? null;
  const coverage = isCombo ? combos?.total ?? null : aggregate?.total ?? null;
  const coverageState = isCombo ? combos?.coverageState : aggregate?.total.coverageState;
  const seriesLabel = (key: string) => (isCombo ? comboSeriesLabel(key) : effortLabel(key));
  const seriesColor = (key: string) => (isCombo ? comboSeriesColor(key) : effortColor(key));

  const chartData = points.map((point) => ({ date: point.date, ...point.values, __point: point }));
  const drawable = points.some((point) => point.total > 0);
  const contextByDay = useMemo(
    () => buildSessionContextByDay(contextSource, timeZone),
    [contextSource, timeZone],
  );
  const showFilterEmpty =
    !hasActivity &&
    Boolean(status?.enabled) &&
    status?.phase !== "indexing" &&
    status?.phase !== "error";

  return (
    <section className="panel effort-day-panel">
      <div className="panel-heading">
        <div>
          <span className="overline">REASONING SIGNAL</span>
          <h2>Model × effort by day</h2>
        </div>
        <div className="effort-day-controls">
          <Segmented
            label="Breakdown"
            value={mode}
            onChange={(value) => setMode(value as EffortDayMode)}
            options={[
              { value: "combo", label: "Model × effort" },
              { value: "effort", label: "Effort only" },
            ]}
          />
          <Segmented
            label="Basis"
            value={basis}
            onChange={(value) => setBasis(value as "tokens" | "observations")}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "observations", label: "Observations" },
            ]}
          />
        </div>
      </div>
      {showFilterEmpty ? (
        <Empty text={emptyText} />
      ) : (
        <EffortState status={status} summary={coverageState ? { coverageState } : null}>
        {drawable ? (
          <>
            <div className="bar-chart effort-day-chart" style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ left: 10, right: 16 }}>
                  <CartesianGrid stroke="#26312e" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#a8b5b0", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value: string) => periodTickLabel(value)}
                  />
                  <YAxis
                    tick={{ fill: "#a8b5b0", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value: number) => formatCompact(value)}
                  />
                  <Tooltip
                    content={
                      <EffortDayTooltip
                        mode={mode}
                        basis={basis}
                        keys={keys}
                        providerLabel={providerLabel}
                        contextByDay={contextByDay}
                      />
                    }
                    cursor={{ fill: "#15211d" }}
                    isAnimationActive={false}
                    wrapperStyle={chartTooltipWrapperStyle}
                  />
                  {keys.map((key) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="effort"
                      name={seriesLabel(key)}
                      fill={seriesColor(key)}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="sr-only">
              {`${isCombo ? "Model and effort" : "Effort"} by ${effortBasisLabel[basis]} per day for ${providerLabel}. `}
              {points
                .map((point) =>
                  point.suppressed
                    ? `${point.date}: no stack drawn, derived totals exceeded the day total`
                    : point.total > 0
                      ? `${point.date}: ` +
                        keys
                          .filter((key) => point.values[key] > 0)
                          .map((key) => `${seriesLabel(key)} ${sharePercent(point.values[key], point.total)}`)
                          .join(", ")
                      : null,
                )
                .filter(Boolean)
                .join("; ")}
            </p>
            {coverage && (
              <EffortCoverage
                summary={coverage}
                indexing={status?.phase === "indexing"}
              />
            )}
            {suppressedDays > 0 && (
              <p className="effort-coverage">
                {suppressedDays} day{suppressedDays === 1 ? "" : "s"} drew no stack because derived
                {isCombo ? " combo" : ""} tokens exceeded the authoritative day total.
              </p>
            )}
          </>
        ) : (
          <Empty text={emptyText} />
        )}
        </EffortState>
      )}
    </section>
  );
}

/** `Mostly Sol, Opus 5, Luna (+2)` for the effort-only mode, derived from the same combo buckets
 * the other mode draws — never from a separate raw-model context that could disagree. */
function familySubline(buckets: EffortComboBucket[], basis: "tokens" | "observations") {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    if (!bucket.effort) continue;
    const amount = basis === "tokens" ? bucket.tokens : bucket.observations;
    if (amount <= 0) continue;
    totals.set(bucket.family, (totals.get(bucket.family) ?? 0) + amount);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return null;
  const shown = ranked.slice(0, 3).map(([family]) => familyLabel(family));
  const more = ranked.length - shown.length;
  return `Mostly ${shown.join(", ")}${more > 0 ? ` (+${more})` : ""}`;
}

function EffortDayTooltip({
  active,
  payload,
  label,
  coordinate,
  mode,
  basis,
  keys,
  providerLabel,
  contextByDay,
}: {
  active?: boolean;
  payload?: Array<{ payload: { __point: EffortDayViewPoint } }>;
  label?: string;
  coordinate?: { x?: number };
  mode: EffortDayMode;
  basis: "tokens" | "observations";
  keys: string[];
  providerLabel: string;
  contextByDay: Map<string, EffortDayContext>;
}) {
  const pinSource = useId();
  const livePoint = payload?.[0]?.payload.__point;
  // Mode and basis are part of the claim: a held or pinned snapshot must not keep showing rows
  // from the breakdown the user just switched away from.
  const claimKey = active && livePoint ? `${livePoint.date}:${mode}:${basis}` : null;
  const hold = useChartTooltipHold(
    active && livePoint ? { point: livePoint, label, coordinate } : null,
    claimKey,
  );
  const tooltipRef = useClampedTooltip(
    Boolean(hold.snapshot),
    hold.snapshot?.coordinate,
  );
  if (!hold.snapshot) return null;
  const { point } = hold.snapshot;
  const isCombo = mode === "combo";
  const dateLabel = chartTooltipDateLabel(point.date);
  const entries = keys.filter((key) => (point.values[key] ?? 0) > 0);
  const context = contextByDay.get(point.date);
  const subline = isCombo ? null : familySubline(point.buckets, basis);
  const reasoningByKey = new Map(
    point.buckets.filter((bucket) => bucket.effort).map((bucket) => [comboKey(bucket), bucket.reasoningShare]),
  );
  const coverage =
    point.tokenCoverage === null
      ? "coverage unavailable"
      : `${Math.round(point.tokenCoverage * 100)}% of tokens attributed`;
  const description = isCombo
    ? "Model family and provider-recorded effort for this day, with session context below when available."
    : "Provider-recorded effort for this day, aggregated across models, with session context below when available.";
  return (
    <PinnableChartTooltip
      id={`${pinSource}:${point.date}:${mode}:${basis}`}
      ariaLabel={`${isCombo ? "model and effort" : "effort"} details for ${dateLabel}`}
      contextLabel={isCombo ? "Model × effort" : "Reasoning effort"}
      contextDescription={description}
      contextPlacement="inline"
      className="provider-tooltip effort-day-tooltip"
      forwardedRef={tooltipRef}
      interactionRef={hold.cardRef}
      retained={hold.retained}
      cardInteractionProps={hold.cardInteractionProps}
      pinInteractionProps={hold.pinInteractionProps}
    >
      <div className="tooltip-effort-head">
        <span className="tooltip-date-label">{dateLabel}</span>
        <ChartTooltipContext
          label={isCombo ? "Model × effort" : "Reasoning effort"}
          description={description}
          className="chart-tooltip__context--inline"
        />
        <small>
          {providerLabel} · {coverage}
        </small>
      </div>
      {entries.map((key) => {
        const amount = point.values[key];
        const combo = isCombo ? parseComboKey(key) : null;
        const reasoning = combo ? reasoningByKey.get(key) ?? null : null;
        return (
          <div key={key} className={combo ? "tooltip-combo-row" : "tooltip-effort-row"}>
            {combo ? (
              <ComboPill combo={combo} />
            ) : (
              <>
                <i style={{ background: isCombo ? comboSeriesColor(key) : effortColor(key) }} aria-hidden="true" />
                <span>{isCombo ? comboSeriesLabel(key) : effortLabel(key)}</span>
              </>
            )}
            <b>
              {formatCompact(amount)} {effortBasisLabel[basis]}
            </b>
            <em>{sharePercent(amount, point.total)}</em>
            {reasoning !== null && <small>{Math.round(reasoning * 100)}% reasoning</small>}
          </div>
        );
      })}
      {subline && <p className="tooltip-effort-subline">{subline}</p>}
      {context && context.items.length > 0 && (
        <div className="tooltip-day-context">
          <span className="overline">Session context · {context.title}</span>
          {context.items.map((item) => (
            <div className="tooltip-day-model" key={item.label}>
              <span>{item.label}</span>
              <b>{formatCompact(item.tokens)}</b>
            </div>
          ))}
          {context.more > 0 && <small>{context.more} more</small>}
        </div>
      )}
    </PinnableChartTooltip>
  );
}

function Explorer({
  data,
  rows,
  sessions,
  agent,
  pathTag,
  metricRange,
  customRange,
  dateRange,
  metric,
  setMetric,
}: {
  data: DashboardData;
  rows: MetricRow[];
  sessions: Session[];
  agent: AgentSelection;
  pathTag: string;
  metricRange: MetricRange;
  customRange: DateRange | null;
  dateRange: DateRange | null;
  metric: Metric;
  setMetric: (metric: Metric) => void;
}) {
  const modelEffortRequest = useEffortAggregate(
    "model",
    globalEffortScope(agent, dateRange, pathTag),
  );
  const modelEffortStatus = useEffortStatus();
  useEffortRefreshOnIndexChange(modelEffortStatus.data?.indexVersion, [
    modelEffortRequest.load,
  ]);
  const modelEffortByName = useMemo(
    () =>
      new Map(
        (modelEffortRequest.data?.rows ?? []).map((row) => [
          row.key,
          row.summary,
        ]),
      ),
    [modelEffortRequest.data],
  );
  const modelData = modelDistribution(rows, metric).map((row) => {
    const effort = modelEffortByName.get(row.rawName) ?? null;
    return {
      ...row,
      effort,
      color: modelSignalColor(row.color, effort?.dominant ?? null),
    };
  });
  const projectActivity = useMemo(() => {
    if (pathTag === "all") return data.projectActivity;
    const projectIds = new Set(
      sessions
        .map((session) => session.cwd?.replace(/\/+$/, ""))
        .filter(Boolean),
    );
    return data.projectActivity.filter((activity) =>
      projectIds.has(activity.projectId),
    );
  }, [data.projectActivity, pathTag, sessions]);
  const rangeLabel =
    metricRange === "all"
      ? "ALL-TIME FIELD"
      : metricRange === "custom"
        ? dateRangeLabel(customRange).toUpperCase()
      : metricRange === "1"
        ? "LATEST DAY"
        : `${metricRange}-DAY FIELD`;
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="ANALYTICAL WORKSPACE"
        title="Usage explorer"
        description="Brush the timeline to focus a period. Global agent and path filters stay linked across the workspace."
      />
      <section className="panel explorer-main usage-trajectory-panel">
        <div className="panel-heading">
          <div>
            <span className="overline">{rangeLabel}</span>
            <h2>Activity by provider</h2>
            {metricRange === "1" && (
              <p>Sessions grouped by their last recorded activity hour.</p>
            )}
          </div>
          <span className="method-chip">
            <i /> ccusage derived
          </span>
        </div>
        {metricRange === "1" && rows.length === 1 ? (
          <HourlyProviderTimeline
            date={rows[0].period}
            sessions={sessions}
            quotaHistory={data.quotas.history}
            timeZone={data.timeZone}
            activeProvider={selectionProvider(agent)}
            emptyText={filterEmptyMessage(agent, metricRange, pathTag, customRange)}
          />
        ) : (
          <ProviderTimeline
            rows={rows}
            projectActivity={projectActivity}
            activeProvider={selectionProvider(agent)}
            quotaHistory={data.quotas.history}
            timeZone={data.timeZone}
            emptyText={filterEmptyMessage(agent, metricRange, pathTag, customRange)}
          />
        )}
      </section>
      <EffortByDay
        scope={globalEffortScope(agent, dateRange, pathTag)}
        hasActivity={rows.length > 0}
        contextSource={{ kind: "project", activity: projectActivity }}
        timeZone={data.timeZone}
        emptyText={filterEmptyMessage(agent, metricRange, pathTag, customRange)}
        providerLabel={
          selectionProvider(agent) === "anthropic"
            ? "Claude Code"
            : selectionProvider(agent) === "codex"
              ? "Codex"
              : "All providers"
        }
      />
      <section className="split-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <span className="overline">MODEL DISTRIBUTION</span>
              <h2>Model signals</h2>
            </div>
            <Segmented
              value={metric}
              onChange={(v) => setMetric(v as Metric)}
              options={[
                { value: "totalTokens", label: "Tokens" },
                { value: "totalCost", label: "Cost" },
                { value: "outputTokens", label: "Output" },
              ]}
            />
          </div>
          {modelData.length === 0 ? (
            <Empty text={filterEmptyMessage(agent, metricRange, pathTag, customRange)} />
          ) : (
            <div
              className="bar-chart"
              style={{ height: Math.max(290, modelData.length * 34 + 28) }}
            >
              <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={modelData}
                layout="vertical"
                margin={{ left: 10, right: 16 }}
              >
                <CartesianGrid stroke="#26312e" horizontal={false} />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={100}
                  tick={{ fill: "#a8b5b0", fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  content={<ModelSignalTooltip metric={metric} />}
                  cursor={{ fill: "#15211d" }}
                  isAnimationActive={false}
                  wrapperStyle={chartTooltipWrapperStyle}
                />
                <Bar
                  dataKey="value"
                  name="Usage"
                  radius={[0, 6, 6, 0]}
                >
                  {modelData.map((entry) => (
                    <Cell
                      key={`${entry.provider ?? "unknown"}-${entry.name}`}
                      fill={entry.color}
                    />
                  ))}
                </Bar>
              </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </article>
        <article className="panel">
          <div className="panel-heading">
            <div>
              <span className="overline">INPUT / OUTPUT / CACHE</span>
              <h2>Token composition</h2>
            </div>
          </div>
          <Composition rows={rows} />
        </article>
      </section>
    </div>
  );
}

function Composition({ rows }: { rows: MetricRow[] }) {
  const totals = rows.reduce(
    (sum, row) => ({
      input: sum.input + row.inputTokens,
      output: sum.output + row.outputTokens,
      read: sum.read + row.cacheReadTokens,
      create: sum.create + row.cacheCreationTokens,
    }),
    { input: 0, output: 0, read: 0, create: 0 },
  );
  const all = totals.input + totals.output + totals.read + totals.create || 1;
  const groups = [
    {
      label: "Input + output",
      hint: "Direct tokens",
      value: totals.input + totals.output,
      items: [
        { label: "Input", value: totals.input, color: palette[1] },
        { label: "Output", value: totals.output, color: palette[3] },
      ],
    },
    {
      label: "Cache read + write",
      hint: "Cache traffic",
      value: totals.read + totals.create,
      items: [
        { label: "Cache read", value: totals.read, color: palette[0] },
        { label: "Cache write", value: totals.create, color: palette[2] },
      ],
    },
  ];
  const items = groups.flatMap((group) => group.items);
  return (
    <div className="composition">
      <div
        className="composition-bar"
        role="img"
        aria-label={`Token composition: ${formatCompact(totals.input)} input, ${formatCompact(totals.output)} output, ${formatCompact(totals.read)} cache read, and ${formatCompact(totals.create)} cache write`}
      >
        {items.map((item) => (
          <i
            key={item.label}
            style={{
              width: `${(item.value / all) * 100}%`,
              background: item.color,
            }}
          />
        ))}
      </div>
      <div className="composition-groups">
        {groups.map((group) => (
          <section className="composition-group" key={group.label}>
            <header>
              <div>
                <span>{group.hint}</span>
                <b>{group.label}</b>
              </div>
              <div className="composition-subtotal">
                <strong>{formatCompact(group.value)}</strong>
                <small>{Math.round((group.value / all) * 100)}% of total</small>
              </div>
            </header>
            {group.items.map((item) => (
              <div className="composition-row" key={item.label}>
                <i style={{ background: item.color }} />
                <span>{item.label}</span>
                <b>{formatCompact(item.value)}</b>
                <small>{Math.round((item.value / all) * 100)}%</small>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

type SessionDetailColumnKey =
  | "prompt"
  | "output"
  | "files"
  | "tools"
  | "models"
  | "effort";

const initiallyCollapsedSessionColumns: SessionDetailColumnKey[] = [
  "tools",
  "models",
  "effort",
];

export function sessionModelNames(session: Session) {
  return [
    ...new Set([
      ...session.modelsUsed,
      ...session.modelBreakdowns.map((model) => model.modelName),
    ]),
  ].filter(Boolean);
}

type SessionDetailSpineStat = {
  value: string;
  label?: string;
  tone?: "accent" | "positive" | "negative" | "warning";
};

type SessionExternalOpenAction = "reveal" | "vscode" | "default-editor";
type SessionExternalTarget =
  | { target: "transcript" }
  | { target: "file"; path: string };
type CompactActionMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void | Promise<void>;
};

function CompactActionMenu({
  label,
  title,
  note,
  items,
  className = "",
}: {
  label: string;
  title: string;
  note: string;
  items: CompactActionMenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 224;
    const height = menuRef.current?.offsetHeight ?? 154;
    const below = rect.bottom + 6;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
      top:
        below + height <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - height - 6),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(placeMenu);
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, placeMenu]);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      placeMenu();
      menuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, placeMenu]);

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
      return;
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowUp"
            ? (current - 1 + buttons.length) % buttons.length
            : (current + 1) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <span className={`compact-action-menu ${className}`} data-open={open}>
      <button
        ref={triggerRef}
        type="button"
        className="compact-action-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="compact-action-popover"
            role="menu"
            aria-label={label}
            style={position}
            onKeyDown={moveMenuFocus}
          >
            <div className="compact-action-popover__head">
              <b>{title}</b>
              <small>{note}</small>
            </div>
            {items.map((item) => (
              <button
                type="button"
                role="menuitem"
                key={item.id}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                  void item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

function SessionDetailSpineSummary({
  stats,
}: {
  stats: SessionDetailSpineStat[];
}) {
  return (
    <span className="session-detail__rail-summary" aria-hidden="true">
      {stats.map((stat, index) => (
        <span
          className={stat.tone ? `is-${stat.tone}` : undefined}
          key={`${stat.value}-${stat.label ?? index}`}
        >
          <b>{stat.value}</b>
          {stat.label && <i>{stat.label}</i>}
        </span>
      ))}
    </span>
  );
}

function SessionDetailColumn({
  column,
  label,
  aside,
  collapsedMeta,
  collapsedStats,
  collapsed,
  wide = false,
  className = "",
  title,
  onToggle,
  children,
}: {
  column: SessionDetailColumnKey;
  label: string;
  aside?: ReactNode;
  collapsedMeta?: string;
  collapsedStats?: SessionDetailSpineStat[];
  collapsed: boolean;
  wide?: boolean;
  className?: string;
  title?: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`session-detail__section ${wide ? "session-detail__section--wide" : ""} ${collapsed ? "session-detail__section--collapsed" : ""} ${className}`}
      data-detail-column={column}
      data-state={collapsed ? "collapsed" : "expanded"}
    >
      {collapsed ? (
        <button
          type="button"
          className="session-detail__rail"
          onClick={onToggle}
          aria-expanded="false"
          aria-label={`Expand ${label}${collapsedMeta ? `, ${collapsedMeta}` : ""}`}
          title={`Expand ${label}`}
        >
          <ChevronRight aria-hidden="true" />
          <span className="session-detail__rail-label">{label}</span>
          {collapsedStats?.length ? (
            <SessionDetailSpineSummary stats={collapsedStats} />
          ) : (
            collapsedMeta && <small>{collapsedMeta}</small>
          )}
        </button>
      ) : (
        <>
          <div className="session-detail__head">
            <button
              type="button"
              className="session-detail__column-toggle"
              onClick={onToggle}
              aria-expanded="true"
              aria-label={`Collapse ${label}`}
              title={title ?? `Collapse ${label}`}
            >
              <ChevronLeft aria-hidden="true" />
              <span className="overline">{label}</span>
            </button>
            {aside && <div className="session-detail__head-aside">{aside}</div>}
          </div>
          <div className="session-detail__body">{children}</div>
        </>
      )}
    </section>
  );
}

function warpMetricLabel(value: string) {
  return value
    .replace(/_stats$/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function WarpSessionDetailPanel({
  session,
  annotation,
  onAnnotationChange,
}: {
  session: Session;
  annotation?: SessionAnnotation;
  onAnnotationChange?: (sessionId: string, annotation: SessionAnnotation) => void;
}) {
  const stats = session.warp!;
  const toolEntries = Object.entries(stats.toolUsage).sort((left, right) => right[1] - left[1]);
  const categoryEntries = Object.entries(stats.tokensByCategory).sort((left, right) => right[1] - left[1]);
  return (
    <div className="session-detail warp-session-detail">
      <div className="session-detail__summary">
        <div className="session-detail__verdict">
          <span>YOUR VERDICT</span>
          <strong>
            <SessionVerdictControl
              sessionId={session.sessionId}
              verdict={(annotation ?? session.annotation).verdict}
              onChange={onAnnotationChange ?? (() => {})}
            />
          </strong>
        </div>
        <div><span>WARP CREDITS</span><strong>{formatWarpCredits(stats.credits)}</strong></div>
        <div><span>LAST TURN</span><strong>{stats.lastTurnCredits === null ? "—" : formatWarpCredits(stats.lastTurnCredits)}</strong></div>
        <div><span>CONTEXT WINDOW</span><strong>{stats.contextWindowUsage === null ? "—" : `${Math.round(stats.contextWindowUsage * 100)}%`}</strong></div>
        <div><span>AGENT TURNS</span><strong>{stats.turns}</strong></div>
        <div><span>STATUS</span><strong>{stats.status}</strong></div>
      </div>
      <div className="warp-session-detail__grid">
        <section className="warp-session-detail__card">
          <span className="overline">TOKEN SOURCES</span>
          <h4>Recorded tokens</h4>
          <dl>
            <div><dt>Total</dt><dd>{formatCompact(stats.tokensBySource.total)}</dd></div>
            <div><dt>Warp-managed</dt><dd>{formatCompact(stats.tokensBySource.warp)}</dd></div>
            <div><dt>BYOK</dt><dd>{formatCompact(stats.tokensBySource.byok)}</dd></div>
            <div><dt>Custom endpoint</dt><dd>{formatCompact(stats.tokensBySource.customEndpoint)}</dd></div>
          </dl>
        </section>
        <section className="warp-session-detail__card">
          <span className="overline">TOOL USE</span>
          <h4>Observed categories</h4>
          {toolEntries.length ? (
            <ul className="tool-list">
              {toolEntries.map(([name, count]) => <li key={name}><code>{warpMetricLabel(name)}</code><b>×{count}</b></li>)}
            </ul>
          ) : <p>No tool metadata was recorded.</p>}
        </section>
        <section className="warp-session-detail__card">
          <span className="overline">WORK SHAPE</span>
          <h4>Files, commands, and context</h4>
          <dl>
            <div><dt>Files changed</dt><dd>{stats.filesChanged}</dd></div>
            <div><dt>Line diff</dt><dd><i>+{stats.linesAdded}</i> <em>−{stats.linesRemoved}</em></dd></div>
            <div><dt>Commands executed</dt><dd>{stats.commandsExecuted}</dd></div>
            <div><dt>Failed commands</dt><dd>{stats.failedCommands}</dd></div>
            <div><dt>Compaction observed</dt><dd>{stats.wasSummarized ? "Yes" : "No"}</dd></div>
          </dl>
        </section>
        <section className="warp-session-detail__card">
          <span className="overline">TOKEN CATEGORIES</span>
          <h4>Where the recorded tokens went</h4>
          {categoryEntries.length ? (
            <ul className="model-list">
              {categoryEntries.map(([name, value]) => <li key={name}><span>{warpMetricLabel(name)}</span><b>{formatCompact(value)}</b></li>)}
            </ul>
          ) : <p>No category breakdown was recorded.</p>}
        </section>
      </div>
      <p className="scope-note"><Database /> Warp rows are metadata-only snapshots from this computer. Prompts, responses, command text, and transcript contents are not imported.</p>
    </div>
  );
}

export function SessionDetailPanel({
  session,
  detail,
  loading,
  effortStatus,
  annotation,
  onAnnotationChange,
}: {
  session: Session;
  detail?: SessionDetail;
  loading: boolean;
  effortStatus: EffortIndexStatus | null;
  annotation?: SessionAnnotation;
  onAnnotationChange?: (sessionId: string, annotation: SessionAnnotation) => void;
}) {
  const [promptOrder, setPromptOrder] = useState<"newest" | "oldest">(
    "oldest",
  );
  const [collapsedColumns, setCollapsedColumns] = useState(
    () => new Set<SessionDetailColumnKey>(initiallyCollapsedSessionColumns),
  );
  const [externalStatus, setExternalStatus] = useState<{
    kind: "pending" | "success" | "error";
    message: string;
  } | null>(null);
  const externalStatusTimer = useRef<number | null>(null);
  const showExternalStatus = useCallback(
    (
      kind: "pending" | "success" | "error",
      message: string,
      duration = kind === "error" ? 5_000 : 2_600,
    ) => {
      if (externalStatusTimer.current !== null)
        window.clearTimeout(externalStatusTimer.current);
      setExternalStatus({ kind, message });
      externalStatusTimer.current =
        kind === "pending"
          ? null
          : window.setTimeout(() => setExternalStatus(null), duration);
    },
    [],
  );
  useEffect(
    () => () => {
      if (externalStatusTimer.current !== null)
        window.clearTimeout(externalStatusTimer.current);
    },
    [],
  );
  const openExternalTarget = useCallback(
    async (
      action: SessionExternalOpenAction,
      target: SessionExternalTarget,
      label: string,
    ) => {
      const actionLabel =
        action === "reveal"
          ? "Opening Finder"
          : action === "vscode"
            ? "Opening Visual Studio Code"
            : "Opening the default text editor";
      showExternalStatus("pending", `${actionLabel} for ${label}…`);
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(session.sessionId)}/external-open`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...target }),
          },
        );
        const result = (await response.json().catch(() => null)) as {
          error?: unknown;
          message?: unknown;
        } | null;
        if (!response.ok)
          throw new Error(
            typeof result?.error === "string"
              ? result.error
              : "The local application could not open that path.",
          );
        showExternalStatus(
          "success",
          typeof result?.message === "string"
            ? result.message
            : `${label} opened.`,
        );
      } catch (error) {
        showExternalStatus(
          "error",
          error instanceof Error
            ? error.message
            : "The local application could not open that path.",
        );
      }
    },
    [session.sessionId, showExternalStatus],
  );
  const toggleColumn = (column: SessionDetailColumnKey) => {
    setCollapsedColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };
  if (session.source === "warp" && session.warp) {
    return <WarpSessionDetailPanel session={session} annotation={annotation} onAnnotationChange={onAnnotationChange} />;
  }
  if (loading)
    return (
      <div className="session-detail session-detail--loading">
        Reading the local session record…
      </div>
    );
  if (!detail?.available)
    return (
      <div className="session-detail session-detail--empty">
        The indexed record is no longer available locally.
      </div>
    );
  const models = session.modelBreakdowns.length
    ? session.modelBreakdowns.map((model) => ({
        modelName: model.modelName,
        tokens:
          model.inputTokens +
          model.outputTokens +
          model.cacheReadTokens +
          model.cacheCreationTokens,
      }))
    : session.modelsUsed.map((modelName) => ({ modelName, tokens: null }));
  const prompts =
    promptOrder === "newest" ? [...detail.prompts].reverse() : detail.prompts;
  const outputs = detail.outputs ?? [];
  const clippedOutputs = outputs.filter((output) => output.truncated).length;
  const toolCalls = detail.tools.reduce((total, tool) => total + tool.count, 0);
  const mixedModels = models.length > 1;
  const externalItems = (
    target: SessionExternalTarget,
    label: string,
    deleted = false,
  ): CompactActionMenuItem[] => [
    {
      id: "reveal",
      label: deleted ? "Reveal containing folder" : "Reveal in Finder",
      icon: <FolderOpen aria-hidden="true" />,
      onSelect: () => openExternalTarget("reveal", target, label),
    },
    {
      id: "vscode",
      label: "Open in VS Code",
      icon: <ExternalLink aria-hidden="true" />,
      disabled: deleted,
      hint: deleted ? "This session deleted the file." : undefined,
      onSelect: () => openExternalTarget("vscode", target, label),
    },
    {
      id: "default-editor",
      label: "Open in default text editor",
      icon: <FileText aria-hidden="true" />,
      disabled: deleted,
      hint: deleted ? "This session deleted the file." : undefined,
      onSelect: () => openExternalTarget("default-editor", target, label),
    },
  ];
  return (
    <div className="session-detail">
      <div className="session-detail__summary">
        <div className="session-detail__verdict">
          <span>YOUR VERDICT</span>
          <strong>
            <SessionVerdictControl
              sessionId={session.sessionId}
              verdict={(annotation ?? session.annotation).verdict}
              onChange={onAnnotationChange ?? (() => {})}
            />
          </strong>
        </div>
        <div>
          <span>TRANSCRIPT EVENTS</span>
          <strong>{detail.eventsRead}</strong>
        </div>
        <div>
          <span>TOOL CALLS</span>
          <strong>{toolCalls}</strong>
        </div>
        <div>
          <span>FILES TOUCHED</span>
          <strong>{detail.files.length}</strong>
        </div>
        <div className="diff-count">
          <span>PATCH SUMMARY</span>
          <strong>
            <i>+{detail.additions}</i>
            <em>−{detail.deletions}</em>
          </strong>
        </div>
      </div>
      <div className="session-detail__columns">
        <SessionDetailColumn
          column="prompt"
          label="Prompt"
          collapsed={collapsedColumns.has("prompt")}
          collapsedMeta={`${detail.prompts.length} prompt${detail.prompts.length === 1 ? "" : "s"}`}
          collapsedStats={[
            {
              value: formatCompact(detail.prompts.length),
              label: "prompts",
            },
          ]}
          wide
          className="session-prompts"
          onToggle={() => toggleColumn("prompt")}
          aside={
            <div className="session-detail__head-actions">
              {detail.prompts.length ? (
                <button
                  type="button"
                  className="prompt-order"
                  onClick={() =>
                    setPromptOrder((current) =>
                      current === "newest" ? "oldest" : "newest",
                    )
                  }
                  aria-label={`Show prompts ${promptOrder === "newest" ? "oldest" : "newest"} first`}
                >
                  {promptOrder === "newest" ? "Newest first ↓" : "Oldest first ↑"}
                </button>
              ) : (
                <small>No prompt events detected</small>
              )}
              <CompactActionMenu
                label="Open Prompt source actions"
                title="Prompt source"
                note="Shared session JSONL"
                items={externalItems(
                  { target: "transcript" },
                  "the session transcript",
                )}
              />
            </div>
          }
        >
          {detail.prompts.length ? (
            <ol className="session-transcript-list">
              {prompts.map((prompt, index) => (
                <li key={`${index}-${prompt.text.slice(0, 24)}`}>
                  <time
                    className="session-prompt-time"
                    dateTime={prompt.timestamp ?? undefined}
                    title={prompt.timestamp ?? undefined}
                  >
                    {formatPromptTimestamp(prompt.timestamp)}
                  </time>
                  <pre>{prompt.text}</pre>
                </li>
              ))}
            </ol>
          ) : (
            <p>Prompt text was not available in this session format.</p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="output"
          label="Output"
          collapsed={collapsedColumns.has("output")}
          collapsedMeta={`${outputs.length} sample${outputs.length === 1 ? "" : "s"}`}
          collapsedStats={[
            { value: formatCompact(outputs.length), label: "samples" },
            ...(clippedOutputs
              ? [
                  {
                    value: formatCompact(clippedOutputs),
                    label: "clipped",
                    tone: "warning" as const,
                  },
                ]
              : []),
          ]}
          wide
          className="session-outputs"
          onToggle={() => toggleColumn("output")}
          aside={
            <div className="session-detail__head-actions">
              <small>
                {outputs.length
                  ? `${outputs.length} recent sample${outputs.length === 1 ? "" : "s"}${outputs.some((output) => output.truncated) ? " · clipped" : ""}`
                  : "No assistant text detected"}
              </small>
              <CompactActionMenu
                label="Open Output source actions"
                title="Output source"
                note="Shared session JSONL"
                items={externalItems(
                  { target: "transcript" },
                  "the session transcript",
                )}
              />
            </div>
          }
        >
          {outputs.length ? (
            <ol className="session-transcript-list">
              {outputs.map((output, index) => (
                <li key={`${index}-${output.text.slice(0, 24)}`}>
                  <time
                    className="session-prompt-time"
                    dateTime={output.timestamp ?? undefined}
                    title={output.timestamp ?? undefined}
                  >
                    {formatPromptTimestamp(output.timestamp)}
                  </time>
                  <pre>{output.text}</pre>
                  {output.truncated && (
                    <small className="session-output-clipped">
                      Sample clipped after 4,000 characters
                    </small>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>Assistant-visible output text was not available in this session format.</p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="files"
          label="Files & Patches"
          collapsed={collapsedColumns.has("files")}
          collapsedMeta={`${detail.files.length} file${detail.files.length === 1 ? "" : "s"}, ${detail.additions} additions, ${detail.deletions} deletions`}
          collapsedStats={[
            { value: formatCompact(detail.files.length), label: "files" },
            { value: `+${formatCompact(detail.additions)}`, tone: "positive" },
            { value: `−${formatCompact(detail.deletions)}`, tone: "negative" },
          ]}
          onToggle={() => toggleColumn("files")}
          aside={
            <small>
              {detail.files.length
                ? `${detail.files.length} files · +${detail.additions} −${detail.deletions}`
                : "No patch payload found"}
            </small>
          }
        >
          {detail.files.length ? (
            <ul className="file-list">
              {detail.files.map((file) => (
                <li key={file.path}>
                  <span className={`file-status ${file.status}`}>
                    {file.status[0]}
                  </span>
                  <code className="file-path-tail" title={file.path}>
                    <span dir="ltr">{file.path}</span>
                  </code>
                  <span
                    className={`file-diff ${file.additions === null || file.deletions === null ? "is-unavailable" : ""}`}
                    aria-label={
                      file.additions === null || file.deletions === null
                        ? "Line counts unavailable for this file"
                        : `${file.additions} ${file.additions === 1 ? "addition" : "additions"} and ${file.deletions} ${file.deletions === 1 ? "deletion" : "deletions"}`
                    }
                    title={
                      file.additions === null || file.deletions === null
                        ? "Line counts unavailable for this transcript record"
                        : undefined
                    }
                  >
                    <i>+{file.additions?.toLocaleString() ?? "—"}</i>
                    <em>−{file.deletions?.toLocaleString() ?? "—"}</em>
                  </span>
                  <CompactActionMenu
                    className="file-action-menu"
                    label={`Open actions for ${file.path}`}
                    title={file.path.split(/[\\/]/).at(-1) ?? file.path}
                    note={file.status === "deleted" ? "Deleted path" : "Local file"}
                    items={externalItems(
                      { target: "file", path: file.path },
                      file.path.split(/[\\/]/).at(-1) ?? "the file",
                      file.status === "deleted",
                    )}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p>File changes are detected from structured patch calls only.</p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="tools"
          label="Tools"
          collapsed={collapsedColumns.has("tools")}
          collapsedMeta={`${toolCalls} call${toolCalls === 1 ? "" : "s"} across ${detail.tools.length} tool type${detail.tools.length === 1 ? "" : "s"}`}
          collapsedStats={[
            { value: formatCompact(toolCalls), label: "calls" },
            { value: formatCompact(detail.tools.length), label: "types" },
          ]}
          onToggle={() => toggleColumn("tools")}
          aside={
            <small>
              {detail.tools.length
                ? "Observed calls"
                : "No tool calls detected"}
            </small>
          }
        >
          {detail.tools.length ? (
            <ul className="tool-list">
              {detail.tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  <b>×{tool.count}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p>No structured tool calls were found.</p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="models"
          label="Model Mix"
          collapsed={collapsedColumns.has("models")}
          collapsedMeta={mixedModels ? `Mixed, ${models.length} models` : `${models.length} model`}
          collapsedStats={[
            { value: formatCompact(models.length), label: "models" },
            ...(mixedModels
              ? [{ value: "mixed", tone: "accent" as const }]
              : []),
          ]}
          onToggle={() => toggleColumn("models")}
          aside={
            <small>
              {mixedModels ? `Mixed · ${models.length} models` : `${models.length} model`}
            </small>
          }
        >
          <ul className="model-list">
            {models.map((model) => (
              <li key={model.modelName}>
                <span>{model.modelName}</span>
                <b>
                  {model.tokens === null ? "—" : formatCompact(model.tokens)}
                </b>
              </li>
            ))}
          </ul>
        </SessionDetailColumn>
        <SessionEffortSection
          detail={detail}
          status={effortStatus}
          collapsed={collapsedColumns.has("effort")}
          onToggle={() => toggleColumn("effort")}
        />
      </div>
      {externalStatus && (
        <div
          className={`session-external-status is-${externalStatus.kind}`}
          role="status"
          aria-live="polite"
        >
          {externalStatus.kind === "pending" ? (
            <RefreshCw aria-hidden="true" />
          ) : (
            <ExternalLink aria-hidden="true" />
          )}
          <span>{externalStatus.message}</span>
        </div>
      )}
    </div>
  );
}

/** Every known value stays visible for a mixed session; Unknown activity and coverage are never
 * hidden, and provenance says where the numbers came from. */
function SessionEffortSection({
  detail,
  status,
  collapsed,
  onToggle,
}: {
  detail: SessionDetail;
  status: EffortIndexStatus | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const summary = detail.effort ?? null;
  const summaryAvailable = summary && summary.coverageState !== "unavailable";
  const collapsedStats: SessionDetailSpineStat[] = summaryAvailable
    ? summary.mixed
      ? [
          { value: formatCompact(summary.levels.length), label: "values" },
          { value: "mixed", tone: "accent" },
        ]
      : [{ value: effortLabel(summary.dominant), label: "dominant" }]
    : [{ value: "—", label: "effort" }];
  return (
    <SessionDetailColumn
      column="effort"
      label="Effort"
      collapsed={collapsed}
      collapsedMeta={
        summaryAvailable
          ? summary.mixed
            ? `Mixed, ${summary.levels.length} values`
            : effortLabel(summary.dominant)
          : "Unknown"
      }
      collapsedStats={collapsedStats}
      onToggle={onToggle}
      title={EFFORT_HELP}
      aside={
        summaryAvailable && (
          <small>
            {summary.mixed
              ? `mixed · ${summary.levels.length} values`
              : `dominant by ${summary.dominantBasis ?? "observations"}`}
          </small>
        )
      }
    >
      <EffortState status={status} summary={summary}>
        {summary && (
          <>
            <EffortStack summary={summary} showLegend={false} />
            <ul className="model-list">
              {summary.levels.map((level) => (
                <li key={level.effort}>
                  <span>{effortLabel(level.effort)}</span>
                  <b>
                    {formatCompact(level.tokens)} ·{" "}
                    {formatCompact(level.observations)} obs
                  </b>
                </li>
              ))}
              {(summary.unknownTokens ?? 0) > 0 ||
              summary.unknownObservations > 0 ? (
                <li>
                  <span>Unknown</span>
                  <b>
                    {summary.unknownTokens === null
                      ? "—"
                      : formatCompact(summary.unknownTokens)}{" "}
                    · {formatCompact(summary.unknownObservations)} obs
                  </b>
                </li>
              ) : null}
            </ul>
            <EffortCoverage
              summary={summary}
              indexing={status?.phase === "indexing"}
            />
            <p className="effort-coverage">
              Read from this session's own transcript · parser v
              {status?.parserVersion ?? "—"}
            </p>
          </>
        )}
      </EffortState>
    </SessionDetailColumn>
  );
}

/** Every model × effort the session recorded, dominant first. Effort alone was never a decision
 * unit, so each pill names the model that recorded it; a session that switched combos shows all
 * of them rather than hiding the rest behind a count. */
function SessionEffortCell({
  decoded,
  enabled,
}: {
  decoded: DecodedSessionEffort | undefined;
  enabled: boolean;
}) {
  if (!enabled)
    return (
      <span className="effort-badge effort-badge-unknown" title={EFFORT_HELP}>
        Off
      </span>
    );
  if (!decoded || !decoded.dominantCombo)
    return (
      <span
        className="effort-badge effort-badge-unknown"
        title={
          decoded?.unjoinable
            ? "This session has no transcript match, so no effort could be read."
            : EFFORT_HELP
        }
      >
        Unknown
      </span>
    );
  const coverage =
    decoded.tokenCoverage === null
      ? "coverage unavailable"
      : `${Math.round(decoded.tokenCoverage * 100)}% of tokens attributed`;
  const dominantKey = comboKey(decoded.dominantCombo);
  const rest = decoded.combos
    .filter((combo) => comboKey(combo) !== dominantKey)
    .sort((left, right) => compareComboKeys(comboKey(left), comboKey(right)));
  return (
    <span
      className="session-combo-cell"
      title={`${effortSummaryLabel(decoded)} · ${coverage}${decoded.mixed ? " · mixed effort" : ""}`}
    >
      <ComboPill combo={decoded.dominantCombo} />
      {rest.map((combo) => (
        <ComboPill key={comboKey(combo)} combo={combo} />
      ))}
    </span>
  );
}

/** Names the active facet in words, so an empty state says which selection produced it. */
function effortFilterLabel(filter: string) {
  if (filter === "mixed") return "mixed effort";
  if (filter === "unknown") return "unknown effort";
  const combo = parseComboFacet(filter);
  if (combo) return comboLabel(combo);
  return `${effortLabel(filter.startsWith("value:") ? filter.slice("value:".length) : filter)} effort`;
}

const verdictOptions = [
  { value: "good", label: "Good", icon: "＋" },
  { value: "mixed", label: "Mixed", icon: "～" },
  { value: "bad", label: "Bad", icon: "−" },
] as const;

/** One-click, keyboard-reachable rating. It is the user's own judgement: nothing here infers a
 * verdict, and clicking the active option clears it rather than locking it in. */
function SessionVerdictControl({
  sessionId,
  verdict,
  onChange,
}: {
  sessionId: string;
  verdict: SessionVerdict | null;
  onChange: (sessionId: string, annotation: SessionAnnotation) => void;
}) {
  const [pending, setPending] = useState<SessionVerdict | null | "none">("none");
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== "none";

  const write = async (next: SessionVerdict | null) => {
    setPending(next);
    setError(null);
    try {
      onChange(sessionId, await setSessionVerdict(sessionId, next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending("none");
    }
  };

  return (
    <span
      className={`session-verdict${busy ? " is-busy" : ""}`}
      role="group"
      aria-label={`Session verdict: ${verdict ?? "not rated"}`}
      aria-busy={busy}
    >
      {verdictOptions.map((option) => {
        const active = verdict === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? "active" : ""}
            aria-pressed={active}
            disabled={busy}
            title={active ? `Clear the ${option.label.toLowerCase()} rating` : `Rate this session ${option.label.toLowerCase()}`}
            onClick={(event) => {
              event.stopPropagation();
              void write(active ? null : option.value);
            }}
          >
            <i aria-hidden="true">{option.icon}</i>
            <span className="sr-only">{active ? `Clear ${option.label} rating` : `Rate ${option.label}`}</span>
          </button>
        );
      })}
      {error && <em role="alert" title={error}>!</em>}
    </span>
  );
}

function Sessions({
  sessions,
  onEdit,
  focusSessionId,
  focusOutsideRange = false,
}: {
  sessions: Session[];
  onEdit: (session: Session) => void;
  focusSessionId?: string | null;
  focusOutsideRange?: boolean;
}) {
  type SortKey =
    | "activity"
    | "session"
    | "agent"
    | "cwd"
    | "tokens"
    | "cost"
    | "effort";
  const [query, setQuery] = useState("");
  const [effortFilter, setEffortFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>(
    { key: "activity", direction: "desc" },
  );
  const pageSize = 15;
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);
  const lastUserScrollAt = useUserScrollIntent();
  // The digest is requested unscoped: it describes every dashboard session, and this view already
  // receives the range/provider/path-filtered subset it should render.
  const digestRequest = useEffortSessions({});
  const statusRequest = useEffortStatus();
  const digest = digestRequest.data;
  const effortStatus = statusRequest.data;
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [digestRequest.load]);
  const effortBySession = useMemo(() => decodeEffortDigest(digest), [digest]);
  // A verdict write returns the stored annotation. Patching it in here makes the change visible
  // at once; the next dashboard fetch independently returns the same value, so the two agree.
  const [annotationPatches, setAnnotationPatches] = useState<Record<string, SessionAnnotation>>({});
  const annotationOf = useCallback(
    (session: Session) => annotationPatches[session.sessionId] ?? session.annotation,
    [annotationPatches],
  );
  const patchAnnotation = useCallback(
    (sessionId: string, annotation: SessionAnnotation) =>
      setAnnotationPatches((current) => ({ ...current, [sessionId]: annotation })),
    [],
  );
  const observedEffortValues = useMemo(
    () => [...(digest?.efforts ?? [])].sort(compareEffort),
    [digest],
  );
  const observedCombos = useMemo(
    () => (digest?.combos ?? []).map(([familyIndex, effortIndex, kind]) => ({
      family: digest!.families[familyIndex],
      effort: digest!.efforts[effortIndex],
      kind,
    })),
    [digest],
  );
  const effortText = useCallback(
    (session: Session) => effortSearchText(effortBySession.get(session.sessionId)),
    [effortBySession],
  );
  const matchesEffortFilter = useCallback(
    (session: Session) =>
      matchesSessionEffortFilter(effortBySession.get(session.sessionId), effortFilter),
    [effortBySession, effortFilter],
  );
  const filtered = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return sessions.filter(
      (s) =>
        matchesEffortFilter(s) &&
        `${s.agent} ${s.modelsUsed.join(" ")} ${s.cwd ?? ""} ${s.pathTags.join(" ")} ${s.annotation.tags.join(" ")} ${effortText(s)}`
          .toLowerCase()
          .includes(normalizedQuery),
    );
  }, [query, sessions, effortText, matchesEffortFilter]);
  const sorted = useMemo(() => [...filtered].sort((left, right) => {
    const value = (session: Session): string | number => {
      if (sort.key === "activity")
        return Date.parse(String(session.metadata?.lastActivity ?? "")) || 0;
      if (sort.key === "session") return session.modelsUsed[0] ?? "";
      if (sort.key === "agent") return session.agent;
      if (sort.key === "cwd") return session.cwd ?? "";
      if (sort.key === "tokens") return session.totalTokens;
      if (sort.key === "effort")
        return sessionEffortSortValue(
          effortBySession.get(session.sessionId),
          effortRank,
        );
      return session.totalCost;
    };
    const a = value(left),
      b = value(right);
    const comparison =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b));
    return sort.direction === "asc" ? comparison : -comparison;
  }), [filtered, sort, effortBySession]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage(1), [query, effortFilter]);
  useEffect(() => setPage((current) => Math.min(current, pages)), [pages]);
  const sortBy = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : {
            key,
            direction:
              key === "activity" || key === "tokens" || key === "cost"
                ? "desc"
                : "asc",
          },
    );
    setPage(1);
  };
  const toggle = async (session: Session) => {
    if (expanded === session.sessionId) return setExpanded(null);
    setExpanded(session.sessionId);
    if (session.source === "warp") return;
    if (details[session.sessionId]) return;
    setLoadingDetail(session.sessionId);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/detail`,
      );
      if (!response.ok) throw new Error("Session details are unavailable");
      const detail = (await response.json()) as SessionDetail;
      setDetails((current) => ({ ...current, [session.sessionId]: detail }));
    } catch {
      setDetails((current) => ({
        ...current,
        [session.sessionId]: {
          available: false,
          prompts: [],
          outputs: [],
          tools: [],
          files: [],
          additions: 0,
          deletions: 0,
          eventsRead: 0,
        },
      }));
    } finally {
      setLoadingDetail(null);
    }
  };
  const copySessionLink = async (sessionId: string) => {
    try {
      const link = new URL(sessionHref(sessionId), window.location.href).href;
      await navigator.clipboard.writeText(link);
      setCopiedSessionId(sessionId);
      window.setTimeout(() => setCopiedSessionId(null), 1600);
    } catch {}
  };
  useEffect(() => {
    if (!focusSessionId) return;
    const index = sorted.findIndex(
      (session) => session.sessionId === focusSessionId,
    );
    if (index < 0) return;
    setPage(Math.floor(index / pageSize) + 1);
    if (expanded !== focusSessionId) void toggle(sorted[index]);
  }, [focusSessionId]);
  useEffect(() => {
    if (!focusSessionId || expanded !== focusSessionId) return;
    const timeout = window.setTimeout(() => {
      if (performance.now() - lastUserScrollAt.current < userScrollCancelWindowMs)
        return;
      const row = focusedRowRef.current;
      if (!row) return;
      const topbarHeight =
        document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().height ?? 72;
      const target = Math.max(
        0,
        window.scrollY + row.getBoundingClientRect().top - topbarHeight - 18,
      );
      if (Math.abs(target - window.scrollY) < 12) return;
      window.scrollTo({
        top: target,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, autoScrollDelayMs);
    return () => window.clearTimeout(timeout);
  }, [focusSessionId, page, expanded]);
  const header = (key: SortKey, label: string) => (
    <th
      aria-sort={
        sort.key === key
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className={`sort-header ${sort.key === key ? "active" : ""}`}
        onClick={() => sortBy(key)}
      >
        {label}
        <span aria-hidden="true">
          {sort.key === key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="SESSION LEDGER"
        title="Trace sessions"
        description="Expand a session to inspect local prompts, sampled assistant output, files, tools, model mix, and effort. Warp rows contain metadata-only credit and tool summaries from this machine."
        actions={
          <div className="project-controls">
            <label className="search">
              <Search />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions…"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear session search"
                >
                  Clear
                </button>
              )}
            </label>
            <div className="project-sort">
              <label htmlFor="session-effort-filter">MODEL × EFFORT</label>
              <ComboFacetSelect
                id="session-effort-filter"
                value={effortFilter}
                onChange={setEffortFilter}
                effortLevels={observedEffortValues}
                combos={observedCombos}
                disabled={!effortStatus?.enabled}
              />
            </div>
          </div>
        }
      />
      <section className="panel table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {header("activity", "Last activity")}
                {header("session", "Model")}
                {header("agent", "Agent")}
                {header("cwd", "Working directory")}
                {header("tokens", "Tokens")}
                {header("cost", "Cost / credits")}
                {header("effort", "Model \u00d7 effort")}
                <th className="session-verdict-header">
                  <span title="Your own rating of the session. It is never inferred, and it is the only signal in this app that is user-supplied.">
                    Verdict
                  </span>
                </th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((session) => (
                <Fragment key={session.sessionId}>
                  <tr
                    ref={
                      session.sessionId === focusSessionId
                        ? focusedRowRef
                        : undefined
                    }
                    className={`session-row ${expanded === session.sessionId ? "session-row-open" : ""}`}
                    tabIndex={0}
                    aria-expanded={expanded === session.sessionId}
                    aria-label={`Toggle details for ${session.modelsUsed[0] ?? "this session"}, effort ${effortSummaryLabel(effortBySession.get(session.sessionId))}`}
                    onClick={() => void toggle(session)}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        void toggle(session);
                      }
                    }}
                  >
                    <td>
                      <span className="session-activity">
                        {session.metadata?.lastActivity
                          ? formatDate(session.metadata.lastActivity)
                          : "—"}
                      </span>
                    </td>
                    <td>
                      <span>
                        <span className="session-row__model-title">
                          <b>{session.modelsUsed[0] ?? "Unknown"}</b>
                          {sessionModelNames(session).length > 1 && (
                            <i
                              className="model-mix-marker"
                              title={`${sessionModelNames(session).length} models used in this session`}
                            >
                              Mixed · {sessionModelNames(session).length}
                            </i>
                          )}
                          {focusOutsideRange && session.sessionId === focusSessionId && (
                            <i className="session-range-exception">Outside active range</i>
                          )}
                        </span>
                        <small>{session.period.slice(0, 18)}</small>
                      </span>
                    </td>
                    <td className="session-row__agent">
                      <span className={`agent-pill ${session.agent}`}>
                        {session.agent}
                      </span>
                    </td>
                    <td>
                      <span
                        className="cwd"
                        title={session.cwd ?? "Unavailable"}
                      >
                        {session.cwd ?? "Path unavailable"}
                      </span>
                      <span className="mini-tags">
                        {[...session.pathTags, ...annotationOf(session).tags]
                          .slice(0, 3)
                          .map((tag) => (
                            <i key={tag}>{tag}</i>
                          ))}
                      </span>
                    </td>
                    <td>
                      <b>{formatCompact(session.totalTokens)}</b>
                      <small>
                        {session.source === "warp"
                          ? "recorded tokens"
                          : `${formatCompact(session.outputTokens)} output`}
                      </small>
                    </td>
                    <td>
                      {session.source === "warp" ? (
                        <>
                          <b>{formatWarpCredits(session.warp?.credits ?? 0)}</b>
                          <small>Warp credits</small>
                        </>
                      ) : (
                        <>
                          <b>{formatMoney(session.totalCost)}</b>
                          <small>ccusage</small>
                        </>
                      )}
                    </td>
                    <td className="session-row__effort">
                      <SessionEffortCell
                        decoded={effortBySession.get(session.sessionId)}
                        enabled={Boolean(effortStatus?.enabled)}
                      />
                    </td>
                    <td
                      className="session-row__verdict"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <SessionVerdictControl
                        sessionId={session.sessionId}
                        verdict={annotationOf(session).verdict}
                        onChange={patchAnnotation}
                      />
                    </td>
                    <td
                      className="session-row__actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => onEdit(session)}
                        aria-label="Edit annotation"
                        title="Edit annotation"
                      >
                        <PencilLine />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void copySessionLink(session.sessionId)}
                        aria-label={
                          copiedSessionId === session.sessionId
                            ? "Session link copied"
                            : "Copy direct session link"
                        }
                        title={
                          copiedSessionId === session.sessionId
                            ? "Copied"
                            : "Copy direct session link"
                        }
                      >
                        {copiedSessionId === session.sessionId ? <Check /> : <Copy />}
                      </button>
                    </td>
                    <td
                      className="session-row__toggle"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="session-detail-toggle"
                        onClick={() => void toggle(session)}
                        aria-label={
                          expanded === session.sessionId
                            ? "Close session details"
                            : "Open session details"
                        }
                        aria-expanded={expanded === session.sessionId}
                      >
                        <Plus />
                      </button>
                    </td>
                  </tr>
                  {expanded === session.sessionId && (
                    <tr className="session-detail-row">
                      <td colSpan={10}>
                        <SessionDetailPanel
                          session={session}
                          detail={details[session.sessionId]}
                          loading={loadingDetail === session.sessionId}
                          effortStatus={effortStatus}
                          annotation={annotationOf(session)}
                          onAnnotationChange={patchAnnotation}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!pageRows.length && (
          <Empty
            text={
              effortFilter === "all"
                ? "No sessions match those filters."
                : `No sessions match those filters with ${effortFilterLabel(effortFilter)}.`
            }
          />
        )}
        <div className="pagination">
          <span>{filtered.length} sessions</span>
          <div>
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
            </button>
            <PageJump
              page={page}
              pages={pages}
              label="session page"
              onChange={setPage}
            />
            <button
              disabled={page === pages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function projectDayRows(
  trend: ProjectTrendRow[],
  activity: ProjectActivity[] = [],
) {
  const days = new Map<
    string,
    {
      date: string;
      tokens: number;
      cost: number;
      warpCredits: number;
      runs: number;
      models: Map<string, { tokens: number; cost: number }>;
    }
  >();
  trend.forEach((row) => {
    const day = days.get(row.date) ?? {
      date: row.date,
      tokens: 0,
      cost: 0,
      warpCredits: 0,
      runs: 0,
      models: new Map<string, { tokens: number; cost: number }>(),
    };
    day.tokens += row.totalTokens;
    day.cost += row.totalCost;
    day.warpCredits += row.warpCredits ?? 0;
    day.runs++;
    row.modelBreakdowns.forEach((model) => {
      const tokens =
        model.inputTokens +
        model.outputTokens +
        model.cacheReadTokens +
        model.cacheCreationTokens;
      const current = day.models.get(model.modelName) ?? { tokens: 0, cost: 0 };
      current.tokens += tokens;
      current.cost += model.cost;
      day.models.set(model.modelName, current);
    });
    days.set(row.date, day);
  });
  const providersByDay = new Map<string, ProjectActivity[]>();
  activity.forEach((item) =>
    providersByDay.set(item.date, [
      ...(providersByDay.get(item.date) ?? []),
      item,
    ]),
  );
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const providers = (providersByDay.get(day.date) ?? []).sort(
        (a, b) =>
          providerSeries.findIndex((provider) => provider.key === a.provider) -
          providerSeries.findIndex((provider) => provider.key === b.provider),
      );
      const providerTokens = providers.reduce(
        (totals, item) => {
          totals[item.provider] += item.tokens;
          return totals;
        },
        { anthropic: 0, codex: 0, warp: 0 },
      );
      const attributedTokens = Object.values(providerTokens).reduce(
        (sum, tokens) => sum + tokens,
        0,
      );
      return {
        ...day,
        ...providerTokens,
        unattributed: Math.max(0, day.tokens - attributedTokens),
        runs: providers.length
          ? providers.reduce((sum, item) => sum + item.sessions, 0)
          : day.runs,
        label: new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        models: [...day.models.entries()]
          .map(([name, totals]) => ({ name, ...totals }))
          .sort((a, b) => b.tokens - a.tokens),
        providers,
      };
    });
}

export function projectTrendRowsInRange(
  trend: ProjectTrendRow[],
  daily: MetricRow[],
) {
  const periods = new Set(daily.map((row) => row.period));
  return trend.filter((row) => periods.has(row.date));
}

export function projectSummaryInRange(
  project: ProjectSummary,
  daily: MetricRow[],
  sessionCount: number,
): ProjectSummary | null {
  const trend = projectTrendRowsInRange(project.trend, daily);
  if (!trend.length) return null;
  const modelTotals = new Map<string, number>();
  for (const day of trend) {
    for (const model of day.modelBreakdowns) {
      const tokens =
        model.inputTokens +
        model.outputTokens +
        model.cacheReadTokens +
        model.cacheCreationTokens;
      modelTotals.set(
        model.modelName,
        (modelTotals.get(model.modelName) ?? 0) + tokens,
      );
    }
  }
  return {
    ...project,
    trend,
    tokens: trend.reduce((sum, day) => sum + day.totalTokens, 0),
    cost: trend.reduce((sum, day) => sum + day.totalCost, 0),
    warpCredits: trend.reduce((sum, day) => sum + (day.warpCredits ?? 0), 0) || undefined,
    sessions: sessionCount,
    models: [...modelTotals.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([model]) => model),
  };
}

function ProjectDayTooltip({
  active,
  payload,
  coordinate,
  quotaMarkers = [],
  timeZone = systemTimeZone(),
}: ChartTooltipProps & { quotaMarkers?: QuotaMarker[]; timeZone?: string }) {
  const pinSource = useId();
  const liveRow = payload?.[0]?.payload as
    | ReturnType<typeof projectDayRows>[number]
    | undefined;
  const hold = useChartTooltipHold(
    active && liveRow ? { row: liveRow, coordinate } : null,
    active && liveRow ? liveRow.date : null,
  );
  const tooltipRef = useClampedTooltip(
    Boolean(hold.snapshot),
    hold.snapshot?.coordinate,
  );
  if (!hold.snapshot) return null;
  const { row } = hold.snapshot;
  const dateLabel = chartTooltipDateLabel(row.date);
  return (
    <PinnableChartTooltip
      id={`${pinSource}:${row.date}`}
      ariaLabel={`project activity details for ${dateLabel}`}
      contextLabel="Project usage"
      contextDescription="Project tokens and estimated API cost, grouped by provider and model."
      contextPlacement="inline"
      className="provider-tooltip"
      forwardedRef={tooltipRef}
      interactionRef={hold.cardRef}
      retained={hold.retained}
      cardInteractionProps={hold.cardInteractionProps}
      pinInteractionProps={hold.pinInteractionProps}
    >
      <div className="tooltip-columns">
        <div className="tooltip-columns__date">
          <span className="tooltip-date-label">{dateLabel}</span>
          <ChartTooltipContext
            label="Project usage"
            description="Project tokens and estimated API cost, grouped by provider and model."
            className="chart-tooltip__context--inline"
          />
        </div>
        <small>Tokens</small>
        <small>API $</small>
      </div>
      <QuotaReachNotes
        markers={quotaMarkersAt(quotaMarkers, row.date)}
        timeZone={timeZone}
      />
      <section className="tooltip-projects">
        <div className="tooltip-projects__head">
          <strong>Total</strong>
          <b>{formatCompact(row.tokens)}</b>
          <b>{formatMoney(row.cost)}</b>
        </div>
      </section>
      {row.providers.map((providerActivity) => {
        const provider = providerSeries.find(
          (item) => item.key === providerActivity.provider,
        )!;
        const visibleModels = providerActivity.models.slice(0, 3);
        return (
          <section className="tooltip-provider" key={providerActivity.provider}>
            <div className="tooltip-provider__head">
              <i style={{ background: provider.color }} />
              <strong>{provider.label}</strong>
              <b>{formatCompact(providerActivity.tokens)}</b>
              <b>{formatMoney(providerActivity.cost)}</b>
            </div>
            {visibleModels.length > 0 && (
              <ul className="tooltip-provider-models">
                {visibleModels.map((model) => (
                  <li key={model.model}>
                    <span>{model.model}</span>
                    <b>{formatCompact(model.tokens)}</b>
                    <b>{formatMoney(model.cost)}</b>
                  </li>
                ))}
              </ul>
            )}
            {providerActivity.models.length > visibleModels.length && (
              <small className="tooltip-more-row tooltip-model-more">
                <span>
                  +{providerActivity.models.length - visibleModels.length} more
                </span>
                <b>
                  {formatCompact(
                    providerActivity.models
                      .slice(3)
                      .reduce((sum, model) => sum + model.tokens, 0),
                  )}
                </b>
                <b>
                  {formatMoney(
                    providerActivity.models
                      .slice(3)
                      .reduce((sum, model) => sum + model.cost, 0),
                  )}
                </b>
              </small>
            )}
          </section>
        );
      })}
    </PinnableChartTooltip>
  );
}

export type ProjectModelSessionRow = {
  session: Session;
  /** Best available instant for the session: its last activity, else its period day. */
  timestamp: string;
  tokens: number;
  cost: number;
};

/** Sessions of one project that touched one model, newest first. Tokens and cost are that
 * model's share of the session, so a mixed-model session is not counted at its full weight. */
export function projectModelSessionRows(
  sessions: Session[],
  modelName: string,
): ProjectModelSessionRow[] {
  return sessions
    .filter((session) => sessionModelNames(session).includes(modelName))
    .map((session) => {
      const breakdowns = session.modelBreakdowns.filter(
        (model) => model.modelName === modelName,
      );
      return {
        session,
        timestamp: String(session.metadata?.lastActivity ?? session.period),
        tokens: breakdowns.length
          ? breakdowns.reduce(
              (sum, model) =>
                sum +
                model.inputTokens +
                model.outputTokens +
                model.cacheReadTokens +
                model.cacheCreationTokens,
              0,
            )
          : session.totalTokens,
        cost: breakdowns.length
          ? breakdowns.reduce((sum, model) => sum + model.cost, 0)
          : session.totalCost,
      };
    })
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

/** Date-only periods have no time zone, so they are read at midday to keep the calendar day. */
function sessionStampDate(value: string) {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
}

function formatSessionDay(value: string) {
  const date = sessionStampDate(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function formatSessionStamp(value: string) {
  const date = sessionStampDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatSessionDay(value)
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** Oldest — newest, collapsed to a single date when the whole set lands on one day. */
export function sessionRangeLabel(rows: ProjectModelSessionRow[]) {
  if (!rows.length) return "No dated sessions";
  const newest = formatSessionDay(rows[0]!.timestamp);
  const oldest = formatSessionDay(rows.at(-1)!.timestamp);
  return oldest === newest ? oldest : `${oldest} — ${newest}`;
}

const MODEL_SESSION_PAGE_SIZE = 6;

/** Per-model link in the project model mix that opens a paged, project + model scoped
 * session list. The card is portalled and fixed-positioned because the model list scrolls. */
function ProjectModelSessions({
  projectName,
  modelName,
  color,
  rows,
  onOpenSession,
}: {
  projectName: string;
  modelName: string;
  color: string;
  rows: ProjectModelSessionRow[];
  onOpenSession: (sessionId: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const labelId = useId();
  const pages = Math.max(1, Math.ceil(rows.length / MODEL_SESSION_PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = rows.slice(
    safePage * MODEL_SESSION_PAGE_SIZE,
    safePage * MODEL_SESSION_PAGE_SIZE + MODEL_SESSION_PAGE_SIZE,
  );
  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const card = cardRef.current;
      if (!trigger || !card) return;
      const anchor = trigger.getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      const gap = 8;
      const edge = 12;
      const below = anchor.bottom + gap;
      const top =
        below + bounds.height > window.innerHeight - edge
          ? Math.max(edge, anchor.top - gap - bounds.height)
          : below;
      const left = Math.min(
        Math.max(edge, anchor.left),
        Math.max(edge, window.innerWidth - edge - bounds.width),
      );
      setPosition((current) =>
        current && current.top === top && current.left === left
          ? current
          : { top, left },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, safePage]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);
  const scopeLabel = `${friendlyProject(projectName)} · ${modelName}`;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-model-sessions__trigger${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!rows.length}
        title={
          rows.length
            ? `Show sessions for ${scopeLabel}`
            : `No indexed sessions for ${scopeLabel}`
        }
        aria-label={`${rows.length} ${rows.length === 1 ? "session" : "sessions"} for ${scopeLabel}`}
        onClick={() => {
          setPage(0);
          setOpen((current) => !current);
          setPosition(null);
        }}
      >
        <FileText aria-hidden="true" />
        <span>
          {rows.length} {rows.length === 1 ? "session" : "sessions"}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={cardRef}
            className="model-sessions-card"
            role="dialog"
            aria-labelledby={labelId}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? undefined : "hidden",
            }}
          >
            <div className="model-sessions-card__head">
              <div>
                <span className="overline">SESSIONS · PROJECT × MODEL</span>
                <strong id={labelId}>
                  <i style={{ background: color }} />
                  {scopeLabel}
                </strong>
              </div>
              <button
                type="button"
                className="model-sessions-card__close"
                aria-label="Close session list"
                onClick={() => {
                  close();
                  triggerRef.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <p className="model-sessions-card__range">
              <b>
                {rows.length} {rows.length === 1 ? "session" : "sessions"}
              </b>
              <span>{sessionRangeLabel(rows)}</span>
            </p>
            <ol className="model-sessions-card__list">
              {visible.map(({ session, timestamp, tokens, cost }) => (
                <li key={session.sessionId}>
                  <div className="model-sessions-card__when">
                    <span className={`agent-pill ${session.agent}`}>
                      {session.agent}
                    </span>
                    <b>{formatSessionStamp(timestamp)}</b>
                  </div>
                  <div className="model-sessions-card__stats">
                    <b>{formatCompact(tokens)}</b>
                    <em>{formatMoney(cost)}</em>
                  </div>
                  <a
                    href={sessionHref(session.sessionId)}
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      close();
                      onOpenSession(session.sessionId);
                    }}
                  >
                    Open <ArrowUpRight aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ol>
            {pages > 1 && (
              <div className="model-sessions-card__pager">
                <button
                  type="button"
                  aria-label="Previous page of sessions"
                  disabled={safePage === 0}
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                >
                  <ChevronLeft aria-hidden="true" />
                </button>
                <PageJump
                  page={safePage + 1}
                  pages={pages}
                  label="session page"
                  onChange={(next) => setPage(next - 1)}
                />
                <button
                  type="button"
                  aria-label="Next page of sessions"
                  disabled={safePage >= pages - 1}
                  onClick={() => setPage(Math.min(pages - 1, safePage + 1))}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function ProjectDetails({
  project,
  activity,
  sessions,
  daily,
  quotaHistory,
  timeZone,
  effortScope,
  rangeEmptyText,
  onOpenSession,
}: {
  project: ProjectSummary;
  activity: ProjectActivity[];
  sessions: Session[];
  daily: MetricRow[];
  quotaHistory: DashboardData["quotas"]["history"];
  timeZone: string;
  effortScope: EffortScopeInput;
  rangeEmptyText: string;
  onOpenSession: (sessionId: string) => void;
}) {
  type ModelSortKey = "name" | "tokens" | "cost";
  const [modelSort, setModelSort] = useState<{
    key: ModelSortKey;
    direction: "asc" | "desc";
  }>({ key: "tokens", direction: "desc" });
  const [sessionDetails, setSessionDetails] = useState<ProjectSessionDetail[]>(
    [],
  );
  const [loadingSessions, setLoadingSessions] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoadingSessions(true);
    const loadDetails = async () => {
      const details: ProjectSessionDetail[] = [];
      let next = 0;
      const worker = async () => {
        while (!cancelled) {
          const session = sessions[next++];
          if (!session) return;
        if (session.source === "warp" && session.warp) {
          details.push({
            session,
            detail: {
              available: true,
              prompts: [],
              outputs: [],
              tools: [],
              files: [],
              additions: session.warp.linesAdded,
              deletions: session.warp.linesRemoved,
              eventsRead: session.warp.turns,
            },
          });
          continue;
        }
        try {
          const response = await fetch(
            `/api/sessions/${encodeURIComponent(session.sessionId)}/detail`,
          );
          if (!response.ok) throw new Error("Session details are unavailable");
          details.push({ session, detail: (await response.json()) as SessionDetail });
        } catch {
          details.push({
            session,
            detail: {
              available: false,
              prompts: [],
              outputs: [],
              tools: [],
              files: [],
              additions: 0,
              deletions: 0,
              eventsRead: 0,
            } satisfies SessionDetail,
          });
        }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, worker));
      if (!cancelled) {
        setSessionDetails(details);
        setLoadingSessions(false);
      }
    };
    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [sessions]);
  const days = projectDayRows(project.trend, activity);
  const chartDays = projectDayRows(
    projectTrendRowsInRange(project.trend, daily),
    activity.filter((item) => daily.some((row) => row.period === item.date)),
  );
  const quotaMarkers = dailyQuotaMarkers(
    quotaHistory,
    chartDays.map((day) => day.date),
    null,
    timeZone,
  );
  const projectProviderSeries = providerSeries
    .map((provider) => ({
      ...provider,
      value: chartDays.reduce(
        (sum, day) => sum + day[provider.key],
        0,
      ),
    }))
    .filter((provider) => provider.value > 0);
  const unattributedTokens = chartDays.reduce(
    (sum, day) => sum + day.unattributed,
    0,
  );
  const modelTotals = new Map<string, { tokens: number; cost: number }>();
  days.forEach((day) =>
    day.models.forEach((model) => {
      const totals = modelTotals.get(model.name) ?? { tokens: 0, cost: 0 };
      totals.tokens += model.tokens;
      totals.cost += model.cost;
      modelTotals.set(model.name, totals);
    }),
  );
  const modelEntries = [...modelTotals.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((model, colorIndex) => ({ ...model, colorIndex }));
  const models = [...modelEntries].sort((left, right) => {
    const comparison =
      modelSort.key === "name"
        ? left.name.localeCompare(right.name)
        : left[modelSort.key] - right[modelSort.key];
    return modelSort.direction === "asc" ? comparison : -comparison;
  });
  const sortModels = (key: ModelSortKey) =>
    setModelSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "name" ? "asc" : "desc" },
    );
  const modelSortButton = (key: ModelSortKey, label: string) => (
    <button
      type="button"
      className={modelSort.key === key ? "active" : undefined}
      aria-label={`Sort models by ${label} ${modelSort.key === key && modelSort.direction === "asc" ? "descending" : "ascending"}`}
      aria-pressed={modelSort.key === key}
      onClick={() => sortModels(key)}
    >
      <span>{label}</span>
      <i aria-hidden="true">
        {modelSort.key === key
          ? modelSort.direction === "asc"
            ? "↑"
            : "↓"
          : "↕"}
      </i>
    </button>
  );
  const first = days[0]?.date;
  const last = days.at(-1)?.date;
  const orderedSessionDetails = [...sessionDetails].sort((left, right) =>
    String(right.session.metadata?.lastActivity ?? "").localeCompare(
      String(left.session.metadata?.lastActivity ?? ""),
    ),
  );
  const changedFiles = new Set(
    sessionDetails.flatMap(({ detail }) =>
      detail.files.map((file) => file.path),
    ),
  );
  const warpFiles = sessions.reduce((sum, session) => sum + (session.warp?.filesChanged ?? 0), 0);
  const additions = sessionDetails.reduce(
    (sum, { detail }) => sum + detail.additions,
    0,
  );
  const deletions = sessionDetails.reduce(
    (sum, { detail }) => sum + detail.deletions,
    0,
  );
  const dateCopy =
    first && last
      ? `${new Date(`${first}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} — ${new Date(`${last}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
      : "No dated activity";
  return (
    <div
      className="project-detail"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="project-detail__summary">
        <div>
          <span>Total tokens</span>
          <strong>{project.tokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>Activity records</span>
          <strong>{project.trend.length}</strong>
        </div>
        <div>
          <span>Active days</span>
          <strong>{days.length}</strong>
        </div>
        <div>
          <span>Files changed</span>
          <strong>{loadingSessions ? "…" : changedFiles.size + warpFiles}</strong>
        </div>
        <div>
          <span>Time observed</span>
          <strong className="project-time">{dateCopy}</strong>
        </div>
      </div>
      <div className="project-detail__grid">
        <section className="project-viz project-viz--daily">
          <div className="project-viz__head">
            <div>
              <span className="overline">DAILY SIGNAL</span>
              <h4>Runs and tokens by day</h4>
            </div>
            <div className="project-viz__legend" aria-label="Chart series">
              {projectProviderSeries.map((provider) => (
                <span key={provider.key}>
                  <i style={{ background: provider.color }} />
                  {provider.label}
                </span>
              ))}
              {unattributedTokens > 0 && (
                <span>
                  <i />
                  Unattributed
                </span>
              )}
              <span>
                <i />
                Runs
              </span>
            </div>
          </div>
          <QuotaMarkerLegend markers={quotaMarkers} />
          <div
            className="project-chart"
            role="img"
            aria-label={`Daily token usage segmented by provider, with activity records for ${friendlyProject(project.name)}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartDays}
                margin={{ top: 12, right: 4, left: -16, bottom: 0 }}
              >
                <CartesianGrid
                  stroke="#26312e"
                  strokeDasharray="2 5"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={(props) => {
                    const day = chartDays.find(
                      (item) => item.date === String(props.payload?.value ?? ""),
                    );
                    const tokens = day?.providers.length
                      ? day.providers.map((providerActivity) => ({
                          color:
                            providerSeries.find(
                              (provider) =>
                                provider.key === providerActivity.provider,
                            )?.color ?? "var(--accent)",
                          value: providerActivity.tokens,
                        }))
                      : [{ color: "var(--accent)", value: day?.tokens ?? 0 }];
                    return <ActivityAxisTick {...props} tokens={tokens} />;
                  }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  height={64}
                />
                <YAxis
                  yAxisId="tokens"
                  tickFormatter={formatCompact}
                  tick={{ fill: "#71807b", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="runs"
                  orientation="right"
                  allowDecimals={false}
                  hide
                />
                <Tooltip
                  content={
                    <ProjectDayTooltip
                      quotaMarkers={quotaMarkers}
                      timeZone={timeZone}
                    />
                  }
                  cursor={{ fill: "rgba(183,242,92,.05)" }}
                  offset={0}
                  isAnimationActive={false}
                  wrapperStyle={chartTooltipWrapperStyle}
                />
                <QuotaReferenceLines markers={quotaMarkers} yAxisId="tokens" />
                {[...projectProviderSeries].reverse().map((provider) => (
                  <Bar
                    key={provider.key}
                    yAxisId="tokens"
                    dataKey={provider.key}
                    name={provider.label}
                    stackId="providers"
                    fill={provider.color}
                    fillOpacity={0.72}
                    radius={[3, 3, 0, 0]}
                  />
                ))}
                <Bar
                  yAxisId="tokens"
                  dataKey="unattributed"
                  name="Unattributed"
                  stackId="providers"
                  fill="var(--accent)"
                  fillOpacity={0.46}
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  yAxisId="runs"
                  type="monotone"
                  dataKey="runs"
                  name="Activity records"
                  stroke="var(--aqua)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: "#07100f",
                    stroke: "var(--aqua)",
                    strokeWidth: 2,
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="project-viz model-breakdown">
          <div className="project-viz__head">
            <div>
              <span className="overline">MODEL MIX</span>
              <h4>Usage by model</h4>
            </div>
            <span>
              {models.length} {models.length === 1 ? "model" : "models"}
            </span>
          </div>
          <div className="project-model-total">
            <span>Overall total</span>
            <b>
              <small>Tokens</small>
              {formatCompact(project.tokens)}
            </b>
            <b>
              <small>API eq.</small>
              {formatMoney(project.cost)}
            </b>
            {project.warpCredits ? (
              <b className="project-model-credit">
                <small>Warp credits</small>
                {formatWarpCredits(project.warpCredits)}
              </b>
            ) : null}
          </div>
          <div className="project-model-sort" aria-label="Sort model usage">
            {modelSortButton("name", "Model")}
            {modelSortButton("tokens", "Tokens")}
            {modelSortButton("cost", "API eq.")}
          </div>
          <div className="project-model-list">
            {models.map((model) => (
              <div
                key={model.name}
                title={`${model.name}: ${model.tokens.toLocaleString()} tokens · ${formatMoney(model.cost)} API-equivalent`}
              >
                <div>
                  <span>
                    <i
                      style={{
                        background: palette[model.colorIndex % palette.length],
                      }}
                    />
                    {model.name}
                  </span>
                  <b>{formatCompact(model.tokens)}</b>
                  <b>{formatMoney(model.cost)}</b>
                </div>
                <div className="project-model-meter">
                  <i
                    style={{
                      width: `${project.tokens ? (model.tokens / project.tokens) * 100 : 0}%`,
                      background: palette[model.colorIndex % palette.length],
                    }}
                  />
                </div>
                <div className="project-model-foot">
                  <ProjectModelSessions
                    projectName={project.name}
                    modelName={model.name}
                    color={palette[model.colorIndex % palette.length] ?? "var(--accent)"}
                    rows={projectModelSessionRows(sessions, model.name)}
                    onOpenSession={onOpenSession}
                  />
                  <small>
                    {project.tokens
                      ? Math.round((model.tokens / project.tokens) * 100)
                      : 0}
                    % of tokens
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <EffortByDay
        scope={{
          ...effortScope,
          project: project.name,
        }}
        hasActivity={sessions.length > 0}
        // Repeating this one project on its own page would say nothing; path tags are the
        // session context that still varies here.
        contextSource={{ kind: "pathTag", sessions }}
        timeZone={timeZone}
        emptyText={rangeEmptyText}
        providerLabel="All providers"
      />
      <section
        className="project-sessions"
        aria-label={`Sessions for ${friendlyProject(project.name)}`}
      >
        <div className="project-sessions__head">
          <div>
            <span className="overline">SESSION CHANGES</span>
            <h4>Diff trail</h4>
          </div>
          <div className="project-diff-total">
            <span>
              {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
            </span>
            <strong>
              <i>+{additions}</i>
              <em>−{deletions}</em>
            </strong>
          </div>
        </div>
        {loadingSessions ? (
          <p className="project-sessions__state">
            Reading local session patches…
          </p>
        ) : orderedSessionDetails.length ? (
          <ol className="project-session-list">
            {orderedSessionDetails.map(({ session, detail }) => (
              <li key={session.sessionId}>
                <div className="project-session-meta">
                  <span className={`agent-pill ${session.agent}`}>
                    {session.agent}
                  </span>
                  <div>
                    <b>{session.modelsUsed[0] ?? "Unknown model"}</b>
                    <small>
                      {session.metadata?.lastActivity
                        ? formatDate(session.metadata.lastActivity)
                        : session.period}
                    </small>
                  </div>
                </div>
                <div className="project-session-files">
                  <span>
                    {session.source === "warp"
                      ? `${session.warp?.filesChanged ?? 0} observed ${session.warp?.filesChanged === 1 ? "file" : "files"}`
                      : detail.available
                      ? `${detail.files.length} ${detail.files.length === 1 ? "file" : "files"}`
                      : "Patch unavailable"}
                  </span>
                  {detail.files.length > 0 && (
                    <small
                      title={detail.files.map((file) => file.path).join("\n")}
                    >
                      {detail.files
                        .slice(0, 3)
                        .map((file) => file.path.split("/").at(-1))
                        .join(" · ")}
                      {detail.files.length > 3
                        ? ` · +${detail.files.length - 3}`
                        : ""}
                    </small>
                  )}
                </div>
                <div className="project-session-diff">
                  <i>+{detail.additions}</i>
                  <em>−{detail.deletions}</em>
                </div>
                <EffortBadge summary={detail.effort ?? null} />
                <a
                  href={sessionHref(session.sessionId)}
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    onOpenSession(session.sessionId);
                  }}
                >
                  Open session <ArrowUpRight />
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p className="project-sessions__state">
            No indexed sessions were found for this project.
          </p>
        )}
      </section>
      <p className="project-detail__note">
        “Runs” counts source activity records. Elapsed hours are not available
        in the project report.
      </p>
    </div>
  );
}

function Projects({
  data,
  daily,
  sessions,
  metricRange,
  customRange,
  dateRange,
  onOpenSession,
}: {
  data: DashboardData;
  daily: MetricRow[];
  sessions: Session[];
  metricRange: MetricRange;
  customRange: DateRange | null;
  dateRange: DateRange | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("tokens-desc");
  const openProjectRef = useRef<HTMLElement | null>(null);
  const lastUserScrollAt = useUserScrollIntent();
  const effortScope = timeEffortScope(dateRange, "timeline");
  const effortRequest = useEffortAggregate("project", effortScope);
  const statusRequest = useEffortStatus();
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [effortRequest.load]);
  const effortByProject = useMemo(
    () => new Map((effortRequest.data?.rows ?? []).map((row) => [row.key, row.summary])),
    [effortRequest.data],
  );
  const scopedProjects = useMemo(() => {
    const sessionCounts = new Map<string, number>();
    sessions.forEach((session) => {
      const project = (session.cwd ?? "").replace(/\/+$/, "");
      if (project) sessionCounts.set(project, (sessionCounts.get(project) ?? 0) + 1);
    });
    return data.projects
      .map((project) => projectSummaryInRange(project, daily, sessionCounts.get(project.name) ?? 0))
      .filter(Boolean) as ProjectSummary[];
  }, [data.projects, daily, sessions]);
  const visibleProjects = useMemo(() => {
    const [key, direction] = sort.split("-") as [
      "name" | "tokens" | "cost" | "sessions",
      "asc" | "desc",
    ];
    const matches = scopedProjects.filter((project) =>
      `${friendlyProject(project.name)} ${project.models.join(" ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
    return [...matches].sort((left, right) => {
      const value = (project: ProjectSummary): string | number =>
        key === "name" ? friendlyProject(project.name) : project[key];
      const a = value(left),
        b = value(right);
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b));
      return direction === "asc" ? comparison : -comparison;
    });
  }, [scopedProjects, query, sort]);
  useEffect(() => {
    if (!openProject) return;
    const timeout = window.setTimeout(() => {
      if (performance.now() - lastUserScrollAt.current < userScrollCancelWindowMs)
        return;
      const card = openProjectRef.current;
      if (!card) return;
      const topbarHeight =
        document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().height ?? 72;
      const target = Math.max(
        0,
        window.scrollY + card.getBoundingClientRect().top - topbarHeight - 18,
      );
      if (Math.abs(target - window.scrollY) < 12) return;
      window.scrollTo({
        top: target,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, autoScrollDelayMs);
    return () => window.clearTimeout(timeout);
  }, [openProject]);
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="PROJECT CARTOGRAPHY"
        title="Where the work happened"
        description="Select a project to inspect daily activity, model mix, and observed time range. Warp credits remain separate from API-equivalent cost."
        actions={
          <div className="project-controls">
            <label className="search">
              <Search />
              <span className="sr-only">Search projects</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects…"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear project search"
                >
                  Clear
                </button>
              )}
            </label>
            <label className="project-sort">
              <span>Sort</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="tokens-desc">Tokens: high to low</option>
                <option value="tokens-asc">Tokens: low to high</option>
                <option value="cost-desc">Cost: high to low</option>
                <option value="cost-asc">Cost: low to high</option>
                <option value="sessions-desc">Sessions: high to low</option>
                <option value="sessions-asc">Sessions: low to high</option>
                <option value="name-asc">Name: A to Z</option>
                <option value="name-desc">Name: Z to A</option>
              </select>
            </label>
          </div>
        }
      />
      <section className="card-list project-list">
        {visibleProjects.map((project, index) => {
          const open = openProject === project.name;
          const effortSummary = effortByProject.get(project.name) ?? null;
          const maxTokens = Math.max(
            ...project.trend.map((point) => point.totalTokens),
            1,
          );
          return (
            <article
              className={`project-card${open ? " open" : ""}`}
              ref={open ? openProjectRef : undefined}
              key={project.name}
            >
              <button
                className="rank-card project-row"
                type="button"
                onClick={() => setOpenProject(open ? null : project.name)}
                aria-expanded={open}
                aria-controls={`project-detail-${index}`}
              >
                <span className="rank">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="rank-main">
                  <h3>{friendlyProject(project.name)}</h3>
                  <p>{project.models.slice(0, 3).join(" · ")}</p>
                  <div className="micro-chart" aria-hidden="true">
                    {project.trend.slice(-14).map((point, i) => (
                      <i
                        key={i}
                        style={{
                          height: `${Math.max(8, (point.totalTokens / maxTokens) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div className="rank-stat">
                  <span>Tokens</span>
                  <b>{formatCompact(project.tokens)}</b>
                </div>
                <div className="rank-stat">
                  <span>Cost</span>
                  <b>{formatMoney(project.cost)}</b>
                  {project.warpCredits ? <small className="rank-stat__credit">+ {formatWarpCredits(project.warpCredits)} Warp credits</small> : null}
                </div>
                <div className="rank-stat">
                  <span>Active days</span>
                  <b>{projectDayRows(project.trend).length}</b>
                </div>
                <div className="project-row__effort">
                  <EffortState status={statusRequest.data} summary={effortSummary}>
                    {effortSummary && (
                      <>
                        <EffortStack summary={effortSummary} height={6} showLegend={false} />
                        <EffortCoverage summary={effortSummary} />
                      </>
                    )}
                  </EffortState>
                </div>
                <Plus className="project-row__toggle" aria-hidden="true" />
              </button>
              {open && (
                <div id={`project-detail-${index}`}>
                  <ProjectDetails
                    project={project}
                    daily={daily}
                    activity={data.projectActivity.filter(
                      (activity) => activity.projectId === project.name,
                    )}
                    sessions={sessions.filter(
                      (session) =>
                        (session.cwd ?? "").replace(/\/+$/, "") ===
                        project.name,
                    )}
                    quotaHistory={data.quotas.history}
                    timeZone={data.timeZone}
                    effortScope={effortScope}
                    rangeEmptyText={filterEmptyMessage([], metricRange, "all", customRange)}
                    onOpenSession={onOpenSession}
                  />
                </div>
              )}
            </article>
          );
        })}
      </section>
      {!scopedProjects.length ? (
        <Empty text="No source-exposed projects found in this period." />
      ) : (
        !visibleProjects.length && (
          <Empty text="No projects match that search." />
        )
      )}
    </div>
  );
}

function Models({
  data,
  daily,
  sessions,
  dateRange,
  onOpenSession,
}: {
  data: DashboardData;
  daily: MetricRow[];
  sessions: Session[];
  dateRange: DateRange | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [openModels, setOpenModels] = useState<Set<string>>(
    () => new Set(modelIdsFromUrl()),
  );
  const [pages, setPages] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [usageOrder, setUsageOrder] = useState<"most" | "least">("most");
  const [benchmarkModal, setBenchmarkModal] = useState(false);
  const modelGridRef = useRef<HTMLElement | null>(null);
  const pendingScrollModel = useRef<string | null>(modelIdsFromUrl().at(-1) ?? null);
  const lastUserScrollAt = useUserScrollIntent();
  const models = useMemo(
    () => aggregateModels(daily, data.unpricedModels),
    [daily, data.unpricedModels],
  );
  const effortRequest = useEffortAggregate(
    "model",
    timeEffortScope(dateRange, "timeline"),
  );
  const digestRequest = useEffortSessions(timeEffortScope(dateRange, "sessions"));
  const statusRequest = useEffortStatus();
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [
    effortRequest.load,
    digestRequest.load,
  ]);
  useEffect(() => {
    const syncOpenModels = () => {
      if (initialView() !== "models") return;
      const models = modelIdsFromUrl();
      pendingScrollModel.current = models.at(-1) ?? null;
      transitionModelGrid(() => setOpenModels(new Set(models)));
    };
    window.addEventListener("popstate", syncOpenModels);
    return () => window.removeEventListener("popstate", syncOpenModels);
  }, []);
  const effortByModel = useMemo(
    () => new Map((effortRequest.data?.rows ?? []).map((row) => [row.key, row.summary])),
    [effortRequest.data],
  );
  const effortCombosByModel = useMemo(
    () => new Map(
      (effortRequest.data?.rows ?? []).map((row) => {
        const combos = row.summary.levels
          .filter((level) => level.effort && level.tokens > 0)
          .map((level) => ({ ...comboOf(row.key, level.effort), tokens: level.tokens }))
          .sort((left, right) => right.tokens - left.tokens || left.effort.localeCompare(right.effort));
        return [row.key, combos] as const;
      }),
    ),
    [effortRequest.data],
  );
  const effortBySession = useMemo(
    () => decodeEffortDigest(digestRequest.data),
    [digestRequest.data],
  );
  const max = Math.max(...models.map((model) => model.cost), 1);
  const visibleModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) =>
        `${model.model} ${model.agents.join(" ")}`
          .toLowerCase()
          .includes(normalizedQuery),
      );
    return matches.sort((left, right) => {
      const comparison = left.model.tokens - right.model.tokens;
      return usageOrder === "most" ? -comparison : comparison;
    });
  }, [models, query, usageOrder]);
  useEffect(() => {
    const model = pendingScrollModel.current;
    if (!model) return;
    pendingScrollModel.current = null;
    const timeout = window.setTimeout(() => {
      if (performance.now() - lastUserScrollAt.current < userScrollCancelWindowMs)
        return;
      const card = [
        ...(modelGridRef.current?.querySelectorAll<HTMLElement>(".model-card") ?? []),
      ].find((candidate) => candidate.dataset.modelKey === model);
      if (!card) return;
      const topbarHeight =
        document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().height ?? 72;
      const target = Math.max(
        0,
        window.scrollY + card.getBoundingClientRect().top - topbarHeight - 18,
      );
      if (Math.abs(target - window.scrollY) < 12) return;
      window.scrollTo({
        top: target,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, autoScrollDelayMs);
    return () => window.clearTimeout(timeout);
  }, [openModels]);
  const pageSize = 5;
  const toggleModel = (model: string) => {
    const next = new Set(openModels);
    const opening = !next.has(model);
    if (opening) next.add(model);
    else next.delete(model);
    pendingScrollModel.current = opening ? model : null;
    window.history.pushState(
      { ...window.history.state, view: "models", models: [...next] },
      "",
      modelsHref(next),
    );
    transitionModelGrid(() => setOpenModels(next));
  };
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="MODEL SPECTROGRAPH"
        title="Model mix and efficiency"
        description="Compare API-equivalent cost, output volume, and cache behavior. Warp models contribute recorded tokens, while provider credits stay separate from dollar estimates."
        actions={
          <div className="model-controls">
            <label className="search model-search">
              <Search aria-hidden="true" />
              <span className="sr-only">Filter models</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter models…"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear model filter"
                >
                  Clear
                </button>
              )}
            </label>
            <div className="model-quick-links" aria-label="Model usage order">
              <button
                type="button"
                className={usageOrder === "most" ? "active" : undefined}
                aria-pressed={usageOrder === "most"}
                onClick={() => setUsageOrder("most")}
              >
                <ArrowUpRight aria-hidden="true" /> Most used
              </button>
              <button
                type="button"
                className={usageOrder === "least" ? "active" : undefined}
                aria-pressed={usageOrder === "least"}
                onClick={() => setUsageOrder("least")}
              >
                <ArrowDownRight aria-hidden="true" /> Least used
              </button>
            </div>
            <button type="button" className="secondary-button benchmark-trigger" onClick={() => setBenchmarkModal(true)}>
              <BenchmarkTriggerIcons /> Compare benchmarks
            </button>
          </div>
        }
      />
      {benchmarkModal && <BenchmarkModal onClose={() => setBenchmarkModal(false)} />}
      <section className="model-grid" ref={modelGridRef}>
        {visibleModels.map(({ model, index }) => {
          const warpOnly = model.agents.length > 0 && model.agents.every((agent) => providerKey(agent) === "warp");
          const modelSessions = sessions
            .filter((session) => session.modelsUsed.includes(model.model))
            .sort((left, right) =>
              String(
                right.metadata?.lastActivity ?? right.period,
              ).localeCompare(
                String(left.metadata?.lastActivity ?? left.period),
              ),
            );
          const open = openModels.has(model.model);
          const page = Math.min(
            pages[model.model] ?? 1,
            Math.max(1, Math.ceil(modelSessions.length / pageSize)),
          );
          const pageCount = Math.max(1, Math.ceil(modelSessions.length / pageSize));
          const pageSessions = modelSessions.slice(
            (page - 1) * pageSize,
            page * pageSize,
          );
          const panelId = `model-sessions-${index}`;
          const effortSummary = effortByModel.get(model.model) ?? null;
          const effortCombos = effortCombosByModel.get(model.model) ?? [];
          return (
            <article
              className={`model-card${open ? " model-card--open" : ""}`}
              data-model-key={model.model}
              key={model.model}
            >
              <div className="model-card__head">
                <span style={{ background: palette[index % palette.length] }}>
                  {model.model.startsWith("gpt") ? "G" : "C"}
                </span>
                <div>
                  <h3>{model.model}</h3>
                  <p>{model.agents.join(" · ")}</p>
                </div>
              </div>
              {effortCombos.length > 0 && (
                <div className="model-effort-combos">
                  <span>MODEL × EFFORT</span>
                  <div>
                    {effortCombos.map((combo) => (
                      <ComboPill
                        key={comboKey(combo)}
                        combo={combo}
                        trailing={sharePercent(combo.tokens, effortSummary?.attributedTokens ?? 0)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div className="model-effort-summary">
                <span>Effort</span>
                <EffortState status={statusRequest.data} summary={effortSummary}>
                  {effortSummary && (
                    <>
                      <div>
                        <EffortBadge summary={effortSummary} />
                        <EffortCoverage summary={effortSummary} />
                      </div>
                      <EffortStack summary={effortSummary} height={6} showLegend={false} />
                    </>
                  )}
                </EffortState>
              </div>
              <div className="model-cost">
                <strong className={model.priced ? undefined : "unpriced"}>
                  {model.priced ? formatMoney(model.cost) : "Pricing unavailable"}
                </strong>
                <span>
                  {model.priced ? "API-equivalent" : warpOnly ? "Warp credits separate" : "no rate card in ccusage"}
                </span>
              </div>
              <div className={`meter${model.priced ? "" : " meter--unpriced"}`}>
                <i
                  style={
                    model.priced
                      ? {
                          width: `${(model.cost / max) * 100}%`,
                          background: palette[index % palette.length],
                        }
                      : { width: "100%" }
                  }
                />
              </div>
              <dl>
                <div>
                  <dt>Total tokens</dt>
                  <dd>{formatCompact(model.tokens)}</dd>
                </div>
                <div>
                  <dt>{warpOnly ? "Recorded" : "Output"}</dt>
                  <dd>{formatCompact(warpOnly ? model.tokens : model.outputTokens)}</dd>
                </div>
                <div>
                  <dt>Cache read</dt>
                  <dd>{formatCompact(model.cacheReadTokens)}</dd>
                </div>
                <div>
                  <dt>Cache write</dt>
                  <dd>{formatCompact(model.cacheCreationTokens)}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="model-sessions-toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggleModel(model.model)}
              >
                <span>
                  <b>{modelSessions.length}</b>{" "}
                  {modelSessions.length === 1 ? "session" : "sessions"}
                </span>
                <Plus aria-hidden="true" />
              </button>
              {open && (
                <div className="model-sessions" id={panelId}>
                  {effortSummary && (
                    <section className="model-effort-detail">
                      <div>
                        <span className="overline">TOKEN DISTRIBUTION</span>
                        <EffortStack summary={effortSummary} basis="tokens" height={8} />
                      </div>
                      <div>
                        <span className="overline">OBSERVATION DISTRIBUTION</span>
                        <EffortStack summary={effortSummary} basis="observations" height={8} />
                      </div>
                    </section>
                  )}
                  {pageSessions.length ? (
                    <ol>
                      {pageSessions.map((session) => (
                        <li key={session.sessionId}>
                          <a
                            href={sessionHref(session.sessionId)}
                            onClick={(event) => {
                              if (
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              )
                                return;
                              event.preventDefault();
                              onOpenSession(session.sessionId);
                            }}
                          >
                            <span>
                              <b>
                                {friendlyProject(
                                  session.cwd ?? "Path unavailable",
                                )}
                              </b>
                              <small>
                                {session.metadata?.lastActivity
                                  ? formatDate(session.metadata.lastActivity)
                                  : session.period}
                              </small>
                            </span>
                            <span className="model-session-usage">
                              <b>{formatCompact(session.totalTokens)}</b>
                              <small>{session.source === "warp" ? `${formatWarpCredits(session.warp?.credits ?? 0)} credits` : formatMoney(session.totalCost)}</small>
                            </span>
                            <SessionEffortCell
                              decoded={effortBySession.get(session.sessionId)}
                              enabled={Boolean(statusRequest.data?.enabled)}
                            />
                            <ArrowUpRight aria-hidden="true" />
                          </a>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>No indexed sessions use this model.</p>
                  )}
                  <div className="model-sessions-footer">
                    {modelSessions.length > pageSize && (
                      <div
                        className="model-session-pagination"
                        aria-label={`Session pages for ${model.model}`}
                      >
                        <button
                          type="button"
                          disabled={page === 1}
                          aria-label="Previous session page"
                          onClick={() =>
                            setPages((current) => ({
                              ...current,
                              [model.model]: page - 1,
                            }))
                          }
                        >
                          <ChevronLeft />
                        </button>
                        <PageJump
                          page={page}
                          pages={pageCount}
                          label={`session page for ${model.model}`}
                          onChange={(next) =>
                            setPages((current) => ({
                              ...current,
                              [model.model]: next,
                            }))
                          }
                        />
                        <button
                          type="button"
                          disabled={page === pageCount}
                          aria-label="Next session page"
                          onClick={() =>
                            setPages((current) => ({
                              ...current,
                              [model.model]: page + 1,
                            }))
                          }
                        >
                          <ChevronRight />
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="model-collapse"
                      aria-controls={panelId}
                      onClick={() => toggleModel(model.model)}
                    >
                      <span>Collapse</span>
                      <ChevronUp aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </section>
      {!models.length ? (
        <Empty text="No model usage found in this period." />
      ) : (
        !visibleModels.length && <Empty text="No models match that filter." />
      )}
    </div>
  );
}

const ALLOWANCE_HELP_URL =
  "https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits";
const EXTRA_USAGE_HELP_URL =
  "https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans";

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown";
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function QuotaProvenance({
  data,
  onUpdateWebCredits,
}: {
  data: DashboardData;
  onUpdateWebCredits: () => void;
}) {
  const anthropic = data.quotas.usage?.providers.find(
    (provider) => provider.provider === "anthropic",
  );
  const snapshot = anthropic?.snapshot?.kind === "window" ? anthropic.snapshot : null;
  const credits = anthropic?.anthropicWebCredits ?? null;
  const view = buildAnthropicCreditView(anthropic);
  const history = data.quotas.history;
  if (!data.quotas.available && !credits) return null;
  return (
    <section className="panel provenance">
      <div className="panel-heading">
        <div>
          <span className="overline">QUOTA EVIDENCE</span>
          <h2>Where each allowance value comes from</h2>
        </div>
        <a href={ALLOWANCE_HELP_URL} target="_blank" rel="noreferrer" className="text-link">
          Usage &amp; length limits <ExternalLink />
        </a>
      </div>
      <div className="evidence-groups">
        <article className="evidence-group live">
          <header>
            <span className="source-symbol provider">
              <Gauge />
            </span>
            <div>
              <span className="overline">PROVIDER QUOTA API · LIVE</span>
              <code>api.anthropic.com/api/oauth/usage</code>
            </div>
            <span className={`status-label ${anthropic?.status ?? "unknown"}`}>
              {anthropic?.status ?? "unknown"}
            </span>
          </header>
          <dl className="evidence-facts">
            <div>
              <dt>Captured</dt>
              <dd>{anthropic?.capturedAt ? formatDate(new Date(anthropic.capturedAt).toISOString()) : "—"}</dd>
            </div>
            <div>
              <dt>Data age</dt>
              <dd>{formatDuration(anthropic?.dataAgeMs)}</dd>
            </div>
            {snapshot?.fiveHour && (
              <div>
                <dt>5-hour</dt>
                <dd>{snapshot.fiveHour.usedPercent.toFixed(0)}% used</dd>
              </div>
            )}
            {snapshot?.weekly && (
              <div>
                <dt>Weekly</dt>
                <dd>{snapshot.weekly.usedPercent.toFixed(0)}% used</dd>
              </div>
            )}
            {Object.entries(snapshot?.modelWindows ?? {}).map(([model, window]) => (
              <div key={model}>
                <dt>{model} window</dt>
                <dd>{window.usedPercent.toFixed(0)}% used</dd>
              </div>
            ))}
            {view.usageCredit && (
              <div>
                <dt>Monthly spend</dt>
                <dd>
                  {formatCredit(view.usageCredit.spent, view.usageCredit.currency)}
                  {view.usageCredit.limit !== null
                    ? ` / ${formatCredit(view.usageCredit.limit, view.usageCredit.currency)}`
                    : ""}
                </dd>
              </div>
            )}
          </dl>
          <div className="evidence-actions">
            <a href="/api/quotas" target="_blank" rel="noreferrer" className="text-link">
              Raw normalized quota JSON <ExternalLink />
            </a>
          </div>
          {Array.isArray(snapshot?.extra?.rawLimits) && snapshot!.extra!.rawLimits!.length > 0 && (
            <details className="raw-evidence">
              <summary>Raw provider limits</summary>
              <pre>{JSON.stringify(snapshot!.extra!.rawLimits, null, 2)}</pre>
            </details>
          )}
        </article>

        <article className="evidence-group imported">
          <header>
            <span className="source-symbol budget">
              <CircleDollarSign />
            </span>
            <div>
              <span className="overline">CLAUDE WEB CREDITS · IMPORTED</span>
              <code>claude.ai/api/organizations/…/prepaid/credits</code>
            </div>
            <span className="method-chip budget">
              <i /> user imported
            </span>
          </header>
          <p className="evidence-boundary">
            Claude Code&apos;s OAuth token returns <code>403 account_session_invalid</code> for
            these web-session endpoints, so these values are a timestamped manual
            observation — never live provider data.
          </p>
          {credits ? (
            <>
              <dl className="evidence-facts">
                <div>
                  <dt>Observed</dt>
                  <dd>{formatDate(new Date(credits.capturedAt).toISOString())}</dd>
                </div>
                <div>
                  <dt>Stored</dt>
                  <dd>{formatDate(new Date(credits.updatedAt).toISOString())}</dd>
                </div>
                {view.prepaid && (
                  <div>
                    <dt>Prepaid balance</dt>
                    <dd>{formatCredit(view.prepaid.balance, view.prepaid.currency)}</dd>
                  </div>
                )}
              </dl>
              {view.fable && (
                <div className={`fable-credit${view.fable.expired ? " fable-credit--expired" : ""}`}>
                  <div className="fable-credit__head">
                    <span>
                      <Sparkles /> Fable transition credit
                    </span>
                    {view.fable.expired && <i className="fable-credit__badge">expired</i>}
                  </div>
                  <strong>{formatCredit(view.fable.remaining, view.fable.currency)}</strong>
                  <div className="fable-credit__meta">
                    {view.fable.grant !== null && (
                      <span>of {formatCredit(view.fable.grant, view.fable.currency)} granted</span>
                    )}
                    {view.fable.expiresOn && (
                      <span>
                        {view.fable.expired ? "expired" : "expires"} {view.fable.expiresOn}
                      </span>
                    )}
                    {view.fable.campaignId && <span>{view.fable.campaignId}</span>}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>No Claude Web snapshot imported yet.</p>
          )}
          <div className="evidence-actions">
            <button type="button" className="secondary-button" onClick={onUpdateWebCredits}>
              <RefreshCw /> {credits ? "Update snapshot" : "Import snapshot"}
            </button>
            <a href={CLAUDE_USAGE_URL} target="_blank" rel="noreferrer" className="text-link">
              Claude Settings → Usage <ExternalLink />
            </a>
            <a href={EXTRA_USAGE_HELP_URL} target="_blank" rel="noreferrer" className="text-link">
              Extra usage policy <ExternalLink />
            </a>
          </div>
        </article>

        <article className="evidence-group local">
          <header>
            <span className="source-symbol local">
              <Database />
            </span>
            <div>
              <span className="overline">LOCAL QUOTA HISTORY</span>
              <code>~/.quota-service/quota.db</code>
            </div>
            <span className="method-chip local">
              <i /> locally counted
            </span>
          </header>
          <p>
            Locally observed quota reaches and reset-credit consumption over time.
            This is AIUO&apos;s own record of what was seen, not a provider-authoritative
            ledger — the provider reports only the current window state.
          </p>
          <dl className="evidence-facts">
            <div>
              <dt>Tracking since</dt>
              <dd>
                {history?.trackingSince
                  ? formatDate(new Date(history.trackingSince).toISOString())
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Windows reached</dt>
              <dd>
                {history?.windows.reduce((sum, window) => sum + window.reachedCount, 0) ?? 0}× observed
              </dd>
            </div>
            <div>
              <dt>Resets consumed</dt>
              <dd>{history?.codexBankedResets.usedCount ?? 0}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  );
}

function Sources({
  data,
  onRules,
  onUpdateWebCredits,
  days,
  dateRange,
  agent,
  pathTag,
  showCache,
  facets,
  onFacets,
  onOpenSession,
}: {
  data: DashboardData;
  onRules: () => void;
  onUpdateWebCredits: () => void;
  days: string;
  dateRange: DateRange | null;
  agent: AgentSelection;
  pathTag: string;
  showCache: boolean;
  facets: DataFacets;
  onFacets: (next: Partial<DataFacets>) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const warpDays = data.warp.daily.filter((day) => day.credits > 0 || day.sessions > 0);
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="USAGE INTELLIGENCE & PROVENANCE"
        title="Usage intelligence & provenance."
        description="Local activity and provider allowances remain explicitly separate."
        actions={
          <button className="secondary-button" onClick={onRules}>
            <Tag /> Path rules
          </button>
        }
      />
      <UsageIntelligence
        data={data}
        days={days}
        dateRange={dateRange}
        agent={agent}
        pathTag={pathTag}
        showCache={showCache}
        facets={facets}
        onFacets={onFacets}
        onOpenSession={onOpenSession}
      />
      <section className="sources-grid">
        <article className="panel distinction">
          <span className="source-symbol provider">
            <Gauge />
          </span>
          <span className="overline">PROVIDER QUOTA</span>
          <h2>{data.quotas.available ? "Connected" : "Not connected"}</h2>
          <p>
            {data.quotas.available
              ? "Authoritative allowance data from quota-service."
              : "quota-service is optional and currently unavailable. Analytics continue normally."}
          </p>
          <span className="method-chip">
            <i /> provider reported
          </span>
        </article>
        <article className="panel distinction">
          <span className="source-symbol local">
            <Clock3 />
          </span>
          <span className="overline">LOCAL ACTIVITY BLOCK</span>
          <h2>
            {data.blocks.find((b) => b.isActive)
              ? "Active window"
              : "Recent window"}
          </h2>
          <p>Reconstructed by ccusage from local {data.blockScope} records.</p>
          <span className="method-chip local">
            <i /> locally calculated
          </span>
        </article>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="overline">DATA SOURCE HEALTH</span>
            <h2>Collection boundaries</h2>
          </div>
          <span>Updated {formatDate(data.collectedAt, data.timeZone)} · {data.timeZone} calendar</span>
        </div>
        <div className="source-list">
          {data.sources.map((source) => (
            <div key={source.name}>
              <span className={`status-dot ${source.status}`} />
              <div>
                <b>{source.name}</b>
                <small>{source.kind}</small>
              </div>
              <p>{source.detail}</p>
              <span className={`status-label ${source.status}`}>
                {source.status}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="panel warp-ledger-panel">
        <div className="panel-heading">
          <div>
            <span className="overline">WARP LOCAL LEDGER</span>
            <h2>Credits beyond the countdown</h2>
            <p>Conversation snapshots, model/token metadata, tool categories, and credit burn gathered from Warp’s local SQLite database.</p>
          </div>
          <span className={`status-label ${data.warp.available ? "healthy" : "unavailable"}`}>
            {data.warp.available ? "read-only" : "unavailable"}
          </span>
        </div>
        {data.warp.available ? (
          <>
            <div className="warp-ledger-stats">
              <div><span>Conversation snapshots</span><b>{data.warp.sessionCount}</b></div>
              <div><span>Recorded credits</span><b>{formatWarpCredits(data.warp.totals.credits)}</b></div>
              <div><span>Query coverage</span><b>{Math.round(data.warp.queryCoverage * 100)}%</b></div>
              <div><span>Last observed</span><b>{formatDate(data.warp.observedAt)}</b></div>
            </div>
            {warpDays.length ? (
              <div className="warp-credit-chart" role="img" aria-label="Warp credits recorded by day">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={warpDays} margin={{ top: 12, right: 12, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="warpCreditsArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--warp-color)" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="var(--warp-color)" stopOpacity={0.08} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} tick={{ fill: "#71807b", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis tickFormatter={formatCompact} tick={{ fill: "#71807b", fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip
                      cursor={{ stroke: "#71807b", strokeDasharray: "3 3" }}
                      contentStyle={{ background: "#0c1715", border: "1px solid #30413c", borderRadius: 8 }}
                      labelFormatter={(value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })}
                      formatter={(value) => [`${formatWarpCredits(Number(value))} credits`, "Warp"]}
                    />
                    <Area type="monotone" dataKey="credits" name="Warp credits" stroke="var(--warp-color)" strokeWidth={2} fill="url(#warpCreditsArea)" activeDot={{ r: 4, fill: "#07100f", stroke: "var(--warp-color)", strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : <Empty text="No credit observations are available yet." />}
            <p className="warp-machine-note"><Database /> Warp data is machine-specific. It comes from <code>{data.warp.sourceFile ?? "Warp's local database"}</code>, reflects this computer’s stored conversation snapshots, and is not a complete account-wide ledger across other devices. The app reads it read-only and imports no prompts, responses, command text, or transcript contents.</p>
          </>
        ) : (
          <p className="scope-note"><Database /> {data.warp.error ?? "Warp’s local database is unavailable on this machine."}</p>
        )}
      </section>
      <QuotaProvenance data={data} onUpdateWebCredits={onUpdateWebCredits} />
    </div>
  );
}

const sceneEffectOptions: {
  key: "starfield" | "parallax" | "twinkle" | "tesseract";
  label: string;
  detail: string;
}[] = [
  {
    key: "starfield",
    label: "Starfield",
    detail: "Generative star field behind the content on every view",
  },
  {
    key: "parallax",
    label: "Depth parallax",
    detail: "Stars at different distances drift at different rates",
  },
  {
    key: "twinkle",
    label: "Twinkle & tint",
    detail: "Star flicker with accent and aqua tinted highlights",
  },
  {
    key: "tesseract",
    label: "Tesseract core",
    detail:
      "Replace the telescope icon with a 4D hypercube that contorts as the scene rotates, and use it on the loading screen",
  },
];
const starDensityLabels = [
  "",
  "Minimal",
  "Sparse",
  "Balanced",
  "Dense",
  "Dark Sky",
  "Oh My!",
];
const unchangedDismissals = [
  "fine, leaving it as is then",
  "nothing then? cool",
  "maybe next time?",
  "later",
];
const changedDismissals = ["Gotcha!", "You Got It", "Done"];
const maxDismissals = ["Nice!!", "Oh, I see!", "Oh, its like that?"];
const minDismissals = ["Chillin", "ok then"];

function randomDismissal(options: string[]) {
  return options[Math.floor(Math.random() * options.length)];
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return (
    <label className="appearance-color-setting">
      <span>{label}</span>
      <div className="accent-control">
        <input
          aria-label={`${label} color`}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <code>{value.toUpperCase()}</code>
        <button
          type="button"
          className="accent-copy-button"
          onClick={() => void copy()}
          aria-label={
            copied
              ? `${label} color copied`
              : `Copy ${label.toLowerCase()} color`
          }
          title={copied ? "Copied" : "Copy color"}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
    </label>
  );
}

function AppearanceModal({
  accent,
  onChange,
  providerColors,
  onProviderColorsChange,
  favoriteAccents,
  onFavoriteAccentsChange,
  dataTextScale,
  onDataTextScaleChange,
  sceneEffects,
  onSceneEffectsChange,
  reducedMotion,
  onReset,
  onClose,
}: {
  accent: string;
  onChange: (value: string) => void;
  providerColors: ProviderColors;
  onProviderColorsChange: (value: ProviderColors) => void;
  favoriteAccents: string[];
  onFavoriteAccentsChange: (value: string[]) => void;
  dataTextScale: number;
  onDataTextScaleChange: (value: number) => void;
  sceneEffects: SceneEffects;
  onSceneEffectsChange: (value: SceneEffects) => void;
  reducedMotion: boolean;
  onReset: () => void;
  onClose: () => void;
}) {
  const [editingFavorites, setEditingFavorites] = useState(false);
  const [dismissal, setDismissal] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const initial = useRef({
    accent,
    providerColors: { ...providerColors },
    favoriteAccents: [...favoriteAccents],
    dataTextScale,
    sceneEffects: { ...sceneEffects },
  });
  const starting = initial.current;
  const changeCount =
    Number(accent !== starting.accent) +
    Number(providerColors.anthropic !== starting.providerColors.anthropic) +
    Number(providerColors.openai !== starting.providerColors.openai) +
    Number(providerColors.warp !== starting.providerColors.warp) +
    Number(
      favoriteAccents.length !== starting.favoriteAccents.length ||
        favoriteAccents.some(
          (color, index) => color !== starting.favoriteAccents[index],
        ),
    ) +
    Number(dataTextScale !== starting.dataTextScale) +
    Object.keys(starting.sceneEffects).reduce(
      (count, key) =>
        count +
        Number(
          sceneEffects[key as keyof SceneEffects] !==
            starting.sceneEffects[key as keyof SceneEffects],
        ),
      0,
    );
  const revertChanges = () => {
    onChange(starting.accent);
    onProviderColorsChange({ ...starting.providerColors });
    onFavoriteAccentsChange([...starting.favoriteAccents]);
    onDataTextScaleChange(starting.dataTextScale);
    onSceneEffectsChange({ ...starting.sceneEffects });
    setEditingFavorites(false);
  };
  const replaceFavorite = (index: number) => {
    onFavoriteAccentsChange(
      favoriteAccents.map((color, colorIndex) =>
        colorIndex === index ? accent : color,
      ),
    );
    setEditingFavorites(false);
  };
  const dismiss = useCallback(() => {
    if (dismissal) return;
    const setToMax =
      (sceneEffects.speed !== starting.sceneEffects.speed &&
        sceneEffects.speed === 3) ||
      (sceneEffects.starDensity !== starting.sceneEffects.starDensity &&
        sceneEffects.starDensity === 6);
    const setToMin =
      (sceneEffects.speed !== starting.sceneEffects.speed &&
        sceneEffects.speed === 0.1) ||
      (sceneEffects.starDensity !== starting.sceneEffects.starDensity &&
        sceneEffects.starDensity === 1);
    const options = changeCount === 0
      ? unchangedDismissals
      : setToMax
        ? maxDismissals
        : setToMin
          ? minDismissals
          : changedDismissals;
    setDismissal(randomDismissal(options));
    closeTimer.current = window.setTimeout(onClose, 2050);
  }, [
    accent,
    changeCount,
    dataTextScale,
    dismissal,
    favoriteAccents,
    onClose,
    providerColors,
    sceneEffects,
  ]);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const dialogRef = useModalFocusTrap(dismiss);

  return (
    <div
      className={`modal-backdrop appearance-backdrop${dismissal ? " modal-backdrop--dismissing" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal appearance-modal${dismissal ? " appearance-modal--dismissing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="appearance-modal-title"
        tabIndex={-1}
      >
        <div className="appearance-content">
          <button
            className="modal-close"
            onClick={dismiss}
            aria-label="Close appearance settings"
          >
            <X />
          </button>
          <span className="overline">LOCAL APPEARANCE</span>
          <h2 id="appearance-modal-title">Appearance</h2>
          <p>
            Adjust visual signals and data readability. These preferences stay
            on this device.
          </p>
          <span className="appearance-label">Signal colors</span>
          <div className="appearance-color-grid">
            <ColorControl label="Accent" value={accent} onChange={onChange} />
            <ColorControl
              label="Anthropic"
              value={providerColors.anthropic}
              onChange={(value) =>
                onProviderColorsChange({ ...providerColors, anthropic: value })
              }
            />
            <ColorControl
              label="OpenAI"
              value={providerColors.openai}
              onChange={(value) =>
                onProviderColorsChange({ ...providerColors, openai: value })
              }
            />
            <ColorControl
              label="Warp"
              value={providerColors.warp}
              onChange={(value) =>
                onProviderColorsChange({ ...providerColors, warp: value })
              }
            />
          </div>
          <p className="signal-color-note">
            Provider colors identify quota headroom across satellites, charts,
            and limit cards.
          </p>
          <div
            className={`accent-favorites${editingFavorites ? " editing" : ""}`}
            aria-label="Favorite accent colors"
          >
            {favoriteAccents.map((color, index) => (
              <button
                type="button"
                key={`${color}-${index}`}
                className={
                  accent.toLowerCase() === color.toLowerCase() ? "selected" : ""
                }
                style={{ backgroundColor: color }}
                aria-label={
                  editingFavorites
                    ? `Replace ${color} with ${accent}`
                    : `Use ${color} accent`
                }
                aria-pressed={
                  !editingFavorites &&
                  accent.toLowerCase() === color.toLowerCase()
                }
                onClick={() =>
                  editingFavorites ? replaceFavorite(index) : onChange(color)
                }
              >
                {editingFavorites ? <PencilLine /> : <Check />}
              </button>
            ))}
            <button
              type="button"
              className="accent-favorite-edit"
              onClick={() => setEditingFavorites((editing) => !editing)}
              aria-label={
                editingFavorites
                  ? "Finish editing favorite colors"
                  : "Edit favorite colors"
              }
              aria-pressed={editingFavorites}
              title={editingFavorites ? "Done editing" : "Edit favorites"}
            >
              <PencilLine />
            </button>
          </div>
          {editingFavorites && (
            <div className="accent-favorite-editor">
              <p>
                Pick a new color above, then choose the favorite chip to
                replace.
              </p>
              <button
                type="button"
                onClick={() => {
                  onFavoriteAccentsChange(defaultFavoriteAccents);
                  setEditingFavorites(false);
                }}
              >
                <RotateCcw /> Reset favorites
              </button>
            </div>
          )}
          <div className="data-text-setting">
            <div>
              <b>Data text size</b>
              <small>Tables and dense data rows across every view</small>
            </div>
            <div className="data-text-control">
              <button
                type="button"
                onClick={() =>
                  onDataTextScaleChange(Math.max(90, dataTextScale - 10))
                }
                disabled={dataTextScale <= 90}
                aria-label="Decrease data text size"
              >
                −
              </button>
              <output aria-live="polite">{dataTextScale}%</output>
              <button
                type="button"
                onClick={() =>
                  onDataTextScaleChange(Math.min(250, dataTextScale + 10))
                }
                disabled={dataTextScale >= 250}
                aria-label="Increase data text size"
              >
                +
              </button>
            </div>
          </div>
          <div className="scene-effects">
            <span className="appearance-label">Observatory scene effects</span>
            {sceneEffectOptions.map((option) => {
              const systemSuppressed =
                option.key === "starfield" &&
                reducedMotion &&
                sceneEffects.starfield;
              return (
                <div className="effect-row" key={option.key}>
                  <div>
                    <b>{option.label}</b>
                    <small>{option.detail}</small>
                    {systemSuppressed && (
                      <small className="system-motion-note">
                        Off because Reduce Motion is enabled in system settings.
                      </small>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    className="effect-switch"
                    aria-checked={
                      systemSuppressed ? false : sceneEffects[option.key]
                    }
                    aria-label={option.label}
                    onClick={() =>
                      onSceneEffectsChange({
                        ...sceneEffects,
                        [option.key]: !sceneEffects[option.key],
                      })
                    }
                  />
                </div>
              );
            })}
            <div className="effect-row">
              <div>
                <b>Star density</b>
                <small>
                  Six fixed levels, from a visible floor to extreme depth
                </small>
              </div>
              <div className="speed-control density-control">
                <input
                  type="range"
                  min={1}
                  max={6}
                  step={1}
                  value={sceneEffects.starDensity}
                  disabled={!sceneEffects.starfield || reducedMotion}
                  aria-label="Star density"
                  aria-valuetext={starDensityLabels[sceneEffects.starDensity]}
                  onChange={(event) =>
                    onSceneEffectsChange({
                      ...sceneEffects,
                      starDensity: Number(event.target.value),
                    })
                  }
                />
                <output aria-live="polite">
                  {starDensityLabels[sceneEffects.starDensity]}
                </output>
              </div>
            </div>
            <div className="effect-row">
              <div>
                <b>Animation speed</b>
                <small>Rate of auto-rotation, orbits, and twinkle</small>
              </div>
              <div className="speed-control">
                <input
                  type="range"
                  min={0.1}
                  max={3}
                  step={0.05}
                  value={sceneEffects.speed}
                  aria-label="Animation speed"
                  onChange={(event) =>
                    onSceneEffectsChange({
                      ...sceneEffects,
                      speed: Number(event.target.value),
                    })
                  }
                />
                <output aria-live="polite">
                  {sceneEffects.speed.toFixed(2)}x
                </output>
              </div>
            </div>
            <small>
              Motion effects pause automatically when your system prefers
              reduced motion.
            </small>
          </div>
          <div className="appearance-change-trail" aria-live="polite">
            <span>
              {changeCount === 0
                ? "No changes yet"
                : changeCount === 1
                  ? "1 change will apply when you close this"
                  : `${changeCount} changes will apply when you close this`}
            </span>
            {changeCount > 0 && (
              <button type="button" onClick={revertChanges}>
                Revert changes
              </button>
            )}
          </div>
          <button
            type="button"
            className="reset-appearance"
            onClick={() => {
              onReset();
              setEditingFavorites(false);
            }}
          >
            <RotateCcw /> Reset all appearance settings
          </button>
        </div>
      </div>
      {dismissal && (
        <div
          className={`appearance-dismissal${maxDismissals.includes(dismissal) ? " appearance-dismissal--max" : ""}`}
          role="status"
        >
          <h2>{dismissal}</h2>
        </div>
      )}
    </div>
  );
}

function AnnotationModal({
  session,
  onClose,
  onSaved,
}: {
  session: Session;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(session.annotation.note);
  const [tags, setTags] = useState(session.annotation.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const dirty =
    note !== session.annotation.note ||
    tags !== session.annotation.tags.join(", ");
  const requestClose = useCallback(() => {
    if (
      !dirty ||
      window.confirm("Discard your unsaved annotation changes?")
    ) {
      onClose();
    }
  }, [dirty, onClose]);
  const dialogRef = useModalFocusTrap(requestClose);
  const save = async () => {
    setSaving(true);
    await fetch(
      `/api/sessions/${encodeURIComponent(session.sessionId)}/annotations`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      },
    );
    setSaving(false);
    onSaved();
    onClose();
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="annotation-modal-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal-close"
          onClick={requestClose}
          aria-label="Close annotation editor"
        >
          <X />
        </button>
        <span className="overline">LOCAL ANNOTATION</span>
        <h2 id="annotation-modal-title">Mark this session</h2>
        <p>
          {session.modelsUsed.join(", ")} · {formatCompact(session.totalTokens)}{" "}
          tokens
        </p>
        <label>
          Tags
          <input
            autoFocus
            data-autofocus
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="feature, research, client-work"
          />
          <small>
            Comma separated. Manual tags remain distinct from derived path tags.
          </small>
        </label>
        <label>
          Notes
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was this session about?"
            rows={5}
          />
        </label>
        <button className="primary-button" onClick={save} disabled={saving}>
          {saving ? <RefreshCw className="spin" /> : <Check />} Save annotation
        </button>
      </div>
    </div>
  );
}

function numField(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
function dateField(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "" : new Date(ms).toISOString().slice(0, 10);
}

/** Compact form for the user-imported Claude Web credit snapshot. Prefills from
 * the current observation, submits to AIUO's localhost proxy (never to Claude
 * directly, never with cookies), and refreshes on success. A failed submit
 * keeps the entered values and shows an inline error. */
function AnthropicWebImportModal({
  credits,
  onClose,
  onSaved,
}: {
  credits: AnthropicWebCredits | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tranche = credits?.promotionalTranches?.[0] ?? null;
  const [currentBalance, setCurrentBalance] = useState(numField(credits?.currentBalance));
  const [promoRemaining, setPromoRemaining] = useState(numField(tranche?.remainingAmount));
  const [promoGranted, setPromoGranted] = useState(
    numField(tranche?.grantedAmount ?? credits?.campaign?.amount),
  );
  const [promoExpiresAt, setPromoExpiresAt] = useState(
    tranche?.expiresOn ?? credits?.campaign?.expiresOn ?? credits?.nextExpiresOn ?? "",
  );
  const [capturedAt, setCapturedAt] = useState(
    dateField(credits?.capturedAt) || new Date().toISOString().slice(0, 10),
  );
  const [campaignId, setCampaignId] = useState(credits?.campaign?.id ?? "fable_transition");
  const [campaignGranted, setCampaignGranted] = useState(credits?.campaign?.granted ?? false);
  const [autoReloadEnabled, setAutoReloadEnabled] = useState(credits?.autoReloadEnabled ?? false);
  const [purchasedThisMonth, setPurchasedThisMonth] = useState(
    numField(credits?.purchases?.purchasedThisMonthAmount),
  );
  const [monthlyCap, setMonthlyCap] = useState(numField(credits?.purchases?.monthlyCapAmount));
  const [purchasesResetAt, setPurchasesResetAt] = useState(dateField(credits?.purchases?.resetsAt));
  const [maxDiscount, setMaxDiscount] = useState(numField(credits?.purchases?.maxDiscountPercent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalFocusTrap(onClose);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/quotas/anthropic-web-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capturedAt: capturedAt || undefined,
          currency: "USD",
          currentBalance: currentBalance,
          promoRemaining,
          promoGranted,
          promoExpiresAt,
          campaignId: campaignId.trim() || null,
          campaignGranted,
          autoReloadEnabled,
          purchasedThisMonthAmount: purchasedThisMonth,
          monthlyCapAmount: monthlyCap,
          purchasesResetAt,
          maxDiscountPercent: maxDiscount,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Import failed (${response.status})`);
      }
      onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal web-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-import-title"
        tabIndex={-1}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close credit import">
          <X />
        </button>
        <span className="overline">CLAUDE WEB IMPORT</span>
        <h2 id="web-import-title">Update Claude Web snapshot</h2>
        <p>
          Claude Code&apos;s login can&apos;t read prepaid balances. Copy the values from
          Claude Settings → Usage. Nothing here touches your browser session.
        </p>
        <a
          className="secondary-button web-import-open"
          href={CLAUDE_USAGE_URL}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink /> Open Claude Usage
        </a>
        <div className="web-import-grid">
          <label>
            Current balance
            <input
              autoFocus
              data-autofocus
              type="number"
              step="0.01"
              min="0"
              value={currentBalance}
              onChange={(e) => setCurrentBalance(e.target.value)}
              placeholder="84.97"
            />
          </label>
          <label>
            Fable remaining
            <input
              type="number"
              step="0.01"
              min="0"
              value={promoRemaining}
              onChange={(e) => setPromoRemaining(e.target.value)}
              placeholder="84.96"
            />
          </label>
          <label>
            Original Fable grant
            <input
              type="number"
              step="0.01"
              min="0"
              value={promoGranted}
              onChange={(e) => setPromoGranted(e.target.value)}
              placeholder="100.00"
            />
          </label>
          <label>
            Fable expiry
            <input
              type="date"
              value={promoExpiresAt}
              onChange={(e) => setPromoExpiresAt(e.target.value)}
            />
          </label>
        </div>
        <details className="web-import-more">
          <summary>More details</summary>
          <div className="web-import-grid">
            <label>
              Observed on
              <input type="date" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} />
            </label>
            <label>
              Campaign
              <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            </label>
            <label>
              Purchased this month
              <input
                type="number"
                step="0.01"
                min="0"
                value={purchasedThisMonth}
                onChange={(e) => setPurchasedThisMonth(e.target.value)}
              />
            </label>
            <label>
              Monthly purchase cap
              <input
                type="number"
                step="0.01"
                min="0"
                value={monthlyCap}
                onChange={(e) => setMonthlyCap(e.target.value)}
              />
            </label>
            <label>
              Purchase cap resets
              <input
                type="date"
                value={purchasesResetAt}
                onChange={(e) => setPurchasesResetAt(e.target.value)}
              />
            </label>
            <label>
              Max bundle discount %
              <input
                type="number"
                step="1"
                min="0"
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
              />
            </label>
          </div>
          <div className="web-import-toggles">
            <label className="web-import-check">
              <input
                type="checkbox"
                checked={campaignGranted}
                onChange={(e) => setCampaignGranted(e.target.checked)}
              />
              Campaign granted
            </label>
            <label className="web-import-check">
              <input
                type="checkbox"
                checked={autoReloadEnabled}
                onChange={(e) => setAutoReloadEnabled(e.target.checked)}
              />
              Auto-reload on
            </label>
          </div>
        </details>
        {error && <p className="web-import-error" role="alert">{error}</p>}
        <button className="primary-button" onClick={submit} disabled={saving}>
          {saving ? <RefreshCw className="spin" /> : <Check />} Save snapshot
        </button>
      </div>
    </div>
  );
}

const BENCHMARK_SITES = [
  {
    id: "deepswe",
    label: "DeepSWE",
    url: "https://deepswe.datacurve.ai/#leaderboard",
    favicon: "https://deepswe.datacurve.ai/favicon.ico",
    description: "Cost-vs-performance leaderboard across coding agents — the primary reference for this comparison.",
  },
  {
    id: "artificialanalysis",
    label: "Artificial Analysis",
    url: "https://artificialanalysis.ai/",
    favicon: "https://artificialanalysis.ai/favicon.ico",
    description: "Broader model metrics: quality, speed, latency, and price across providers.",
  },
] as const;
type BenchmarkSiteId = (typeof BENCHMARK_SITES)[number]["id"];

function BenchmarkTriggerIcons({ className }: { className?: string }) {
  return (
    <span className={className ? `benchmark-trigger-icons ${className}` : "benchmark-trigger-icons"}>
      {BENCHMARK_SITES.map((entry) => (
        <img
          key={entry.id}
          className={`benchmark-favicon benchmark-favicon--${entry.id}`}
          src={entry.favicon}
          alt=""
          loading="lazy"
        />
      ))}
    </span>
  );
}

function BenchmarkSplitLauncher({ onOpen }: { onOpen: (siteId: BenchmarkSiteId) => void }) {
  return (
    <div className="benchmark-split-pill" aria-label="Open benchmark comparison">
      {BENCHMARK_SITES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onOpen(entry.id)}
          aria-label={`Open ${entry.label} benchmark`}
          title={entry.label}
        >
          <img className={`benchmark-favicon benchmark-favicon--${entry.id}`} src={entry.favicon} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function BenchmarkModal({ onClose, initialSiteId }: { onClose: () => void; initialSiteId?: BenchmarkSiteId }) {
  const dialogRef = useModalFocusTrap(onClose);
  const [siteId, setSiteId] = useState<BenchmarkSiteId>(initialSiteId ?? "deepswe");
  const site = BENCHMARK_SITES.find((entry) => entry.id === siteId) ?? BENCHMARK_SITES[0];
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal benchmark-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="benchmark-title"
        tabIndex={-1}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close benchmark comparison">
          <X />
        </button>
        <span className="overline">EXTERNAL BENCHMARKS</span>
        <h2 id="benchmark-title">Compare cost and efficiency</h2>
        <div className="benchmark-tabs" role="tablist">
          {BENCHMARK_SITES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === siteId}
              className={entry.id === siteId ? "active" : ""}
              onClick={() => setSiteId(entry.id)}
            >
              <img className={`benchmark-favicon benchmark-favicon--${entry.id}`} src={entry.favicon} alt="" loading="lazy" />
              {entry.label}
            </button>
          ))}
        </div>
        <div className="benchmark-toolbar">
          <p>{site.description}</p>
          <a className="secondary-button" href={site.url} target="_blank" rel="noreferrer">
            <ExternalLink /> Open in new tab
          </a>
        </div>
        <div className="benchmark-frame">
          <iframe key={site.id} src={site.url} title={site.label} loading="lazy" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RulesModal({
  data,
  onClose,
  onSaved,
}: {
  data: DashboardData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tag, setTag] = useState("");
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<"glob" | "regex">("glob");
  const add = async () => {
    if (!tag || !pattern) return;
    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, pattern, kind }),
    });
    setTag("");
    setPattern("");
    onSaved();
  };
  const remove = async (id: number) => {
    await fetch(`/api/rules/${id}`, { method: "DELETE" });
    onSaved();
  };
  const dialogRef = useModalFocusTrap(onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal rules-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-modal-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close path rules"
        >
          <X />
        </button>
        <span className="overline">DERIVED METADATA</span>
        <h2 id="rules-modal-title">Working-directory rules</h2>
        <p>
          Rules are re-evaluated over indexed paths. Only path strings are
          stored; transcript content is never copied.
        </p>
        <div className="rules-list">
          {data.rules.map((rule) => (
            <div key={rule.id}>
              <Tag />
              <span>
                <b>{rule.tag}</b>
                <small>
                  {rule.kind} · {rule.pattern}
                </small>
              </span>
              <button
                onClick={() => remove(rule.id)}
                aria-label={`Delete ${rule.tag}`}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
        <div className="rule-form">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Tag name"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "glob" | "regex")}
          >
            <option value="glob">Glob</option>
            <option value="regex">Regex</option>
          </select>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="**/project-worktree*"
          />
          <button className="primary-button" onClick={add}>
            <Tag /> Add rule
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { data: collectedData, error, loading, load } = useDashboard();
  const [showCache, setShowCache] = useState(true);
  const [dataFacets, setDataFacets] = useState<DataFacets>({
    outliers: "all",
    finding: "all",
    effort: "all",
  });
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
  const [agent, setAgent] = useState<AgentSelection>([]);
  const [days, setDays] = useState<MetricRange>("30");
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const [pathTag, setPathTag] = useState("all");
  const [metric, setMetric] = useState<Metric>("totalTokens");
  const [sidebar, setSidebar] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(savedSidebarCollapsed);
  const sidebarHoverTimeout = useRef<number | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [rules, setRules] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [webImport, setWebImport] = useState(false);
  const [benchmarkSite, setBenchmarkSite] = useState<BenchmarkSiteId | null>(null);
  const [accent, setAccent] = useState(savedAccent);
  const [providerColors, setProviderColors] =
    useState<ProviderColors>(savedProviderColors);
  const [favoriteAccents, setFavoriteAccents] = useState(savedFavoriteAccents);
  const [dataTextScale, setDataTextScale] = useState(savedDataTextScale);
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
  useEffect(() => {
    const navigate = () => {
      convertLegacyViewUrl();
      setView(initialView());
      setFocusSessionId(initialSessionId());
    };
    convertLegacyViewUrl();
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);
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
      .filter((branch) => branch.models.length > 0)
      .map((branch) => ({
        label: branch.agent,
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
  const resetAppearance = () => {
    setAccent(defaultAccent);
    setProviderColors(defaultProviderColors);
    setFavoriteAccents(defaultFavoriteAccents);
    setDataTextScale(defaultDataTextScale);
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
  const pricingIncomplete = Boolean(data.unpricedModels?.length);
  const sideStatusLabel = pricingIncomplete
    ? "Cost data incomplete"
    : "Local systems nominal";
  return (
    <SceneEffectsContext.Provider value={sceneEffects}>
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className={sidebar ? "open" : ""}>
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
          data-tooltip={`${sideStatusLabel} — ccusage v${data.ccusageVersion}`}
          aria-label={`${sideStatusLabel}, ccusage version ${data.ccusageVersion}`}
          tabIndex={sidebarCollapsed ? 0 : undefined}
        >
          <span
            className={`status-dot ${pricingIncomplete ? "degraded" : "healthy"}`}
          />
          <div>
            <b>{sideStatusLabel}</b>
            <small>ccusage v{data.ccusageVersion}</small>
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
          <button className="menu-button" onClick={() => setSidebar(true)}>
            <Menu />
          </button>
          <div className="breadcrumbs">
            <button type="button" onClick={() => navigateToView("overview")}>
              AI Usage Observatory
            </button>
            <ChevronRight />
            <b>{current.label}</b>
          </div>
          <div className="global-controls">
            <BenchmarkSplitLauncher onOpen={setBenchmarkSite} />
            {/* A div, not a label: the popover contains its own checkboxes, and a wrapping
                label would forward stray clicks into the first of them. */}
            {view !== "models" && view !== "projects" && (
              <div className="global-filter global-filter--agent">
                <span>Agent</span>
                <AgentFilter
                  selection={agent}
                  onChange={setAgent}
                  groups={agentFilterGroups}
                />
              </div>
            )}
            {view !== "models" && view !== "projects" && (
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
            {view !== "overview" && (
              <TimeRangeControl
                value={days}
                customRange={customRange}
                availableRange={availableRange}
                resolvedRange={resolvedRange}
                onChange={changeTimeRange}
              />
            )}
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
          {view === "overview" && (
            <Overview
              data={data}
              daily={daily}
              sessions={datedSessions}
              agent={agent}
              pathTag={pathTag}
              metricRange={days}
              customRange={customRange}
              dateRange={activeDateRange}
              availableRange={availableRange}
              onMetricRangeChange={changeTimeRange}
              onOpenSession={openSession}
              onTagSession={setSession}
              onUpdateWebCredits={() => setWebImport(true)}
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
              onEdit={setSession}
              focusSessionId={focusSessionId}
              focusOutsideRange={Boolean(
                focusSessionId && !datedSessions.some((session) => session.sessionId === focusSessionId),
              )}
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
              onOpenSession={openSession}
            />
          )}
          {view === "models" && (
            <Models
              data={data}
              daily={rangeRows}
              sessions={rangeSessions}
              dateRange={activeDateRange}
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
                setDataFacets((current) => ({ ...current, ...next }))
              }
              onOpenSession={openSession}
            />
          )}
          </div>
        </ChartPinProvider>
        <InformationSources data={data} />
      </main>
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
          onClose={() => setBenchmarkSite(null)}
        />
      )}
      {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
    </div>
    </SceneEffectsContext.Provider>
  );
}
