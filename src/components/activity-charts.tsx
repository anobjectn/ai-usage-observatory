import { Fragment, useLayoutEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { buildEffortDaySeries } from "../effort-model";
import { dateKeyInTimeZone, hourInTimeZone, systemTimeZone } from "../reporting-time";
import {
  ComboPill,
  EffortCoverage,
  EffortState,
  effortColor,
  effortLabel,
  familyLabel,
  sharePercent,
} from "./effort";
import { buildComboDaySeries, comboKey, comboSeriesColor, comboSeriesLabel, parseComboKey } from "../combo";
import {
  useEffortAggregate,
  useEffortComboDays,
  useEffortRefreshOnIndexChange,
  useEffortStatus,
  type EffortScopeInput,
} from "../hooks/use-effort";
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Orbit } from "lucide-react";
import { dailyHeadroomSeries, type DailyHeadroom } from "../quota-headroom";
import { modelSignalSlopes, type SlopeMeasure, type SlopeSort } from "../model-slope";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DashboardData,
  EffortComboBucket,
  EffortIndexStatus,
  EffortSummary,
  MetricRow,
  ProjectActivity,
  Session,
} from "../types";
import { dailyQuotaMarkers, hourlyQuotaMarkers, quotaMarkersAt, type QuotaMarker } from "../quota-markers";
import { Empty, Segmented } from "../views/chrome";
import { agentSelectionParams, type AgentSelection } from "../agent-filter";
import { familyOf } from "../model-family";
import { type DateRange } from "../time-range";
import { ChartTooltipContext, PinnableChartTooltip, useChartTooltipHold } from "./chart-pins";
import { TooltipMoreDisclosure } from "./tooltip-disclosure";
import { chartTooltipDateLabel } from "../chart-pins";
import { type Metric, palette } from "../app/preferences";
import {
  formatMoney,
  formatCompact,
  providerSeries,
  providerKey,
  ActivityAxisTick,
  hourTickLabel,
  friendlyProject,
  periodTickLabel,
} from "../app/format";
import { type MetricCardAverage, average, modelDistribution, effortAbsenceReason } from "../app/analytics";


/** Maps the global Agent / range / path-tag controls onto an effort scope. Dashboard and
 * Explorer read calendar activity, so both use the timeline basis. */
