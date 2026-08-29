import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  decodeEffortDigest,
  effortScopeParams,
  effortSearchText,
  effortSummaryLabel,
  matchesSessionEffortFilter,
  sessionEffortSortValue,
  type DecodedSessionEffort,
} from "./hooks/use-effort";
import { comboKey, encodeComboFacet, type Combo } from "./combo";
import { EffortCoverage, effortColor, effortLabel, familyColor, familyLabel, sharePercent } from "./components/effort";
import { effortRank } from "./effort-model";
import type { EffortSessionDigest } from "./types";

describe("effort scope params", () => {
  test("omits defaults and preserves the facet", () => {
    expect(effortScopeParams({ providers: [], modelFamilies: [], pathTag: "all", effort: "all" }).toString()).toBe("");
    expect(effortScopeParams({ basis: "sessions", rangeDays: 30, providers: ["codex"], pathTag: "work", project: "/a/b", model: "gpt-5.4", effort: "value:xhigh" }).toString())
      .toBe("basis=sessions&rangeDays=30&providers=codex&pathTag=work&project=%2Fa%2Fb&model=gpt-5.4&effort=value%3Axhigh");
  });
  test("sends both Agent-filter grains as lists", () => {
    expect(effortScopeParams({ providers: ["anthropic"], modelFamilies: ["gpt-5.6-sol", "claude-opus-5"] }).toString())
      .toBe("providers=anthropic&modelFamilies=gpt-5.6-sol%2Cclaude-opus-5");
  });
  test("serializes inclusive custom date bounds", () => {
    expect(effortScopeParams({ fromDate: "2026-07-01", toDate: "2026-07-10" }).toString())
      .toBe("from=2026-07-01&to=2026-07-10");
  });
});

describe("digest v2 decoding", () => {
  // combos: 0 = Opus 5 · high, 1 = Sol · high, 2 = Sol · low
  const digest: EffortSessionDigest = {
    version: 2,
    families: ["claude-opus-5", "gpt-5.6-sol"],
    efforts: ["low", "high"],
    combos: [[0, 1, "interactive"], [1, 1, "interactive"], [1, 0, "interactive"]],
    rows: [
      ["a", 0, 0, 1_000, "1"],
      ["b", 2, 1 | 2 | 8, 600, "6"],
      ["c", -1, 2 | 4, 0, "0"],
      ["d", 0, 8, 900, "3"],
    ],
  };

  test("views never have to index tuple positions", () => {
    const decoded = decodeEffortDigest(digest);
    expect(decoded.get("a")).toMatchObject({
      dominantCombo: { family: "claude-opus-5", effort: "high" },
      dominant: "high",
      mixed: false,
      multipleCombos: false,
      hasUnknown: false,
      unjoinable: false,
      tokenCoverage: 1,
    });
    expect(decoded.get("a")?.combos).toEqual([{ family: "claude-opus-5", effort: "high" }]);
    expect(decoded.get("b")?.dominantCombo).toEqual({ family: "gpt-5.6-sol", effort: "low" });
    expect(decoded.get("b")?.levels).toEqual(new Set(["high", "low"]));
    expect(decoded.get("c")).toMatchObject({ dominantCombo: null, dominant: null, tokenCoverage: null });
  });

  test("mixed effort and multiple combos are separate facts", () => {
    const decoded = decodeEffortDigest(digest);
    // Two combos, but both recorded `high`: several models, one effort.
    expect(decoded.get("d")).toMatchObject({ mixed: false, multipleCombos: true });
    expect(decoded.get("d")?.combos).toHaveLength(2);
    expect(decoded.get("b")).toMatchObject({ mixed: true, multipleCombos: true });
    expect(decoded.get("a")).toMatchObject({ mixed: false, multipleCombos: false });
  });

  test("a combo facet selects sessions containing that family and effort", () => {
    const decoded = decodeEffortDigest(digest);
    const sol = encodeComboFacet({ family: "gpt-5.6-sol", effort: "high" });
    expect(matchesSessionEffortFilter(decoded.get("d"), sol)).toBe(true);
    expect(matchesSessionEffortFilter(decoded.get("a"), sol)).toBe(false);
    expect(matchesSessionEffortFilter(decoded.get("b"), "value:low")).toBe(true);
  });

  test("a missing digest decodes to an empty map rather than throwing", () => {
    expect(decodeEffortDigest(null).size).toBe(0);
  });
});

