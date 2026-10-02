import { useCallback, useEffect, useMemo } from "react";
import {
  ComboPill,
  EffortBadge,
  EffortCoverage,
  EffortStack,
  EffortState,
  EFFORT_HELP,
  sharePercent,
} from "../components/effort";
import { comboKey } from "../combo";
import { providerFromAgent } from "../provider";
import {
  decodeEffortDigest,
  useEffortAggregate,
  useEffortComboDays,
  useEffortRefreshOnIndexChange,
  useEffortSessions,
  useEffortStatus,
} from "../hooks/use-effort";
import { useSessionQuotaContexts } from "../hooks/use-session-quota-contexts";
import { Bot, ChevronRight, CircleDollarSign, Database, Gauge, Tag, Zap } from "lucide-react";
import { HeadroomOrrery, type ProviderColors, type SceneEffects } from "../scene";
import { providerHeadroom } from "../quota-headroom";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import type { DashboardData, MetricRow, Session } from "../types";
import { Empty, TimeRangeControl } from "./chrome";
import {
  agentSelectionParams,
  selectAgentRow,
  selectionProvider,
  type AgentSelection,
} from "../agent-filter";
import { filterEmptyMessage } from "../filter-summary";
import {
  metricRangeLabel,
  metricRangeRows,
  metricRangeSpanDays,
  numericDate,
  type DateRange,
  type MetricRange,
} from "../time-range";
import {
  compactTokens as insightTokens,
  percent as insightPercent,
  providerLabel as insightProviderLabel,
  shortDate as insightShortDate,
  useInsights,
} from "./data/insights";
import { viewHref, sessionHref } from "../app/preferences";
import { formatMoney, formatCompact, SessionDateStamp, formatSessionDate } from "../app/format";
import {
  metricTotals,
  averageMetricSlices,
  metricRowCacheShare,
  providerCapacityRows,
  currentWindowSessions,
  recentSessionFloor,
  recentSessionRows,
  recentTermini,
  percentChange,
  metricAverageCardItems,
  percentagePointChange,
  agentTerminusLabels,
  terminusWindowLabels,
} from "../app/analytics";
import {
  globalEffortScope,
  MetricCard,
  TokenTableCard,
  HourlyProviderTimeline,
  ProviderTimeline,
} from "../components/activity-charts";
import { QuotaDials } from "../components/quota-cards";
import { SessionQuotaBalanceCell, SessionEffortCell } from "../components/session-detail";
import { type BenchmarkSiteId, BenchmarkTriggerIcons } from "../components/benchmark-launcher";

