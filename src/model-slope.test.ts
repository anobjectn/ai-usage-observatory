import { expect, test } from "bun:test";
import { DEFAULT_SLOPE_SORT, modelSignalSlopes, nextSlopeSort } from "./model-slope";

const model = (
  rawName: string,
  tokens: number,
  cost: number,
  output: number,
) => ({ rawName, name: rawName, tokens, cost, output });

test("ranks each measure independently within the shown set", () => {
  const slopes = modelSignalSlopes([
    model("sol", 675, 408, 2.6),
    model("luna", 342, 12, 1.6),
    model("opus", 641, 517, 3.2),
  ]);
  const byName = new Map(slopes.map((entry) => [entry.rawName, entry]));
  expect(byName.get("sol")?.ranks).toEqual({ tokens: 1, cost: 2, output: 2 });
  expect(byName.get("opus")?.ranks).toEqual({ tokens: 2, cost: 1, output: 1 });
  // Luna's cheapness is the divergence the chart exists to show.
  expect(byName.get("luna")?.ranks).toEqual({ tokens: 3, cost: 3, output: 3 });
});

test("keeps only the top models by tokens and shares sum to 100 within them", () => {
  const slopes = modelSignalSlopes(
    [
      model("a", 100, 1, 1),
      model("b", 90, 1, 1),
      model("c", 10, 50, 1),
    ],
    2,
  );
  expect(slopes.map((entry) => entry.rawName)).toEqual(["a", "b"]);
  const tokenShare = slopes.reduce((sum, entry) => sum + entry.shares.tokens, 0);
  expect(Math.round(tokenShare)).toBe(100);
});

test("handles zero totals without dividing by zero", () => {
  const slopes = modelSignalSlopes([model("a", 10, 0, 0)]);
  expect(slopes[0].shares.cost).toBe(0);
  expect(slopes[0].shares.output).toBe(0);
});

test("the primary measure picks the shown set and the secondary breaks ties", () => {
  const slopes = modelSignalSlopes(
    [
      model("heavy", 100, 1, 1),
      model("pricey", 10, 50, 1),
      model("also-pricey", 10, 50, 9),
    ],
    2,
    ["cost", "output", "tokens"],
  );
  expect(slopes.map((entry) => entry.rawName)).toEqual(["also-pricey", "pricey"]);
  expect(slopes[0].ranks).toEqual({ cost: 1, output: 1, tokens: 1 });
  expect(slopes[1].ranks).toEqual({ cost: 2, output: 2, tokens: 2 });
});

test("clicking a heading promotes it and demotes the old primary to tie-break", () => {
  const first = nextSlopeSort(DEFAULT_SLOPE_SORT, "cost");
  expect(first).toEqual({ order: ["cost", "tokens", "output"], direction: "desc" });
  const second = nextSlopeSort(first, "output");
  expect(second).toEqual({ order: ["output", "cost", "tokens"], direction: "desc" });
  expect(nextSlopeSort(second, "output").direction).toBe("asc");
  // Leaving an ascending primary for another column resets to descending.
  expect(nextSlopeSort(nextSlopeSort(second, "output"), "tokens")).toEqual({
    order: ["tokens", "output", "cost"],
    direction: "desc",
  });
});
