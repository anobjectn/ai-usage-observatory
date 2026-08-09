import type { MetricRow } from "./types";

export type PresetMetricRange = "1" | "7" | "14" | "30" | "120" | "all";
export type MetricRange = PresetMetricRange | "custom";
export type DateRange = { from: string; to: string };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function validDateKey(value: string | null | undefined): value is string {
  if (!value || !datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function rangeLength(range: DateRange) {
  const from = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = Date.parse(`${range.to}T00:00:00.000Z`);
  return Math.floor((to - from) / 86_400_000) + 1;
}

export function validDateRange(range: DateRange | null | undefined): range is DateRange {
  return Boolean(range && validDateKey(range.from) && validDateKey(range.to) && range.from <= range.to);
}

export function availableDateRange(rows: MetricRow[]): DateRange | null {
  const periods = rows.map((row) => row.period).filter(validDateKey).sort();
  return periods.length ? { from: periods[0], to: periods.at(-1)! } : null;
}

/** Resolves a preset or custom selection to inclusive calendar bounds. Presets are anchored to
 * the latest collected day rather than the wall clock, so a temporarily stale local snapshot
 * still renders its most recent activity. `offset=1` returns the preceding equal-length span. */
export function resolvedDateRange(
  rows: MetricRow[],
  range: MetricRange,
  customRange: DateRange | null = null,
  offset = 0,
): DateRange | null {
  const available = availableDateRange(rows);
  if (!available) return null;
  if (range === "all") return offset === 0 ? available : null;
  if (range === "custom") {
    if (!validDateRange(customRange)) return null;
    const days = rangeLength(customRange);
    return {
      from: shiftDateKey(customRange.from, -days * offset),
      to: shiftDateKey(customRange.to, -days * offset),
    };
  }
  const days = Number(range);
  const to = shiftDateKey(available.to, -days * offset);
  return { from: shiftDateKey(to, -(days - 1)), to };
}

export function metricRangeRows(
  rows: MetricRow[],
  range: MetricRange,
  customRange: DateRange | null = null,
  offset = 0,
) {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.period.localeCompare(b.period));
  const bounds = resolvedDateRange(sorted, range, customRange, offset);
  if (!bounds) return [];
  return sorted.filter((row) => row.period >= bounds.from && row.period <= bounds.to);
}

function readableDate(value: string, includeYear = false) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
  });
}

export function dateRangeLabel(range: DateRange | null) {
  if (!range) return "No dates selected";
  if (range.from === range.to) return readableDate(range.from, true);
  return `${readableDate(range.from)}–${readableDate(range.to, true)}`;
}

export function metricRangeLabel(range: MetricRange, customRange: DateRange | null) {
  if (range === "all") return "All time";
  if (range === "custom") return dateRangeLabel(customRange);
  if (range === "1") return "Latest day";
  return `Last ${range} days`;
}
