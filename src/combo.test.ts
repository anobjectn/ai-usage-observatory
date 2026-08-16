import { describe, expect, test } from "bun:test";
import type { EffortComboBucket, EffortComboDayRow } from "./types";
import {
  buildComboDaySeries,
  comboSeriesColor,
  comboSeriesLabel,
  capComboBuckets,
  comboColor,
  comboKey,
  comboKind,
  comboLabel,
  comboOf,
  comboShortLabel,
  compareComboKeys,
  encodeComboFacet,
  parseComboFacet,
  parseComboKey,
  selectComboSeries,
} from "./combo";
import { compareEffort, effortRank, sortEffortBuckets } from "./effort-model";
import { effortColor } from "./combo";

const bucket = (family: string, effort: string, tokens: number, observations = 0) => ({ family, effort, tokens, observations });
const amount = (family: string, effort: string, value: number) => ({ family, effort, amount: value });

describe("effort ordering", () => {
  test("max sorts after xhigh", () => {
    expect(effortRank("max")).toBeGreaterThan(effortRank("xhigh"));
    expect(compareEffort("xhigh", "max")).toBeLessThan(0);
    expect(sortEffortBuckets([{ effort: "max" }, { effort: "low" }, { effort: "xhigh" }, { effort: "high" }]).map((b) => b.effort))
      .toEqual(["low", "high", "xhigh", "max"]);
  });

  test("an unknown future effort still sorts after every canonical one", () => {
    expect(compareEffort("max", "ludicrous")).toBeLessThan(0);
    expect(sortEffortBuckets([{ effort: "ludicrous" }, { effort: "max" }, { effort: "medium" }]).map((b) => b.effort))
      .toEqual(["medium", "max", "ludicrous"]);
  });

  test("max has an explicit effort-only colour distinct from unknown", () => {
    expect(effortColor("max")).toBe("var(--red)");
    expect(effortColor("max")).not.toBe(effortColor("unknown"));
    expect(effortColor("max")).not.toBe(effortColor("xhigh"));
  });
});

describe("comboOf", () => {
  test("collapses raw release aliases to one family combo", () => {
    expect(comboOf("claude-opus-5-20260114", "High")).toEqual({ family: "claude-opus-5", effort: "high" });
    expect(comboOf("claude-opus-5-latest", " HIGH ")).toEqual({ family: "claude-opus-5", effort: "high" });
    expect(comboKey(comboOf("claude-opus-5-20260114", "high")))
      .toBe(comboKey(comboOf("claude-opus-5-latest", "high")));
  });

  test("keeps codenamed families apart", () => {
    expect(comboOf("gpt-5.6-sol", "high").family).toBe("gpt-5.6-sol");
    expect(comboOf("gpt-5.4", "high").family).toBe("gpt-5.4");
  });

  test("an empty model is unknown and an unrecorded effort stays empty", () => {
    expect(comboOf("", "")).toEqual({ family: "unknown", effort: "" });
    expect(comboOf(null, undefined)).toEqual({ family: "unknown", effort: "" });
  });
});

describe("combo keys and facets", () => {
  test("keys round-trip", () => {
    const combo = { family: "claude-opus-5", effort: "xhigh" };
    expect(parseComboKey(comboKey(combo))).toEqual(combo);
    expect(parseComboKey(comboKey({ family: "unknown", effort: "" }))).toEqual({ family: "unknown", effort: "" });
  });

  test("malformed keys are rejected rather than guessed", () => {
    expect(parseComboKey("claude-opus-5")).toBeNull();
    expect(parseComboKey("")).toBeNull();
    expect(parseComboKey("\0high")).toBeNull();
  });

  test("facet values round-trip and stay URL-safe", () => {
    const combo = { family: "gpt-5.6-sol", effort: "max" };
    const encoded = encodeComboFacet(combo);
    expect(encoded).toBe('combo:["gpt-5.6-sol","max"]');
    expect(encodeURIComponent(encoded)).not.toContain("%00");
    expect(parseComboFacet(encoded)).toEqual(combo);
  });

  test("a delimiter inside a future model name cannot collide", () => {
    const combo = { family: "weird:model,name|v2", effort: "high" };
    expect(parseComboFacet(encodeComboFacet(combo))).toEqual(combo);
  });

  test("malformed facet values are rejected", () => {
    expect(parseComboFacet("value:high")).toBeNull();
    expect(parseComboFacet("combo:not-json")).toBeNull();
    expect(parseComboFacet('combo:["only-one"]')).toBeNull();
    expect(parseComboFacet('combo:["",  "high"]')).toBeNull();
    expect(parseComboFacet(null)).toBeNull();
  });

  test("lexical comparison stays pure and volume-free", () => {
    const keys = [comboKey({ family: "b", effort: "low" }), comboKey({ family: "a", effort: "max" }), comboKey({ family: "a", effort: "low" })];
    expect([...keys].sort(compareComboKeys)).toEqual([
      comboKey({ family: "a", effort: "low" }),
      comboKey({ family: "a", effort: "max" }),
      comboKey({ family: "b", effort: "low" }),
    ]);
  });
});