export function Overview({
  data,
  daily,
  sessions,
  windowSessions,
  agent,
  pathTag,
  metricRange,
  customRange,
  dateRange,
  availableRange,
  onMetricRangeChange,
  onOpenSession,
  onOpenSessions,
  onOpenData,
  onTagSession,
  onUpdateWebCredits,
  onOpenBenchmark,
  accent,
  providerColors,
  sceneEffects,
}: {
  data: DashboardData;
  daily: MetricRow[];
  sessions: Session[];
  windowSessions: Session[];
  agent: AgentSelection;
  pathTag: string;
  metricRange: MetricRange;
  customRange: DateRange | null;
  dateRange: DateRange | null;
  availableRange: DateRange | null;
  onMetricRangeChange: (range: MetricRange, customRange?: DateRange) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenSessions: () => void;
  onOpenData: () => void;
  onTagSession: (session: Session) => void;
  onUpdateWebCredits: () => void;
  onOpenBenchmark: (siteId: BenchmarkSiteId) => void;
  accent: string;
  providerColors: ProviderColors;
  sceneEffects: SceneEffects;
}) {
  // The top-finding card follows the same range, agent, and path filters as the
  // summary above it; cache stays included because the finding rules reason
  // over cache traffic. Facets beyond that are the Data view's defaults.
  const overviewAgentParams = useMemo(() => agentSelectionParams(agent), [agent]);
  const { insights: overviewInsights } = useInsights(
    {
      days: metricRange === "custom" ? "30" : metricRange,
      dateRange: metricRange === "custom" ? customRange : null,
      providers: overviewAgentParams.providers,
      modelFamilies: overviewAgentParams.modelFamilies,
      pathTag,
      showCache: true,
      collectedAt: data.collectedAt,
    },
    { outliers: "all", finding: "all", effort: "all", findingPage: 1, policy: "capture" },
  );
  const topFindingGroup = overviewInsights?.efficiency.groups[0] ?? null;
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
  const directTraffic = totals.input + totals.output;
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
  const inputAverages = averageMetricSlices(daily, (row) => row.inputTokens);
  const previousInputAverages = averageMetricSlices(
    previousDaily,
    (row) => row.inputTokens,
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
  const capacityRows = providerCapacityRows(daily, data.quotas);
  const providerMix = capacityRows.map((row) => ({
    name:
      row.provider === "anthropic"
        ? "Claude"
        : row.provider === "codex"
          ? "Codex"
          : "Warp",
    value: row.tokens,
    share: row.tokenShare,
    color:
      row.provider === "anthropic"
        ? providerColors.anthropic
        : row.provider === "codex"
          ? providerColors.openai
          : providerColors.warp,
  }));
  const providerMixTotal = providerMix.reduce(
    (sum, provider) => sum + provider.value,
    0,
  );
  const recent = currentWindowSessions(windowSessions, data.quotas);
  const recentFloor = recentSessionFloor(data.quotas, windowSessions);
  // The list runs well past the two windows it is titled for, so a closing quota reading is
  // fetched for a row only once that row is actually on screen.
  const sessionQuota = useSessionQuotaContexts();
  const requestQuota = sessionQuota.request;
  const quotaObserver = useMemo(
    () =>
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              const visible = entries
                .filter((entry) => entry.isIntersecting)
                .map((entry) => (entry.target as HTMLElement).dataset.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId));
              if (visible.length) requestQuota(visible);
            },
            { rootMargin: "150px" },
          ),
    [requestQuota],
  );
  useEffect(() => () => quotaObserver?.disconnect(), [quotaObserver]);
  const watchQuota = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !quotaObserver) return;
      quotaObserver.observe(node);
      return () => quotaObserver.unobserve(node);
    },
    [quotaObserver],
  );
  // Those same readings carry the cycle each session closed in, so the window boundaries keep
  // being drawn as far down as the list has been read.
  const recentRows = recentSessionRows(
    recent,
    recentTermini(data.quotas, recent, sessionQuota.contexts),
  );
  const cacheShare = totals.traffic
    ? Math.round((totals.cache / totals.traffic) * 100)
    : 0;
  const previousCacheShare = previousTotals.traffic
    ? Math.round((previousTotals.cache / previousTotals.traffic) * 100)
    : 0;
  const rangeLabel = metricRangeLabel(metricRange, customRange);
  const capacityTrackingSince = data.quotas.history?.trackingSince
    ? new Date(data.quotas.history.trackingSince).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const spanDays = metricRangeSpanDays(metricRange, customRange);
  const periodLabel =
    daily.length === 1 ? (
      <time dateTime={daily[0].period}>{numericDate(daily[0].period, true)}</time>
    ) : daily.length > 1 ? (
      <>
        <time dateTime={daily[0].period}>{numericDate(daily[0].period)}</time>–
        <time dateTime={daily.at(-1)!.period}>{numericDate(daily.at(-1)!.period, true)}</time>
      </>
    ) : (
      "No activity in this span"
    );
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
      <QuotaDials
        quotas={data.quotas}
        timeZone={data.timeZone}
        onUpdateWebCredits={onUpdateWebCredits}
      />
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
              {metricRange !== "all" && spanDays !== null &&
                ` · trends vs the prev ${spanDays === 1 ? "day" : `${spanDays} days`}`}
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
              onChange={onMetricRangeChange}
            />
          </div>
        </div>
        <div className="metric-grid">
          <MetricCard
            eyebrow="API-EQUIVALENT COST"
            value={formatMoney(totals.cost)}
            detail="ccusage · offline pricing"
            trend={percentChange(totals.cost, previousTotals.cost)}
            baseline={formatMoney(previousTotals.cost)}
            averages={metricAverageCardItems(
              costAverages,
              previousCostAverages,
              formatMoney,
            )}
            icon={CircleDollarSign}
          />
          {/* Output leads: it is the only column that measures work handed back.
              In/out shares use direct traffic as the denominator — against the
              cache-inclusive total they round to 0% and read as noise. */}
          <TokenTableCard
            eyebrow="TOKENS"
            icon={Zap}
            columns={[
              {
                key: "output",
                label: "OUT",
                value: formatCompact(totals.output),
                detail: `${directTraffic ? Math.round((totals.output / directTraffic) * 100) : 0}% of direct traffic`,
                trend: percentChange(totals.output, previousTotals.output),
                baseline: formatCompact(previousTotals.output),
                averages: metricAverageCardItems(
                  outputAverages,
                  previousOutputAverages,
                  formatCompact,
                ),
              },
              {
                key: "input",
                label: "IN",
                value: formatCompact(totals.input),
                detail: `${directTraffic ? Math.round((totals.input / directTraffic) * 100) : 0}% of direct traffic`,
                trend: percentChange(totals.input, previousTotals.input),
                baseline: formatCompact(previousTotals.input),
                averages: metricAverageCardItems(
                  inputAverages,
                  previousInputAverages,
                  formatCompact,
                ),
              },
              {
                key: "total",
                label: "TOTAL",
                value: formatCompact(totals.tokens),
                detail: `incl. cache · ${daily.length} active ${daily.length === 1 ? "day" : "days"}`,
                trend: percentChange(totals.tokens, previousTotals.tokens),
                baseline: formatCompact(previousTotals.tokens),
                averages: metricAverageCardItems(
                  tokenAverages,
                  previousTokenAverages,
                  formatCompact,
                ),
              },
            ]}
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
            trendUnit="% share"
            baseline={`${previousCacheShare}%`}
            split={[
              {
                label: "Cache read",
                value: formatCompact(totals.cache),
                share: sharePercent(totals.cache, totals.traffic),
              },
              {
                label: "Cache write",
                value: formatCompact(totals.cacheWrite),
                share: sharePercent(totals.cacheWrite, totals.traffic),
              },
            ]}
            splitNote="Only Claude Code reports cache writes"
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
              headroomOverlay
            />
          )}
        </article>
      </section>
      <section className="dashboard-grid">
        <article className="panel agent-panel provider-capacity-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">PROVIDER CAPACITY</span>
              <h2>Use vs limits</h2>
              <p>
                Token share covers {rangeLabel.toLowerCase()}. Account levels are latest.
                {capacityTrackingSince && ` Events count since ${capacityTrackingSince}.`}
              </p>
            </div>
            <div className="panel-heading-actions">
              <button
                type="button"
                className="accent-icon-button benchmark-trigger"
                onClick={() => onOpenBenchmark("deepswe")}
                aria-label="Compare model cost and efficiency benchmarks"
                title="Compare model cost and efficiency benchmarks"
              >
                <BenchmarkTriggerIcons />
              </button>
              <Bot />
            </div>
          </div>
          {capacityRows.length === 0 ? (
            <Empty text="No provider activity or quota readings in this view." />
          ) : (
            <div className="provider-capacity">
              <div className="provider-capacity__mix">
                <div className="provider-capacity__donut">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={providerMix}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={43}
                        outerRadius={58}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {providerMix.map((provider) => (
                          <Cell key={provider.name} fill={provider.color} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <span>
                    <b>{formatCompact(providerMixTotal)}</b>
                    <small>tokens</small>
                  </span>
                </div>
                <div className="provider-capacity__legend">
                  {providerMix.map((provider) => (
                    <div key={provider.name}>
                      <i style={{ background: provider.color }} />
                      <span>{provider.name}</span>
                      <b>{provider.share.toFixed(0)}%</b>
                    </div>
                  ))}
                </div>
              </div>
              {capacityRows.map((row) => {
                const stateLabel = row.state === "ok" ? "current" : row.state;
                const load = row.highestUsedPercent;
                return (
                  <section
                    className={`provider-capacity__row ${row.provider} ${row.state}`}
                    key={row.provider}
                  >
                    <header>
                      <span><i />{row.label}</span>
                      <small>{stateLabel}</small>
                    </header>
                    <div className="provider-capacity__comparison">
                      <div>
                        <span>Token share</span>
                        <b>{row.tokenShare.toFixed(0)}%</b>
                        <div className="provider-capacity__track" aria-hidden="true">
                          <i style={{ width: `${row.tokenShare}%` }} />
                        </div>
                      </div>
                      <div className={load !== null && load >= 90 ? "is-pressured" : undefined}>
                        <span>Highest quota use</span>
                        <b>{load === null ? "—" : `${load.toFixed(0)}%`}</b>
                        <div className="provider-capacity__track" aria-hidden="true">
                          <i style={{ width: `${load ?? 0}%` }} />
                        </div>
                      </div>
                    </div>
                    <div
                      className="provider-capacity__windows"
                      aria-label={`${row.label} current quota levels`}
                    >
                      {row.windows.map((window) => (
                        <span className={window.state} key={window.id}>
                          <small>{window.label}</small>
                          <b>
                            {window.usedPercent === null
                              ? window.state
                              : `${window.usedPercent.toFixed(0)}% used`}
                          </b>
                        </span>
                      ))}
                    </div>
                    <div className="provider-capacity__events">
                      <span>
                        Limit reaches
                        <b>{row.limitReaches === null ? "not tracked" : row.limitReaches}</b>
                        {row.reachBreakdown && <small>{row.reachBreakdown}</small>}
                      </span>
                      {row.resetsApplied !== undefined && (
                        <span>
                          Resets applied
                          <b>{row.resetsApplied === null ? "not tracked" : row.resetsApplied}</b>
                        </span>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
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
        {topFindingGroup && overviewInsights && (
          <article className="panel panel-wide top-finding-panel">
            <div className="panel-heading">
              <div>
                <span className="overline">EFFICIENCY SIGNAL</span>
                <h2>Top finding</h2>
                <p>The session with the most plausibly avoidable spend in view.</p>
              </div>
              <a
                className="text-link"
                href={viewHref("sources")}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenData();
                }}
              >
                All findings <ChevronRight aria-hidden="true" />
              </a>
            </div>
            <p className="top-finding__headline">
              {topFindingGroup.findings[0]?.headline}
            </p>
            <p className="top-finding__meta">
              {insightProviderLabel(topFindingGroup.provider)} · {topFindingGroup.project} ·{" "}
              {insightShortDate(topFindingGroup.date)} ·{" "}
              {insightTokens.format(topFindingGroup.processed)} tokens · {formatMoney(topFindingGroup.cost)}
              {topFindingGroup.recoverable > 0 && (
                <b> · {insightTokens.format(topFindingGroup.recoverable)} avoidable</b>
              )}
              {" · "}
              <a
                className="text-link"
                href={sessionHref(topFindingGroup.sessionId)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  onOpenSession(topFindingGroup.sessionId);
                }}
              >
                Open session
              </a>
            </p>
            <p className="top-finding__totals">
              {overviewInsights.efficiency.totals.flaggedSessions} sessions flagged in view ·{" "}
              {insightTokens.format(overviewInsights.efficiency.totals.recoverable)} tokens plausibly
              avoidable ({insightPercent(overviewInsights.efficiency.totals.recoverableShare, 1)} of processed)
            </p>
          </article>
        )}
        <article className="panel panel-wide recent-panel">
          <div className="panel-heading">
            <div>
              <span className="overline">
                {recentFloor?.basis === "weekly"
                  ? "CURRENT WEEKLY WINDOWS"
                  : "LATEST ACTIVITY"}
              </span>
              <h2>Latest sessions</h2>
              {/* One span for every provider. It runs to the earlier of the two weekly openings,
               * so each of Claude and Codex is always shown its whole current week and one of
               * them a few days more. */}
              <p>
                {recentFloor === null ? (
                  "Claude, Codex, and Warp sessions"
                ) : (
                  <>
                    All sessions since{" "}
                    <SessionDateStamp value={new Date(recentFloor.at).toISOString()} />
                    {" · "}
                    {recentFloor.basis === "weekly"
                      ? "the earlier of Claude's and Codex's open weekly cycles"
                      : "the last ten each from Claude and Codex"}
                  </>
                )}
              </p>
            </div>
            <a
              className="text-link"
              href={viewHref("sessions")}
              onClick={(event) => {
                event.preventDefault();
                onOpenSessions();
              }}
            >
              All sessions <ChevronRight aria-hidden="true" />
            </a>
          </div>
          <div className="recent-list">
            {recent.length ? recentRows.map((row) => {
              if (row.kind === "terminus") {
                const at = new Date(row.terminus.at).toISOString();
                return (
                  <p
                    className={`recent-terminus${row.terminus.window === "weekly" ? " recent-terminus--weekly" : ""}`}
                    key={row.terminus.key}
                  >
                    <i
                      style={{
                        background:
                          row.terminus.provider === "anthropic"
                            ? providerColors.anthropic
                            : providerColors.openai,
                      }}
                      aria-hidden="true"
                    />
                    <b>{agentTerminusLabels[row.terminus.provider]}</b>
                    <span
                      title={
                        row.terminus.scope === "observed"
                          ? "Recorded from this account's own quota readings on either side of the line."
                          : "Reported by the provider now."
                      }
                    >
                      {row.terminus.scope === "observed"
                        ? `${terminusWindowLabels[row.terminus.window]} window reset`
                        : `${row.terminus.scope} ${terminusWindowLabels[row.terminus.window]} window opened`}
                    </span>
                    <time dateTime={at}>{formatSessionDate(at)}</time>
                  </p>
                );
              }
              const session = row.session;
              const modelName =
                session.modelsUsed.join(", ") || "Unknown model";
              const tooltipId = `recent-session-tag-tooltip-${session.sessionId}`;
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
                    {/* One reading of the shared account counter at this session's close, the
                     * same column the sessions table carries. It is fetched when the row is
                     * seen, so a row still says it is loading until then. */}
                    <span
                      className="recent-session__quota"
                      data-session-id={session.sessionId}
                      ref={watchQuota}
                    >
                      <SessionQuotaBalanceCell
                        context={sessionQuota.contexts[session.sessionId]}
                        loading={
                          !Object.hasOwn(
                            sessionQuota.contexts,
                            session.sessionId,
                          )
                        }
                        provider={providerFromAgent(session.agent)}
                      />
                    </span>
                    <span className="recent-session__activity">
                      {session.metadata?.lastActivity ? (
                        <SessionDateStamp value={session.metadata.lastActivity} />
                      ) : (
                        "—"
                      )}
                    </span>
                    {/* Claude and Codex both began with a "C": the agent is named in full so the
                     * row does not need decoding. */}
                    <span className={`agent-pill ${session.agent}`}>
                      {session.agent}
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
            }) : <Empty
              text={
                recentFloor === null
                  ? "No Claude, Codex, or Warp sessions recorded."
                  : "No Claude, Codex, or Warp sessions in this span."
              }
            />}
          </div>
        </article>
      </section>
    </div>
  );
}
