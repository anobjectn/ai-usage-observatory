import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { systemTimeZone } from "../reporting-time";
import { EffortBadge, EffortCoverage, EffortStack, EffortState } from "../components/effort";
import { PageJump } from "../components/page-jump";
import {
  TokenTypeTable,
  TokenTypesByModel,
  TokenTypesNotice,
  cacheHiddenNotice,
  warpOnlyNotice,
} from "../components/token-types";
import { summarizeTokenTypes } from "../token-types";
import type { RateCardSummary } from "../types";
import {
  useEffortAggregate,
  useEffortRefreshOnIndexChange,
  useEffortStatus,
  type EffortScopeInput,
} from "../hooks/use-effort";
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText, Search, Plus, X } from "lucide-react";
import { mergeEffortSummaries, mergeProjectSummaries, type GroupedProjectSummary } from "../project-grouping";
import { Bar, BarChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type {
  DashboardData,
  EffortSummary,
  MetricRow,
  ProjectActivity,
  Session,
  SessionDetail,
} from "../types";
import { dailyQuotaMarkers, quotaMarkersAt, type QuotaMarker } from "../quota-markers";
import { Empty, PageTitle } from "./chrome";
import { filterEmptyMessage } from "../filter-summary";
import { type DateRange, type MetricRange } from "../time-range";
import { ChartTooltipContext, PinnableChartTooltip, useChartTooltipHold } from "../components/chart-pins";
import { chartTooltipDateLabel } from "../chart-pins";
import {
  sessionHref,
  type ProjectSummary,
  type ProjectSessionDetail,
  palette,
  useUserScrollIntent,
  userScrollCancelWindowMs,
  autoScrollDelayMs,
} from "../app/preferences";
import {
  formatCompact,
  formatMoney,
  providerSeries,
  friendlyProject,
  ActivityAxisTick,
  formatWarpCredits,
  DateStamp,
} from "../app/format";
import {
  projectDayRows,
  type ProjectModelSessionRow,
  sessionRangeLabel,
  formatSessionStamp,
  type ModelSortKey,
  projectTrendRowsInRange,
  projectModelSessionRows,
  projectSummaryInRange,
} from "../app/analytics";
import {
  type ChartTooltipProps,
  useClampedTooltip,
  QuotaReachNotes,
  TooltipModelTail,
  QuotaMarkerLegend,
  chartTooltipWrapperStyle,
  QuotaReferenceLines,
  EffortByDay,
  timeEffortScope,
} from "../components/activity-charts";

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
      interactive={hold.interactive}
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
            <TooltipModelTail
              models={providerActivity.models
                .slice(visibleModels.length)
                .map((model) => ({ ...model, name: model.model }))}
              listClassName="tooltip-provider-models"
              className="tooltip-model-more"
            />
          </section>
        );
      })}
    </PinnableChartTooltip>
  );
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
  rateCard,
  unpricedModels,
  showCache,
  effortSummary,
  effortIndexEnabled,
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
  rateCard: RateCardSummary;
  unpricedModels: string[];
  showCache: boolean;
  effortSummary: EffortSummary | null;
  effortIndexEnabled?: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  type ModelSortKey = "name" | "tokens" | "cost";
  // The in-range sessions already cover every grouped member path, and each session row carries
  // its own per-model ccusage cost, so the project table is a sum of validated per-model parts.
  const tokenTypeInputs = useMemo(
    () => sessions.flatMap((session) => session.modelBreakdowns.map((breakdown) => ({ agent: session.agent, breakdown }))),
    [sessions],
  );
  const tokenTypes = useMemo(
    () => summarizeTokenTypes(tokenTypeInputs, rateCard, unpricedModels),
    [tokenTypeInputs, rateCard, unpricedModels],
  );
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
    first && last ? (
      <>
        <time dateTime={first}>
          {new Date(`${first}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </time>{" "}
        —{" "}
        <time dateTime={last}>
          {new Date(`${last}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </time>
      </>
    ) : (
      "No dated activity"
    );
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
          {!showCache ? (
            <TokenTypesNotice>{cacheHiddenNotice}</TokenTypesNotice>
          ) : tokenTypes.totalTokens === 0 && tokenTypes.warpTokensExcluded > 0 ? (
            <TokenTypesNotice>{warpOnlyNotice}</TokenTypesNotice>
          ) : (
            <TokenTypeTable
              summary={tokenTypes}
              title="Cost by token type, all models"
              context={{
                reasoning: effortSummary?.reasoning ?? null,
                effortIndexEnabled,
                rateCard,
              }}
            >
              <TokenTypesByModel inputs={tokenTypeInputs} rateCard={rateCard} unpricedModels={unpricedModels} />
            </TokenTypeTable>
          )}
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
                        ? <DateStamp value={session.metadata.lastActivity} />
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

export function Projects({
  data,
  daily,
  sessions,
  metricRange,
  customRange,
  dateRange,
  showCache,
  onOpenSession,
}: {
  data: DashboardData;
  daily: MetricRow[];
  sessions: Session[];
  metricRange: MetricRange;
  customRange: DateRange | null;
  dateRange: DateRange | null;
  showCache: boolean;
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
    const inRange = data.projects
      .map((project) => projectSummaryInRange(project, daily, sessionCounts.get(project.name) ?? 0))
      .filter(Boolean) as ProjectSummary[];
    // One row per project, not per checkout path: a scheduled task's dated run
    // directories roll up into a single recurring row, and the same project
    // under two parents merges.
    return mergeProjectSummaries(inRange);
  }, [data.projects, daily, sessions]);
  const visibleProjects = useMemo(() => {
    const [key, direction] = sort.split("-") as [
      "name" | "tokens" | "cost" | "sessions",
      "asc" | "desc",
    ];
    const matches = scopedProjects.filter((project) =>
      `${project.label} ${project.models.join(" ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
    return [...matches].sort((left, right) => {
      const value = (project: GroupedProjectSummary): string | number =>
        key === "name" ? project.label : project[key];
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
          const effortSummary = mergeEffortSummaries(
            project.memberIds
              .map((memberId) => effortByProject.get(memberId))
              .filter((summary): summary is EffortSummary => Boolean(summary)),
          );
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
                  <h3>
                    {project.label}
                    {project.automation && (
                      <i
                        className="automation-chip"
                        title={`Recurring scheduled task — ${project.memberIds.length === 1 ? "its dated run directory is" : `${project.memberIds.length} dated run directories are`} rolled up into this one row.`}
                      >
                        automation
                      </i>
                    )}
                    {!project.automation && project.memberIds.length > 1 && (
                      <i
                        className="automation-chip automation-chip--merge"
                        title={`Combined from ${project.memberIds.length} checkouts: ${project.memberIds.join(", ")}`}
                      >
                        ×{project.memberIds.length} paths
                      </i>
                    )}
                  </h3>
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
                    rateCard={data.rateCard}
                    unpricedModels={data.unpricedModels}
                    showCache={showCache}
                    effortSummary={effortSummary}
                    effortIndexEnabled={statusRequest.data?.enabled}
                    activity={data.projectActivity.filter((activity) =>
                      project.memberIds.includes(activity.projectId),
                    )}
                    sessions={sessions.filter((session) =>
                      project.memberIds.includes(
                        (session.cwd ?? "").replace(/\/+$/, ""),
                      ),
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
