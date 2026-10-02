import { useMemo, useState } from "react";
import { useEffortAggregate, useEffortRefreshOnIndexChange, useEffortStatus } from "../hooks/use-effort";
import { DEFAULT_SLOPE_SORT, nextSlopeSort, type SlopeSort } from "../model-slope";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardData, MetricRow, Session } from "../types";
import { Empty, PageTitle, Segmented } from "./chrome";
import { selectionProvider, type AgentSelection } from "../agent-filter";
import { filterEmptyMessage } from "../filter-summary";
import { dateRangeLabel, type DateRange, type MetricRange } from "../time-range";
import { type Metric } from "../app/preferences";
import { modelDistribution } from "../app/analytics";
import {
  globalEffortScope,
  modelSignalColor,
  HourlyProviderTimeline,
  ProviderTimeline,
  EffortByDay,
  ModelSignalSlope,
  SLOPE_MEASURE_LABELS,
  ModelSignalTooltip,
  chartTooltipWrapperStyle,
  Composition,
} from "../components/activity-charts";

export function Explorer({
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
  const [signalView, setSignalView] = useState<"slope" | "ranked">("slope");
  const [slopeSort, setSlopeSort] = useState<SlopeSort>(DEFAULT_SLOPE_SORT);
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
        description="Activity beside observed weekly headroom, so a spike can be read against what it did to the allowance. Global agent and path filters stay linked across the workspace."
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
            headroomOverlay
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
            <div className="model-signal-controls">
              <Segmented
                value={signalView}
                onChange={(v) => setSignalView(v as "slope" | "ranked")}
                options={[
                  { value: "slope", label: "Slope" },
                  { value: "ranked", label: "Ranked" },
                ]}
              />
              {signalView === "ranked" && (
                <Segmented
                  value={metric}
                  onChange={(v) => setMetric(v as Metric)}
                  options={[
                    { value: "totalTokens", label: "Tokens" },
                    { value: "totalCost", label: "Cost" },
                    { value: "outputTokens", label: "Output" },
                  ]}
                />
              )}
            </div>
          </div>
          {modelData.length === 0 ? (
            <Empty text={filterEmptyMessage(agent, metricRange, pathTag, customRange)} />
          ) : signalView === "slope" ? (
            <>
              <ModelSignalSlope
                models={modelData}
                sort={slopeSort}
                onSort={(measure) =>
                  setSlopeSort((current) => nextSlopeSort(current, measure))
                }
              />
              <p className="slope-chart__note">
                Position is rank among the shown models per column, top 8 by{" "}
                {SLOPE_MEASURE_LABELS[slopeSort.order[0]]} with ties broken by{" "}
                {SLOPE_MEASURE_LABELS[slopeSort.order[1]]}. Click a heading to
                sort by it; the last primary becomes the tie-break. A line that
                dives toward API $ is cheap for its volume; one that dives toward
                output paid for more context than it handed back. Warp-only
                models carry $0 here because provider credits never become
                dollars.
              </p>
            </>
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
                  content={
                    <ModelSignalTooltip
                      metric={metric}
                      status={modelEffortStatus.data}
                    />
                  }
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
