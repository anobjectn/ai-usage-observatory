import { describe, expect, test } from "bun:test";
import {
  decodeEffortDigest,
  effortScopeParams,
  effortSearchText,
  effortSummaryLabel,
  matchesSessionEffortFilter,
  sessionEffortSortValue,
} from "./hooks/use-effort";
import { effortColor, effortLabel, familyColor, familyLabel, sharePercent } from "./components/effort";
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
});

describe("digest decoding", () => {
  const digest: EffortSessionDigest = {
    levels: ["high", "low"],
    rows: [
      ["a", 0, 0, 1_000, "1"],
      ["b", 1, 1 | 2, 600, "3"],
      ["c", -1, 2 | 4, 0, "0"],
    ],
  };

  test("views never have to index tuple positions", () => {
    const decoded = decodeEffortDigest(digest);
    expect(decoded.get("a")).toMatchObject({ dominant: "high", mixed: false, hasUnknown: false, unjoinable: false, tokenCoverage: 1 });
    expect(decoded.get("a")?.levels).toEqual(new Set(["high"]));
    expect(decoded.get("b")).toMatchObject({ dominant: "low", mixed: true, hasUnknown: true, tokenCoverage: 0.6 });
    expect(decoded.get("b")?.levels).toEqual(new Set(["high", "low"]));
    expect(decoded.get("c")).toMatchObject({ dominant: null, mixed: false, hasUnknown: true, unjoinable: true, tokenCoverage: null });
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
  const known = { sessionId: "a", dominant: "high", mixed: false, hasUnknown: false, unjoinable: false, tokenCoverage: 1, levels: new Set(["high"]) };
  const mixed = { ...known, sessionId: "b", dominant: "low", mixed: true, hasUnknown: true, levels: new Set(["low", "high"]) };
  const unknown = { ...known, sessionId: "c", dominant: null, tokenCoverage: null, levels: new Set<string>() };

  test("Mixed and Unknown stay searchable as words", () => {
    expect(effortSearchText(known)).toBe("high");
    expect(effortSearchText(mixed)).toBe("low high mixed unknown");
    expect(effortSearchText(unknown)).toBe("unknown");
    expect(effortSearchText(undefined)).toBe("unknown");
  });

  test("the filter covers All, each value, Mixed, and Unknown", () => {
    expect(matchesSessionEffortFilter(known, "all")).toBe(true);
    expect(matchesSessionEffortFilter(known, "high")).toBe(true);
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
    expect(rank({ ...known, dominant: "xhigh" })).toBeLessThan(rank({ ...known, dominant: "turbo" }));
    expect(rank(unknown)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rank(undefined)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("keyboard and empty-state labels never rely on colour", () => {
    expect(effortSummaryLabel(known)).toBe("high");
    expect(effortSummaryLabel(mixed)).toBe("mixed, mostly low");
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