export function globalEffortScope(
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

export function timeEffortScope(
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

type MetricCardSplit = {
  label: string;
  value: string;
  share: string;
};

function MetricTrend({
  value,
  unit = "%",
  context = "previous equal span",
  size = "compact",
}: {
  value: number;
  unit?: "%" | "% share";
  context?: string;
  /** `lead` is the headline change of a card, sized to be read before its averages. */
  size?: "compact" | "lead";
}) {
  const direction = value >= 0 ? "up" : "down";
  return (
    <span
      className={`${direction === "up" ? "trend-up" : "trend-down"}${size === "lead" ? " trend--lead" : ""}`}
      aria-label={`${direction === "up" ? "Up" : "Down"} ${Math.abs(value)}${unit}, ${context}`}
    >
      {direction === "up" ? <ArrowUpRight /> : <ArrowDownRight />}
      {Math.abs(value)}
      {unit}
    </span>
  );
}

export function MetricCard({
  eyebrow,
  value,
  detail,
  trend,
  trendUnit = "%",
  baseline,
  split,
  splitNote,
  averages,
  icon: Icon,
}: {
  eyebrow: string;
  value: string;
  detail: string;
  trend?: number;
  trendUnit?: "%" | "% share";
  /** The prior-span figure the change was measured against, in the metric's own units. */
  baseline?: string;
  /** The parts the headline figure is made of, each with its share of the same denominator. */
  split?: MetricCardSplit[];
  /** Names a coverage limit of the split. It is shown in every filter state, because the
   * default filter is the one where the limit bites. */
  splitNote?: string;
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
        {trend !== undefined && (
          <MetricTrend value={trend} unit={trendUnit} size="lead" />
        )}
      </div>
      {trend !== undefined && baseline && (
        <p className="metric-baseline">vs {baseline} prior span</p>
      )}
      {split && split.length > 0 && (
        <div className="metric-card__split">
          {split.map((part) => (
            <div className="metric-card__split-row" key={part.label}>
              <span>{part.label}</span>
              <strong>{part.value}</strong>
              <em>{part.share}</em>
            </div>
          ))}
          {splitNote && <small>{splitNote}</small>}
        </div>
      )}
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

type TokenTableColumn = {
  key: string;
  label: string;
  value: string;
  detail: string;
  trend?: number;
  /** The prior-span figure the change was measured against, in the column's own units. */
  baseline?: string;
  averages: MetricCardAverage[];
};


/** The Total/Output pair reads as one traffic story, so it merges into a single wide card with
 * Total, In, and Out as columns of one table rather than two side-by-side single-metric cards. */
export function TokenTableCard({
  eyebrow,
  icon: Icon,
  columns,
}: {
  eyebrow: string;
  icon: typeof Orbit;
  columns: TokenTableColumn[];
}) {
  const averageRows = columns[0]?.averages ?? [];
  return (
    <article className="metric-card metric-card--wide">
      <div className="metric-card__top">
        <span>{eyebrow}</span>
        <Icon size={16} />
      </div>
      <div className="metric-token-table-scroll">
        <table className="metric-token-table">
          <thead>
            <tr>
              <th scope="col" />
              {columns.map((column) => (
                <th scope="col" key={column.key}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="metric-token-table__value-row">
              <th scope="row" className="sr-only">
                Value
              </th>
              {columns.map((column) => (
                <td key={column.key}>
                  <strong aria-live="polite">{column.value}</strong>
                  <div className="metric-detail">
                    <span>{column.detail}</span>
                    {column.trend !== undefined && (
                      <MetricTrend value={column.trend} size="lead" />
                    )}
                    {column.trend !== undefined && column.baseline && (
                      <span className="metric-baseline">
                        vs {column.baseline} prior span
                      </span>
                    )}
                  </div>
                </td>
              ))}
            </tr>
            {averageRows.length > 0 && (
              <tr className="metric-token-table__divider">
                <td colSpan={columns.length + 1}>
                  <span>AVERAGES</span>
                  <small>active days · vs prior span</small>
                </td>
              </tr>
            )}
            {averageRows.map((row, index) => (
              <tr key={row.label} className="metric-token-table__average-row">
                <th scope="row">{row.label}</th>
                {columns.map((column) => {
                  const cell = column.averages[index];
                  return (
                    <td key={column.key}>
                      <strong>{cell.value}</strong>
                      {cell.trend === undefined ? (
                        <span
                          className="metric-token-table__empty-trend"
                          aria-label="No previous matching slice"
                        >
                          —
                        </span>
                      ) : (
                        <MetricTrend
                          value={cell.trend}
                          context="previous matching slice"
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

export type ChartTooltipProps = {
  active?: boolean;
  coordinate?: { x?: number };
  label?: string | number;
  payload?: ChartTooltipPayload[];
};


/** Plot left visible below a hover card, in px, so the axis labels stay read. */
const axisClearance = 30;

const maxTooltipHeight = 470;

const minTooltipHeight = 160;

export const chartTooltipWrapperStyle = {
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

export function ModelSignalTooltip({
  active,
  payload,
  coordinate,
  metric,
  status,
}: {
  active?: boolean;
  payload?: Array<{ payload: ModelSignalRow; color?: string; value?: number }>;
  coordinate?: { x?: number };
  metric: Metric;
  status: EffortIndexStatus | null;
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
  const family = familyOf(row.rawName);
  const levels = summary?.levels ?? [];
  // A fold that could only rank by observations leaves every token count at zero. Those levels
  // are still observed values, so they are listed by observation count rather than dropped.
  const attributed = levels.filter((level) => level.tokens > 0);
  const observed =
    attributed.length > 0
      ? attributed
      : levels.filter((level) => level.observations > 0);
  // Unattributed tokens stay in the denominator so the listed shares add up to the model's own
  // token total rather than to the attributed slice alone. A degraded fold reports null here,
  // and then only the attributed side can be shared out.
  const unattributedTokens = summary?.unknownTokens ?? null;
  const breakdownTotal =
    (summary?.attributedTokens ?? 0) + (unattributedTokens ?? 0);
  // Every row of the breakdown is one combo, including the unattributed remainder, which is the
  // same model with no recorded value. Rows rank by size rather than by canonical effort order:
  // the question this tooltip answers is where the model's tokens went. Observation counts break
  // the tie for a fold that could not attribute tokens at all.
  const breakdown = [
    ...observed.map((level) => ({
      effort: level.effort,
      tokens: level.tokens,
      observations: level.observations,
    })),
    ...(summary && unattributedTokens !== null && unattributedTokens > 0
      ? [
          {
            effort: "",
            tokens: unattributedTokens,
            observations: summary.unknownObservations,
          },
        ]
      : []),
  ].sort(
    (a, b) => b.tokens - a.tokens || b.observations - a.observations,
  );
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
      interactive={hold.interactive}
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
      <div className="model-signal-tooltip__effort">
        {/* Every row is the model and its recorded value together, dominant or not: an effort
         * label on its own would invite comparison across families, and a pill for one row and
         * bare text for the rest would read as two different kinds of fact. */}
        {breakdown.map((entry) => (
          <Fragment key={entry.effort || "unknown"}>
            <ComboPill combo={{ family, effort: entry.effort }} />
            <b>
              {entry.tokens > 0
                ? formatCompact(entry.tokens)
                : `${formatCompact(entry.observations)} obs`}
            </b>
            <em>
              {entry.tokens > 0
                ? sharePercent(entry.tokens, breakdownTotal)
                : "—"}
            </em>
          </Fragment>
        ))}
        {breakdown.length === 0 && (
          <>
            <ComboPill combo={{ family, effort: "" }} />
            <b>—</b>
            <em>—</em>
          </>
        )}
        <small>
          {!summary || summary.tokenCoverage === null
            ? "Token coverage unavailable"
            : `${Math.round(summary.tokenCoverage * 100)}% token coverage`}
        </small>
        {observed.length === 0 && (
          <small>{effortAbsenceReason(summary, status)}</small>
        )}
      </div>
    </PinnableChartTooltip>
  );
}

export function useClampedTooltip(active: boolean, coordinate?: { x?: number }) {
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

    const place = () => {
      const chartBounds = chart.getBoundingClientRect();
      const edgePadding = 8;
      tooltip.style.setProperty(
        "--tooltip-width",
        `min(calc(410px + 10ch), ${Math.max(0, chartBounds.width - edgePadding * 2)}px)`,
      );
      const wrapperBounds = wrapper.getBoundingClientRect();
      const centeredOffset =
        chartBounds.left +
        (coordinate.x ?? 0) -
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

      // Keep the card clear of the x-axis so its labels and a sliver of the
      // plot stay readable, even when that lifts the card past the top of the
      // chart the way a pinned copy can sit.
      const baseOffsetY = -6;
      tooltip.style.setProperty("--tooltip-y", `${baseOffsetY}px`);
      // The grid spans the plot area, so its bottom is the axis baseline: a
      // chart can hide its x-axis, and the axis group measures as an empty box.
      const gridBounds = chart
        .querySelector(".recharts-cartesian-grid")
        ?.getBoundingClientRect();
      const axisBounds = chart
        .querySelector(".recharts-xAxis")
        ?.getBoundingClientRect();
      const baselineY =
        gridBounds && gridBounds.height > 0
          ? gridBounds.bottom
          : axisBounds && axisBounds.height > 0
            ? axisBounds.top
            : chartBounds.bottom;
      const bottomBoundary = baselineY - axisClearance;
      // A card that cannot fit between the top of the window and that boundary
      // gives up height rather than the gap, and scrolls what is left over.
      tooltip.style.setProperty(
        "--tooltip-max-height",
        `${Math.max(
          minTooltipHeight,
          Math.min(maxTooltipHeight, bottomBoundary - edgePadding),
        )}px`,
      );
      const placed = tooltip.getBoundingClientRect();
      const offsetY =
        placed.bottom > bottomBoundary
          ? baseOffsetY - (placed.bottom - bottomBoundary)
          : baseOffsetY;
      tooltip.style.setProperty("--tooltip-y", `${offsetY}px`);
    };

    place();
    // Rows the card opens from a "+N more" toggle grow it downward, and that
    // state lives inside the card, so only its own resize reports the change.
    const observer = new ResizeObserver(place);
    observer.observe(tooltip);
    return () => observer.disconnect();
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
  /** Weekly-window headroom observed on this day, when the chart overlays it. */
  headroom?: DailyHeadroom;
} & Partial<Record<(typeof providerSeries)[number]["key"], number>>;


/** The heading a timeline row reads under: its date, else the label the chart
 * gave the point. */
function timelineRowLabel(
  row: TimelineTooltipRow | undefined,
  fallback: string,
) {
  if (row?.period) return chartTooltipDateLabel(row.period);
  return row?.label ?? fallback;
}

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


/** The models a tooltip list left out, folded behind a "+N more" toggle that
 * carries their subtotals and opens to the rows themselves. */
export function TooltipModelTail({
  models,
  listClassName,
  className,
}: {
  models: Array<{ name: string; tokens: number; cost: number }>;
  listClassName: string;
  className?: string;
}) {
  if (models.length === 0) return null;
  return (
    <TooltipMoreDisclosure
      className={className}
      label={`+${models.length} more`}
      tokens={formatCompact(
        models.reduce((sum, model) => sum + model.tokens, 0),
      )}
      cost={formatMoney(models.reduce((sum, model) => sum + model.cost, 0))}
    >
      <ul className={listClassName}>
        {models.map((model) => (
          <li key={model.name}>
            <span>{model.name}</span>
            <b>{formatCompact(model.tokens)}</b>
            <b>{formatMoney(model.cost)}</b>
          </li>
        ))}
      </ul>
    </TooltipMoreDisclosure>
  );
}


/** One project row inside the activity tooltip: its totals, then a provider and
 * model breakdown under it. */
function TooltipProjectEntry({ project }: { project: TooltipProject }) {
  return (
    <li>
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
              <TooltipModelTail
                models={providerActivity.models
                  .slice(visibleModels.length)
                  .map((model) => ({ ...model, name: model.model }))}
                listClassName="tooltip-project-models"
                className="tooltip-model-more project"
              />
            </section>
          );
        })}
      </div>
    </li>
  );
}


/** The providers a row actually recorded, in series order, limited to the
 * series this chart draws. Stepping to another day has to read these off the
 * row itself, since only the hovered point arrives with a Recharts payload. */
function timelineProviderEntries(
  row: TimelineTooltipRow | undefined,
  keys: Array<(typeof providerSeries)[number]["key"]>,
) {
  return providerSeries
    .filter((provider) => keys.includes(provider.key))
    .map((provider) => ({
      ...provider,
      tokens: row?.[provider.key] ?? 0,
      cost: row?.costs?.[provider.key] ?? 0,
    }))
    .filter((entry) => entry.tokens > 0);
}

function TooltipDateStep({
  label,
  disabled,
  onStep,
  children,
}: {
  label: string;
  disabled: boolean;
  onStep: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tooltip-date-step"
      aria-label={label}
      disabled={disabled}
      onClick={onStep}
    >
      {children}
    </button>
  );
}


/** The card's whole body, driven by whichever day it is currently showing.
 * Holding that day here rather than in the tooltip is what lets a pinned copy —
 * which renders the element captured at pin time, detached from the chart —
 * keep stepping through days on its own. */
function ActivityDayCard({
  rows,
  startIndex,
  seriesKeys,
  quotaMarkers,
  timeZone,
  fallbackLabel,
  onStep,
}: {
  rows: TimelineTooltipRow[];
  startIndex: number;
  seriesKeys: Array<(typeof providerSeries)[number]["key"]>;
  quotaMarkers: QuotaMarker[];
  timeZone: string;
  fallbackLabel: string;
  onStep?: (index: number) => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const current = Math.min(Math.max(index, 0), Math.max(rows.length - 1, 0));
  const row = rows[current];
  const point = row?.period ?? row?.hour ?? fallbackLabel;
  const dateLabel = timelineRowLabel(row, fallbackLabel);
  const providers = timelineProviderEntries(row, seriesKeys);
  const projects = tooltipProjects(row);
  const visibleProjects = projects.slice(0, 4);
  const projectTotal = projects.reduce(
    (sum, project) => sum + project.tokens,
    0,
  );
  const projectCost = projects.reduce((sum, project) => sum + project.cost, 0);
  const step = (delta: number) => {
    const next = current + delta;
    if (next < 0 || next >= rows.length) return;
    setIndex(next);
    onStep?.(next);
  };
  return (
    <>
      <div className="tooltip-columns">
        <div className="tooltip-columns__date">
          {rows.length > 1 && (
            <TooltipDateStep
              label={`Show ${timelineRowLabel(rows[current - 1], "the previous point")}`}
              disabled={current === 0}
              onStep={() => step(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </TooltipDateStep>
          )}
          <span className="tooltip-date-label">{dateLabel}</span>
          {rows.length > 1 && (
            <TooltipDateStep
              label={`Show ${timelineRowLabel(rows[current + 1], "the next point")}`}
              disabled={current >= rows.length - 1}
              onStep={() => step(1)}
            >
              <ChevronRight aria-hidden="true" />
            </TooltipDateStep>
          )}
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
        markers={quotaMarkersAt(quotaMarkers, point)}
        timeZone={timeZone}
      />
      {row?.headroom && (row.headroom.anthropic !== null || row.headroom.codex !== null) && (
        <p className="tooltip-headroom">
          Weekly headroom at day's end
          {row.headroom.anthropic !== null && (
            <b> · Claude {Math.round(row.headroom.anthropic)}%</b>
          )}
          {row.headroom.codex !== null && (
            <b> · Codex {Math.round(row.headroom.codex)}%</b>
          )}
        </p>
      )}
      {providers.map((provider) => {
        const models = tooltipModels(row, provider.key);
        const visibleModels = models.slice(0, 3);
        return (
          <section className="tooltip-provider" key={provider.key}>
            <div className="tooltip-provider__head">
              <i style={{ background: provider.color }} />
              <strong>{provider.label}</strong>
              <b>{formatCompact(provider.tokens)}</b>
              <b>{formatMoney(provider.cost)}</b>
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
            <TooltipModelTail
              models={models.slice(visibleModels.length)}
              listClassName="tooltip-provider-models"
              className="tooltip-model-more"
            />
          </section>
        );
      })}
      {providers.length === 0 && (
        <p className="tooltip-empty-day">No recorded activity.</p>
      )}
      {visibleProjects.length > 0 && (
        <section className="tooltip-projects">
          <div className="tooltip-projects__head">
            <strong>Projects</strong>
            <b>{formatCompact(projectTotal)}</b>
            <b>{formatMoney(projectCost)}</b>
          </div>
          <ol className="tooltip-project-list">
            {visibleProjects.map((project) => (
              <TooltipProjectEntry key={project.projectId} project={project} />
            ))}
          </ol>
          {projects.length > visibleProjects.length && (
            <TooltipMoreDisclosure
              className="tooltip-project-more"
              label={`+${projects.length - visibleProjects.length} more projects`}
              tokens={formatCompact(
                projects
                  .slice(visibleProjects.length)
                  .reduce((sum, project) => sum + project.tokens, 0),
              )}
              cost={formatMoney(
                projects
                  .slice(visibleProjects.length)
                  .reduce((sum, project) => sum + project.cost, 0),
              )}
            >
              <ol className="tooltip-project-list">
                {projects.slice(visibleProjects.length).map((project) => (
                  <TooltipProjectEntry
                    key={project.projectId}
                    project={project}
                  />
                ))}
              </ol>
            </TooltipMoreDisclosure>
          )}
        </section>
      )}
    </>
  );
}

function ProviderChartTooltip({
  active,
  payload,
  label,
  coordinate,
  quotaMarkers = [],
  timeZone = systemTimeZone(),
  rows,
}: ChartTooltipProps & {
  quotaMarkers?: QuotaMarker[];
  timeZone?: string;
  /** Every point the chart drew, so the card can step off the hovered one. */
  rows?: TimelineTooltipRow[];
}) {
  const pinSource = useId();
  const [stepped, setStepped] = useState<{ point: string; index: number } | null>(
    null,
  );
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
  const row = snapshotPayload[0]?.payload as TimelineTooltipRow | undefined;
  const fallbackLabel = String(snapshotLabel ?? "");
  const hovered = row?.period ?? row?.hour ?? fallbackLabel;
  const seriesKeys = snapshotPayload
    .map((item) => item.dataKey)
    .filter((key): key is (typeof providerSeries)[number]["key"] =>
      providerSeries.some((provider) => provider.key === key),
    );
  const series = rows?.length ? rows : row ? [row] : [];
  const hoveredIndex = Math.max(
    series.findIndex((item) => (item.period ?? item.hour) === hovered),
    0,
  );
  // A pinned copy renders the element captured here, so a day the card stepped
  // to has to be part of that element rather than only of the card's own state.
  const startIndex =
    stepped?.point === hovered ? stepped.index : hoveredIndex;
  const shownLabel = timelineRowLabel(series[startIndex], fallbackLabel);
  return (
    <PinnableChartTooltip
      id={`${pinSource}:${hovered}`}
      ariaLabel={`activity details for ${shownLabel}`}
      contextLabel="Activity"
      contextDescription="Tokens and API cost grouped by provider, model, and project for this point in time."
      contextPlacement="inline"
      className="provider-tooltip"
      forwardedRef={tooltipRef}
      interactionRef={hold.cardRef}
      retained={hold.retained}
      interactive={hold.interactive}
      cardInteractionProps={hold.cardInteractionProps}
      pinInteractionProps={hold.pinInteractionProps}
    >
      <ActivityDayCard
        key={hovered}
        rows={series}
        startIndex={startIndex}
        seriesKeys={seriesKeys}
        quotaMarkers={quotaMarkers}
        timeZone={timeZone}
        fallbackLabel={fallbackLabel}
        onStep={(index) => setStepped({ point: hovered, index })}
      />
    </PinnableChartTooltip>
  );
}


/** Rank-based slope (bump) chart connecting each model's standing across
 * tokens, cost, and output. The three columns share one scale — rank within the
 * shown set — so a line that dives or climbs is the story: a model that is
 * heavy in tokens but cheap, or expensive relative to what it handed back.
 * Headings sort: the clicked measure becomes the leftmost column and picks the
 * shown set, the previous primary slides to the middle as the tie-break, and
 * re-clicking the primary flips the rank axis. Endpoint labels carry the
 * values; middle standings surface on hover. */
export function ModelSignalSlope({
  models,
  sort,
  onSort,
}: {
  models: Array<{
    rawName: string;
    name: string;
    tokens: number;
    cost: number;
    output: number;
    color: string;
  }>;
  sort: SlopeSort;
  onSort: (measure: SlopeMeasure) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  // The same model name can appear once per agent, so identity is positional.
  const slopes = modelSignalSlopes(models, 8, sort.order).map((model, index) => ({
    ...model,
    slopeKey: `${model.rawName}:${index}`,
  }));
  if (slopes.length === 0) return null;
  const rowHeight = 34;
  const topPad = 30;
  const height = topPad + slopes.length * rowHeight + 6;
  const columnX = [24, 55, 86];
  const columns = sort.order.map((measure, index) => ({
    measure,
    label: SLOPE_MEASURE_LABELS[measure],
    x: columnX[index],
    role: index === 0 ? "primary" : index === 1 ? "secondary" : undefined,
  }));
  const [primary, secondary, last] = columns;
  // Ascending flips the whole rank axis so the lines keep their shape, mirrored.
  const rankY = (rank: number) =>
    topPad +
    ((sort.direction === "asc" ? slopes.length + 1 - rank : rank) - 0.5) * rowHeight;
  const valueLabel = (model: (typeof slopes)[number], measure: SlopeMeasure) =>
    measure === "cost" ? formatMoney(model.cost) : formatCompact(measure === "tokens" ? model.tokens : model.output);
  const summary = slopes
    .map(
      (model) =>
        `${model.name}: tokens rank ${model.ranks.tokens} (${formatCompact(model.tokens)}), cost rank ${model.ranks.cost} (${formatMoney(model.cost)}), output rank ${model.ranks.output} (${formatCompact(model.output)})`,
    )
    .join("; ");
  const dimmed = (slopeKey: string) => hovered !== null && hovered !== slopeKey;
  return (
    <div className="slope-chart__frame">
      {columns.map((column) => (
        <button
          key={column.measure}
          type="button"
          className="slope-chart__sort"
          data-role={column.role}
          style={{ left: `${column.x}%` }}
          aria-pressed={column.role === "primary"}
          aria-label={
            column.role === "primary"
              ? `Sorted by ${column.label}, ${sort.direction === "desc" ? "highest first" : "lowest first"}. Flip direction`
              : `Sort by ${column.label}${column.role === "secondary" ? " (current tie-break)" : ""}`
          }
          title={
            column.role === "primary"
              ? "Primary sort · click to flip"
              : column.role === "secondary"
                ? "Secondary sort · breaks ties in the primary"
                : "Click to sort by this column"
          }
          onClick={() => onSort(column.measure)}
        >
          {column.label}
          <span aria-hidden="true">
            {column.role === "primary"
              ? sort.direction === "desc"
                ? "↓"
                : "↑"
              : column.role === "secondary"
                ? "2"
                : "↕"}
          </span>
        </button>
      ))}
      <div
        className="slope-chart"
        style={{ height }}
        role="img"
        aria-label={`Model standing across ${columns.map((column) => column.label).join(", ")}, sorted by ${primary.label}. ${summary}`}
        onMouseLeave={() => setHovered(null)}
      >
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {slopes.map((model) => (
            <polyline
              key={model.slopeKey}
              points={columns
                .map((column) => `${column.x},${rankY(model.ranks[column.measure])}`)
                .join(" ")}
              fill="none"
              stroke={model.color}
              strokeWidth={hovered === model.slopeKey ? 3 : 2}
              strokeOpacity={dimmed(model.slopeKey) ? 0.18 : 0.9}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
            />
          ))}
        </svg>
        {slopes.map((model) => (
          <Fragment key={model.slopeKey}>
            {columns.map((column) => (
              <i
                key={column.measure}
                className="slope-chart__dot"
                data-dim={dimmed(model.slopeKey) ? "" : undefined}
                style={{
                  left: `${column.x}%`,
                  top: rankY(model.ranks[column.measure]),
                  background: model.color,
                }}
                title={`${model.name} · ${column.label.toLowerCase()} ${valueLabel(model, column.measure)} · ${Math.round(model.shares[column.measure])}% of shown`}
                onMouseEnter={() => setHovered(model.slopeKey)}
              />
            ))}
            <button
              type="button"
              className="slope-chart__name"
              data-dim={dimmed(model.slopeKey) ? "" : undefined}
              style={{ top: rankY(model.ranks[primary.measure]) }}
              onMouseEnter={() => setHovered(model.slopeKey)}
              onFocus={() => setHovered(model.slopeKey)}
              onBlur={() => setHovered(null)}
              aria-label={`Highlight ${model.name}`}
            >
              <span>{model.name}</span>
              <b>{valueLabel(model, primary.measure)}</b>
            </button>
            <span
              className="slope-chart__end"
              data-dim={dimmed(model.slopeKey) ? "" : undefined}
              style={{ top: rankY(model.ranks[last.measure]) }}
            >
              {valueLabel(model, last.measure)}
            </span>
            {hovered === model.slopeKey && (
              <span
                className="slope-chart__mid"
                style={{ left: `${secondary.x}%`, top: rankY(model.ranks[secondary.measure]) }}
              >
                {valueLabel(model, secondary.measure)}
              </span>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export const SLOPE_MEASURE_LABELS: Record<SlopeMeasure, string> = {
  tokens: "TOKENS",
  cost: "API $",
  output: "OUTPUT",
};


/** The avatar letter follows the model family, not a guess from "gpt or not":
 * grok is xAI's, and Warp's pseudo-models are neither Claude nor GPT. */
export function modelAvatarLetter(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt")) return "G";
  if (normalized.includes("claude") || /^(opus|sonnet|haiku|fable)/.test(normalized)) return "C";
  if (normalized.startsWith("grok")) return "X";
  return (normalized.charAt(0) || "?").toUpperCase();
}

export function modelSignalColor(baseColor: string, dominant: string | null) {
  if (dominant === "low")
    return `color-mix(in oklch, ${baseColor} 82%, white)`;
  if (dominant === "high")
    return `color-mix(in oklch, ${baseColor} 82%, black)`;
  if (dominant === "xhigh")
    return `color-mix(in oklch, ${baseColor} 66%, black)`;
  return baseColor;
}

const quotaMarkerColors = {
  anthropic: "var(--anthropic-color)",
  codex: "var(--openai-color)",
} as const;

export function QuotaMarkerLegend({ markers }: { markers: QuotaMarker[] }) {
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
export function QuotaReachNotes({
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

export function QuotaReferenceLines({
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
    const providerLabel = marker.provider === "anthropic" ? "Claude" : "Codex";
    const resetEntry = marker.entries.find((entry) => entry.kind === "reset");
    const reachedEntries = marker.entries.filter((entry) => entry.kind !== "reset");
    const markerLabel = (entries: QuotaMarker["entries"]) => entries
      .map((entry) => `${providerLabel} ${entry.label}${entry.count > 1 ? ` ×${entry.count}` : ""}`)
      .join(" · ");
    const labels = resetEntry && reachedEntries.length > 0
      ? [
          { text: markerLabel(reachedEntries), side: "left" as const },
          { text: markerLabel([resetEntry]), side: "right" as const },
        ]
      : [{ text: marker.label, side: "left" as const }];
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
            const labelY = Number(viewBox.y) + 4;
            return (
              <>
                {labels.map((label) => {
                  const labelX = Number(viewBox.x) +
                    (label.side === "right" ? 11 + sharedXIndex * 7 : -2 - sharedXIndex * 7);
                  const labelWidth = label.text.length * 5.4;
                  return (
                    <g key={label.side} transform={`translate(${labelX} ${labelY}) rotate(-90)`}>
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
                        {label.text}
                      </text>
                    </g>
                  );
                })}
              </>
            );
          },
        }}
      />
    );
  });
}

export function ProviderTimeline({
  rows,
  projectActivity,
  activeProvider,
  quotaHistory,
  timeZone,
  emptyText,
  headroomOverlay = false,
}: {
  rows: MetricRow[];
  projectActivity: ProjectActivity[];
  activeProvider: (typeof providerSeries)[number]["key"] | null;
  quotaHistory: DashboardData["quotas"]["history"];
  timeZone: string;
  emptyText: string;
  /** Overlay observed weekly-window headroom as dashed lines on a 0–100% right
   * axis, so a token spike can be read against what it did to the allowance. */
  headroomOverlay?: boolean;
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
  const headroomByDay = headroomOverlay
    ? dailyHeadroomSeries(quotaHistory ?? undefined, rows.map((row) => row.period), timeZone)
    : new Map<string, DailyHeadroom>();
  const chartData = data.map((row) => {
    const headroom = headroomByDay.get(row.period);
    return headroom
      ? {
          ...row,
          headroom,
          headroomAnthropic: headroom.anthropic,
          headroomCodex: headroom.codex,
        }
      : row;
  });
  const headroomLines = (
    [
      { key: "headroomAnthropic" as const, provider: "anthropic" as const, label: "Claude weekly headroom" },
      { key: "headroomCodex" as const, provider: "codex" as const, label: "Codex weekly headroom" },
    ]
  ).filter(
    (line) =>
      [...headroomByDay.values()].filter((entry) => entry[line.provider] !== null)
        .length >= 2,
  );
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
        {headroomLines.map((line) => {
          const color = providerSeries.find(
            (provider) => provider.key === line.provider,
          )?.color;
          return (
            <div key={line.key} className="provider-legend__headroom">
              <i className="provider-legend__dash" style={{ background: color }} />
              <span>{line.label}</span>
            </div>
          );
        })}
      </div>
      <QuotaMarkerLegend markers={quotaMarkers} />
      <div
        className="chart-wrap provider-chart"
        aria-label="Token usage by day, split into Claude, Codex, and Warp sections"
        role="img"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            margin={{ top: 10, right: headroomLines.length > 0 ? 2 : 8, left: -18, bottom: 0 }}
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
            {headroomLines.length > 0 && (
              <YAxis
                yAxisId="headroom"
                orientation="right"
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                tickFormatter={(value: number) => `${value}%`}
                tick={{ fill: "#71807b", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={30}
              />
            )}
            <Tooltip
              content={
                <ProviderChartTooltip
                  rows={chartData}
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
            {headroomLines.map((line) => {
              const color = providerSeries.find(
                (provider) => provider.key === line.provider,
              )?.color;
              return (
                <Line
                  key={line.key}
                  yAxisId="headroom"
                  type="monotone"
                  dataKey={line.key}
                  name={line.label}
                  stroke={color}
                  strokeWidth={1.4}
                  strokeDasharray="1 3 7 3"
                  strokeLinecap="round"
                  strokeOpacity={0.85}
                  dot={false}
                  activeDot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export function HourlyProviderTimeline({
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
export function EffortByDay({
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
  // Warp per day comes from the combo rows in both modes, so the two breakdowns name the same
  // Warp share for the same day.
  const warpByDay = useMemo(
    () => new Map((combos?.rows ?? []).map((row) => [row.key, row.warpTokens])),
    [combos],
  );
  const effortSeries = useMemo(() => buildEffortDaySeries(aggregate?.rows ?? [], basis, warpByDay), [aggregate, basis, warpByDay]);
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
  // Heaviest first: the tooltip reads top-down in the order the stack reads bottom-up.
  const entries = keys
    .filter((key) => (point.values[key] ?? 0) > 0)
    .sort((a, b) => point.values[b] - point.values[a] || keys.indexOf(a) - keys.indexOf(b));
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
      interactive={hold.interactive}
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

export function Composition({ rows }: { rows: MetricRow[] }) {
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