describe("effort presentation", () => {
  test("known values get fixed colours and unknown values a neutral one", () => {
    expect(effortColor("low")).toBe("var(--aqua)");
    expect(effortColor("xhigh")).toBe("var(--violet)");
    expect(effortColor("unknown")).toBe("var(--line-bright)");
    expect(effortColor("other")).toBe("var(--line-bright)");
  });

  test("an unrecognised value gets a stable, repeatable colour", () => {
    expect(effortColor("turbo")).toBe(effortColor("turbo"));
    expect(effortColor("turbo")).not.toBe(effortColor("unknown"));
  });

  test("labels stay readable without inventing a value", () => {
    expect(effortLabel(null)).toBe("Unknown");
    expect(effortLabel("xhigh")).toBe("X-high");
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel("turbo")).toBe("Turbo");
  });

  test("model families have compact labels and stable colours of their own", () => {
    expect(familyLabel("claude-fable-5")).toBe("Fable 5");
    expect(familyLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(familyLabel("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(familyColor("claude-fable-5")).toBe(familyColor("claude-fable-5"));
    expect(familyColor("claude-fable-5")).not.toBe(familyColor("claude-opus-5"));
  });
});

describe("Sessions view effort behaviour", () => {
  const decodedOf = (combos: Combo[], overrides: Partial<DecodedSessionEffort> = {}): DecodedSessionEffort => ({
    sessionId: "a",
    dominantCombo: combos[0] ?? null,
    dominant: combos[0]?.effort ?? null,
    combos,
    mixed: new Set(combos.map((combo) => combo.effort)).size >= 2,
    multipleCombos: combos.length >= 2,
    hasUnknown: false,
    unjoinable: false,
    tokenCoverage: 1,
    levels: new Set(combos.map((combo) => combo.effort)),
    comboKeys: new Set(combos.map(comboKey)),
    ...overrides,
  });
  const known = decodedOf([{ family: "claude-opus-5", effort: "high" }]);
  const mixed = decodedOf(
    [{ family: "gpt-5.6-luna", effort: "low" }, { family: "claude-opus-5", effort: "high" }],
    { sessionId: "b", hasUnknown: true },
  );
  const unknown = decodedOf([], { sessionId: "c", tokenCoverage: null });

  test("model, effort, Mixed, and Unknown stay searchable as words", () => {
    expect(effortSearchText(known)).toBe("opus 5 claude-opus-5 high");
    expect(effortSearchText(mixed)).toContain("mixed");
    expect(effortSearchText(mixed)).toContain("unknown");
    expect(effortSearchText(unknown)).toBe("unknown");
    expect(effortSearchText(undefined)).toBe("unknown");
  });

  test("a model-and-effort query such as `luna max` finds its sessions", () => {
    const luna = decodedOf([{ family: "gpt-5.6-luna", effort: "max" }]);
    expect(effortSearchText(luna).includes("luna")).toBe(true);
    expect("luna max".split(" ").every((word) => effortSearchText(luna).includes(word))).toBe(true);
    expect("luna max".split(" ").every((word) => effortSearchText(known).includes(word))).toBe(false);
  });

  test("the filter covers All, each value, Mixed, and Unknown", () => {
    expect(matchesSessionEffortFilter(known, "all")).toBe(true);
    expect(matchesSessionEffortFilter(known, "high")).toBe(true);
    expect(matchesSessionEffortFilter(known, "value:high")).toBe(true);
    expect(matchesSessionEffortFilter(known, "low")).toBe(false);
    expect(matchesSessionEffortFilter(mixed, "mixed")).toBe(true);
    expect(matchesSessionEffortFilter(mixed, "high")).toBe(true);
    expect(matchesSessionEffortFilter(known, "mixed")).toBe(false);
    expect(matchesSessionEffortFilter(unknown, "unknown")).toBe(true);
    // A session the digest has never heard of is Unknown, not silently dropped.
    expect(matchesSessionEffortFilter(undefined, "unknown")).toBe(true);
    expect(matchesSessionEffortFilter(undefined, "high")).toBe(false);
  });

  test("sorting follows canonical order and puts Unknown last", () => {
    const rank = (decoded: Parameters<typeof sessionEffortSortValue>[0]) => sessionEffortSortValue(decoded, effortRank);
    expect(rank({ ...known, dominant: "low" })).toBeLessThan(rank({ ...known, dominant: "medium" }));
    expect(rank({ ...known, dominant: "medium" })).toBeLessThan(rank({ ...known, dominant: "high" }));
    expect(rank({ ...known, dominant: "high" })).toBeLessThan(rank({ ...known, dominant: "xhigh" }));
    expect(rank({ ...known, dominant: "xhigh" })).toBeLessThan(rank({ ...known, dominant: "max" }));
    expect(rank({ ...known, dominant: "max" })).toBeLessThan(rank({ ...known, dominant: "turbo" }));
    expect(rank(unknown)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rank(undefined)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("keyboard and empty-state labels never rely on colour", () => {
    expect(effortSummaryLabel(known)).toBe("Opus 5 · High");
    expect(effortSummaryLabel(mixed)).toBe("GPT 5.6 Luna · Low and 1 more");
    expect(effortSummaryLabel(unknown)).toBe("unknown");
  });
});

describe("share formatting", () => {
  test("a present but tiny slice never reads as nothing", () => {
    expect(sharePercent(220_500, 114_000_000)).toBe("<1%");
    expect(sharePercent(0, 114_000_000)).toBe("0%");
    expect(sharePercent(113_800_000, 114_000_000)).toBe("100%");
    expect(sharePercent(1, 0)).toBe("—");
  });
});

describe("coverage wording", () => {
  // Every observation carried an effort, but the five of them reach 7% of the session's tokens.
  // Read as percentages alone that is "100% of 5 observations", which looks like full coverage.
  const summary = {
    observedObservations: 5,
    unknownObservations: 0,
    observationCoverage: 1,
    eligibleTokens: 2_772_328,
    attributedTokens: 197_180,
    unknownTokens: 2_575_148,
    tokenCoverage: 0.0711,
  };

  test("the detailed form gives both percentages their counts", () => {
    const html = renderToStaticMarkup(createElement(EffortCoverage, { summary, detail: true }));
    expect(html).toContain("197.2K of 2.8M tokens have a recorded effort (7%)");
    expect(html).toContain("5 of 5 recorded observations carried one");
  });

  test("the compact form is unchanged for the views that only have one line", () => {
    const html = renderToStaticMarkup(createElement(EffortCoverage, { summary }));
    expect(html).toContain("7% of tokens have a recorded effort · 100% of 5 observations");
  });
});
