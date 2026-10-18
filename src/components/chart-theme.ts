import type { CSSProperties } from "react";

/**
 * Shared Recharts styling. Every chart takes its grid, axes, cursors, active dots, and tooltip
 * chrome from here, and these read the chart tokens in styles/tokens.css. SVG presentation
 * attributes and inline styles both resolve var(), so charts follow the theme without a render.
 */

export const chartGridProps = { stroke: "var(--color-chart-grid)", strokeDasharray: "2 5" } as const;

export const chartSolidGridProps = { stroke: "var(--color-chart-grid)" } as const;

/** Axes draw tick labels only; the grid carries the structure. */
export const chartAxisProps = { tickLine: false, axisLine: false } as const;

const tick = (fill: string, fontSize: string) => ({ fill, fontSize, fontFamily: "var(--chart-font)" });

export const chartTick = tick("var(--color-chart-label)", "var(--chart-text)");

export const chartTickCompact = tick("var(--color-chart-label)", "var(--chart-text-compact)");

/** Category axes whose labels name things (models) rather than measure them. */
export const chartCategoryTick = tick("var(--color-chart-label-strong)", "var(--chart-text)");

export const chartLineCursor = { stroke: "var(--color-chart-cursor)", strokeDasharray: "3 3" } as const;

export const chartBarCursor = { fill: "var(--color-chart-cursor-fill)" } as const;

export const chartActiveDot = (stroke: string) => ({
  r: 4,
  fill: "var(--color-chart-dot-fill)",
  stroke,
  strokeWidth: 2,
});

/** Bar corner radii (Recharts takes numbers, so these cannot read --radius-* tokens). Columns
 * round their top; horizontal rows round their end; marker labels use a small rounded box. */
export const chartColumnRadius: [number, number, number, number] = [3, 3, 0, 0];
export const chartRowRadius: [number, number, number, number] = [0, 6, 6, 0];
export const chartLabelRadius = 1.5;

/** Area fills fade from these opacities at the line to the baseline. */
export const chartAreaOpacity = { top: 0.58, bottom: 0.1 } as const;

/** Recharts' built-in tooltip, for charts without a custom tooltip component. */
export const chartDefaultTooltipStyle: CSSProperties = {
  background: "var(--color-chart-tooltip-bg)",
  border: "1px solid var(--color-chart-tooltip-border)",
  borderRadius: "var(--radius-control)",
};

/** Tooltips follow the pointer immediately; the wrapper's default slide reads as lag. */
export const chartTooltipWrapperStyle = {
  transition: "none",
} as const;