describe("comboKind", () => {
  test("classifies unknown, synthetic, automated, and interactive", () => {
    expect(comboKind("")).toBe("unknown");
    expect(comboKind("unknown")).toBe("unknown");
    expect(comboKind("<synthetic>")).toBe("synthetic");
    expect(comboKind("codex-auto-review")).toBe("automated");
    expect(comboKind("claude-opus-5")).toBe("interactive");
    expect(comboKind("gpt-5.6-sol")).toBe("interactive");
  });
});

describe("labels and colour", () => {
  test("a combo always names its model and its effort", () => {
    expect(comboLabel({ family: "claude-opus-5", effort: "high" })).toBe("Opus 5 · High");
    expect(comboShortLabel({ family: "claude-opus-5", effort: "xhigh" })).toBe("Opus 5 XH");
    expect(comboLabel({ family: "unknown", effort: "" })).toBe("Unknown model · Unknown");
  });

  test("higher effort approaches the base family colour and never mixes toward black", () => {
    const low = comboColor({ family: "claude-opus-5", effort: "low" });
    const max = comboColor({ family: "claude-opus-5", effort: "max" });
    expect(low).toContain("white");
    expect(low).not.toContain("black");
    expect(max).toBe("var(--orange)");
    expect(low).not.toBe(max);
  });

  test("unknown families stay neutral rather than borrowing an effort hue", () => {
    expect(comboColor({ family: "unknown", effort: "high" })).toBe("var(--line-bright)");
  });
});

describe("selectComboSeries", () => {
  test("selects the top N globally, then orders by family block and effort rank", () => {
    const keys = selectComboSeries([
      amount("claude-opus-5", "high", 100),
      amount("claude-opus-5", "low", 40),
      amount("gpt-5.6-sol", "max", 500),
      amount("gpt-5.6-sol", "medium", 20),
      amount("claude-haiku-4-5", "low", 5),
    ], 4);
    expect(keys.map((key) => parseComboKey(key))).toEqual([
      { family: "gpt-5.6-sol", effort: "medium" },
      { family: "gpt-5.6-sol", effort: "max" },
      { family: "claude-opus-5", effort: "low" },
      { family: "claude-opus-5", effort: "high" },
    ]);
  });

  test("ignores buckets with no recorded effort", () => {
    expect(selectComboSeries([amount("claude-opus-5", "", 1e9), amount("claude-opus-5", "low", 1)], 6))
      .toEqual([comboKey({ family: "claude-opus-5", effort: "low" })]);
  });

  test("selection is stable when volumes tie", () => {
    const input = [amount("b-model", "low", 10), amount("a-model", "low", 10)];
    expect(selectComboSeries(input, 1)).toEqual(selectComboSeries([...input].reverse(), 1));
  });
});

describe("capComboBuckets", () => {
  test("preserves totals through other and keeps unrecorded effort separate", () => {
    const buckets = [
      bucket("claude-opus-5", "high", 100, 10),
      bucket("gpt-5.6-sol", "max", 50, 5),
      bucket("claude-haiku-4-5", "low", 7, 2),
      bucket("unknown", "", 900, 90),
    ];
    const selected = [comboKey({ family: "claude-opus-5", effort: "high" })];
    const { kept, other, unrecorded } = capComboBuckets(buckets, selected);
    expect(kept).toHaveLength(1);
    expect(other).toEqual({ tokens: 57, observations: 7, combos: 2 });
    expect(unrecorded).toEqual({ tokens: 900, observations: 90 });
    expect(kept[0].tokens + other.tokens + unrecorded.tokens)
      .toBe(buckets.reduce((sum, item) => sum + item.tokens, 0));
  });

  test("kept buckets follow the selected series order, not the input order", () => {
    const selected = [
      comboKey({ family: "gpt-5.6-sol", effort: "max" }),
      comboKey({ family: "claude-opus-5", effort: "high" }),
    ];
    const { kept } = capComboBuckets(
      [bucket("claude-opus-5", "high", 1), bucket("gpt-5.6-sol", "max", 2)],
      selected,
    );
    expect(kept.map(comboKey)).toEqual(selected);
  });
});

const comboBucket = (family: string, effort: string, tokens: number, observations = 1): EffortComboBucket => ({
  family,
  effort,
  kind: "interactive",
  tokens,
  observations,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  reasoningReportedEvents: 0,
  reasoningShare: null,
});

function day(
  key: string,
  buckets: EffortComboBucket[],
  { eligibleTokens, unknownObservations = 0, suppressed = false }: { eligibleTokens: number; unknownObservations?: number; suppressed?: boolean },
): EffortComboDayRow {
  const attributedTokens = buckets.filter((bucket) => bucket.effort).reduce((sum, bucket) => sum + bucket.tokens, 0);
  const observedObservations = buckets.filter((bucket) => bucket.effort).reduce((sum, bucket) => sum + bucket.observations, 0);
  return {
    key,
    buckets,
    suppressed,
    coverage: {
      observedObservations,
      unknownObservations,
      observationCoverage: observedObservations + unknownObservations > 0 ? observedObservations / (observedObservations + unknownObservations) : null,
      eligibleTokens,
      attributedTokens,
      unknownTokens: suppressed ? null : eligibleTokens - attributedTokens,
      tokenCoverage: suppressed || eligibleTokens === 0 ? null : attributedTokens / eligibleTokens,
    },
  };
}

