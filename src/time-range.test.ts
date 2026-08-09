import { describe, expect, test } from "bun:test";
import {
  metricRangeRows,
  resolvedDateRange,
  validDateKey,
  validDateRange,
} from "./time-range";
import type { MetricRow } from "./types";

const rows = ["2026-07-01", "2026-07-10", "2026-07-20"].map(
  (period) => ({ period }) as MetricRow,
);

describe("time ranges", () => {
  test("presets anchor to the latest collected day", () => {
    expect(resolvedDateRange(rows, "7")).toEqual({ from: "2026-07-14", to: "2026-07-20" });
    expect(metricRangeRows(rows, "7").map((row) => row.period)).toEqual(["2026-07-20"]);
  });

  test("custom ranges include both endpoints", () => {
    const custom = { from: "2026-07-01", to: "2026-07-10" };
    expect(metricRangeRows(rows, "custom", custom).map((row) => row.period)).toEqual([
      "2026-07-01",
      "2026-07-10",
    ]);
  });

  test("the previous custom comparison has equal length", () => {
    expect(
      resolvedDateRange(rows, "custom", { from: "2026-07-10", to: "2026-07-20" }, 1),
    ).toEqual({ from: "2026-06-29", to: "2026-07-09" });
  });

  test("invalid and reversed dates are rejected", () => {
    expect(validDateKey("2026-02-30")).toBe(false);
    expect(validDateRange({ from: "2026-07-20", to: "2026-07-10" })).toBe(false);
  });
});