describe("buildComboDaySeries", () => {
  const rows = [
    day("2026-07-01", [comboBucket("claude-opus-5", "high", 400), comboBucket("gpt-5.6-sol", "max", 300)], { eligibleTokens: 1_000 }),
    day("2026-07-02", [comboBucket("claude-opus-5", "high", 100), comboBucket("claude-haiku-4-5", "low", 20), comboBucket("claude-sonnet-5", "medium", 10)], { eligibleTokens: 200 }),
    day("2026-07-03", [], { eligibleTokens: 500 }),
  ];

  test("selects keys once for the whole range so a combo cannot vanish between bars", () => {
    const { keys, points } = buildComboDaySeries(rows, "tokens", 2);
    expect(keys).toEqual([
      comboKey({ family: "claude-opus-5", effort: "high" }),
      comboKey({ family: "gpt-5.6-sol", effort: "max" }),
      "other",
      "unknown",
    ]);
    for (const point of points) expect(Object.keys(point.values)).toEqual(keys);
  });

  test("caps preserve each day's total instead of discarding the remainder", () => {
    const { points } = buildComboDaySeries(rows, "tokens", 2);
    const second = points[1];
    expect(second.values[comboKey({ family: "claude-opus-5", effort: "high" })]).toBe(100);
    expect(second.values.other).toBe(30);
    expect(second.values.unknown).toBe(70);
    expect(second.total).toBe(200);
    for (const point of points) expect(point.total).toBe(point.row.coverage.eligibleTokens);
  });

  test("a denominator-only day draws entirely as Unknown", () => {
    const { points } = buildComboDaySeries(rows, "tokens", 6);
    const blank = points[2];
    expect(blank.values.unknown).toBe(500);
    expect(blank.total).toBe(500);
    expect(blank.suppressed).toBe(false);
  });

  test("switching basis re-selects on observations and uses observation coverage", () => {
    const observationRows = [
      day("2026-07-01", [comboBucket("claude-opus-5", "high", 900, 1), comboBucket("gpt-5.6-sol", "low", 10, 40)], { eligibleTokens: 1_000, unknownObservations: 9 }),
    ];
    expect(buildComboDaySeries(observationRows, "tokens", 1).keys[0]).toBe(comboKey({ family: "claude-opus-5", effort: "high" }));
    const byObservation = buildComboDaySeries(observationRows, "observations", 1);
    expect(byObservation.keys[0]).toBe(comboKey({ family: "gpt-5.6-sol", effort: "low" }));
    expect(byObservation.points[0].values.unknown).toBe(9);
    expect(byObservation.points[0].values.other).toBe(1);
  });

  test("a suppressed day draws nothing and is counted", () => {
    const suppressed = [
      day("2026-07-01", [comboBucket("claude-opus-5", "high", 400)], { eligibleTokens: 1_000 }),
      day("2026-07-02", [comboBucket("claude-opus-5", "high", 9_000)], { eligibleTokens: 100, suppressed: true }),
    ];
    const { points, suppressedDays } = buildComboDaySeries(suppressed, "tokens", 6);
    expect(suppressedDays).toBe(1);
    expect(points[1].total).toBe(0);
    // The suppressed day must not influence which series the whole range draws.
    expect(points[0].values[comboKey({ family: "claude-opus-5", effort: "high" })]).toBe(400);
  });

  test("no Other series appears when every combo fits the budget", () => {
    expect(buildComboDaySeries(rows, "tokens", 6).keys).not.toContain("other");
  });

  test("unrecorded-effort buckets are Unknown, never the tail of Other", () => {
    const withUnrecorded = [
      day("2026-07-01", [comboBucket("claude-opus-5", "high", 400), comboBucket("unknown", "", 100, 5)], { eligibleTokens: 1_000, unknownObservations: 5 }),
    ];
    const { points } = buildComboDaySeries(withUnrecorded, "tokens", 6);
    expect(points[0].values.unknown).toBe(600);
    expect(points[0].values.other).toBeUndefined();
    expect(points[0].total).toBe(1_000);
  });

  test("reserved series keys carry text labels and neutral colour", () => {
    expect(comboSeriesLabel("other")).toBe("Other combos");
    expect(comboSeriesLabel("unknown")).toBe("Unknown");
    expect(comboSeriesLabel(comboKey({ family: "claude-opus-5", effort: "high" }))).toBe("Opus 5 · High");
    expect(comboSeriesColor("other")).toBe(comboSeriesColor("unknown"));
    expect(comboSeriesColor(comboKey({ family: "claude-opus-5", effort: "high" }))).not.toBe(comboSeriesColor("other"));
  });
});
