import { describe, expect, test } from "bun:test";
import { decomposeModelRow, footnotesFor, summarizeTokenTypes, tokenTypeOrder } from "./token-types";
import type { ModelBreakdown, ModelRate } from "./types";

// Per-token USD, shaped like LiteLLM's claude-opus-5 and gpt-5.6-sol entries.
const opus: ModelRate = { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6, cacheWrite5m: 6.25e-6, cacheWrite1h: 10e-6 };
const sol: ModelRate = { input: 4e-6, output: 20e-6, cacheRead: 0.4e-6, cacheWrite5m: 5e-6, cacheWrite1h: null };

const breakdown = (modelName: string, tokens: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>, cost: number): ModelBreakdown => ({
  modelName,
  inputTokens: tokens.input ?? 0,
  outputTokens: tokens.output ?? 0,
  cacheReadTokens: tokens.cacheRead ?? 0,
  cacheCreationTokens: tokens.cacheWrite ?? 0,
  cost,
});

/** ccusage-style cost: rates times tokens, with a chosen share of writes at the 1-hour rate. */
const price = (rate: ModelRate, tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, oneHourShare = 0) =>
  (tokens.input ?? 0) * rate.input +
  (tokens.output ?? 0) * rate.output +
  (tokens.cacheRead ?? 0) * rate.cacheRead +
  (tokens.cacheWrite ?? 0) * ((1 - oneHourShare) * rate.cacheWrite5m + oneHourShare * (rate.cacheWrite1h ?? rate.cacheWrite5m));

const card = { models: { "claude-opus-5": opus, "gpt-5.6-sol": sol } };

describe("decomposeModelRow", () => {
  test("Codex rows must match exactly and split by rate", () => {
    const tokens = { input: 40_000, output: 12_000, cacheRead: 900_000, cacheWrite: 0 };
    const row = decomposeModelRow(breakdown("gpt-5.6-sol", tokens, price(sol, tokens)), sol, false, "codex");
    expect(row.reconciled).toBe(true);
    expect(row.costs?.input).toBeCloseTo(0.16, 6);
    expect(row.costs?.cacheWrite).toBe(0);
    expect(row.impliedOneHourShare).toBeNull();
  });

  test("a Codex row priced away from its rates is withheld as a mismatch", () => {
    const tokens = { input: 40_000, output: 12_000, cacheRead: 900_000 };
    const row = decomposeModelRow(breakdown("gpt-5.6-sol", tokens, price(sol, tokens) * 1.05), sol, false, "codex");
    expect(row.reconciled).toBe(false);
    expect(row.reason).toBe("mismatch");
    expect(row.costs).toBeNull();
  });

  test("a Claude row reconciles anywhere between the all-5-minute and all-1-hour bounds", () => {
    const tokens = { input: 500, output: 30_000, cacheRead: 4_000_000, cacheWrite: 300_000 };
    for (const share of [0, 0.4, 1]) {
      const row = decomposeModelRow(breakdown("claude-opus-5", tokens, price(opus, tokens, share)), opus, false, "claude");
      expect(row.reconciled).toBe(true);
      expect(row.impliedOneHourShare).toBeCloseTo(share, 6);
      const sum = tokenTypeOrder.reduce((total, type) => total + (row.costs?.[type] ?? 0), 0);
      expect(sum).toBeCloseTo(price(opus, tokens, share), 9);
    }
  });

  test("a Claude row outside the bounds is withheld", () => {
    const tokens = { input: 500, output: 30_000, cacheRead: 4_000_000, cacheWrite: 300_000 };
    const tooHigh = decomposeModelRow(breakdown("claude-opus-5", tokens, price(opus, tokens, 1) * 1.02), opus, false, "claude");
    const tooLow = decomposeModelRow(breakdown("claude-opus-5", tokens, price(opus, tokens, 0) * 0.98), opus, false, "claude");
    expect(tooHigh.reason).toBe("mismatch");
    expect(tooLow.reason).toBe("mismatch");
  });

  test("a row with no cache writes must have no residual, and its write cost is exactly zero", () => {
    const tokens = { input: 500, output: 30_000, cacheRead: 4_000_000 };
    const exact = decomposeModelRow(breakdown("claude-opus-5", tokens, price(opus, tokens) + 1e-9), opus, false, "claude");
    const drift = decomposeModelRow(breakdown("claude-opus-5", tokens, price(opus, tokens) + 0.05), opus, false, "claude");
    expect(exact.reconciled).toBe(true);
    expect(exact.impliedOneHourShare).toBeNull();
    expect(exact.costs?.cacheWrite).toBe(0);
    expect(drift.reason).toBe("mismatch");
  });

  test("unpriced models and models without a rate keep tokens and withhold cost", () => {
    const tokens = { input: 10, output: 10 };
    expect(decomposeModelRow(breakdown("claude-opus-5", tokens, 0), opus, true).reason).toBe("unpriced");
    expect(decomposeModelRow(breakdown("claude-opus-5", tokens, 0), opus, false).reason).toBe("unpriced");
    expect(decomposeModelRow(breakdown("mystery", tokens, 1), null, false).reason).toBe("no-rate");
    expect(decomposeModelRow(breakdown("mystery", tokens, 1), null, false).totalTokens).toBe(20);
  });

  test("a zero-traffic row is trivially reconciled", () => {
    const row = decomposeModelRow(breakdown("claude-opus-5", {}, 0), opus, false);
    expect(row.reconciled).toBe(true);
    expect(row.totalTokens).toBe(0);
  });
});

describe("summarizeTokenTypes", () => {
  const claudeTokens = { input: 500, output: 30_000, cacheRead: 4_000_000, cacheWrite: 300_000 };
  const codexTokens = { input: 40_000, output: 12_000, cacheRead: 900_000 };
  const claude = { agent: "claude", breakdown: breakdown("claude-opus-5", claudeTokens, price(opus, claudeTokens, 0.75)) };
  const codex = { agent: "codex", breakdown: breakdown("gpt-5.6-sol", codexTokens, price(sol, codexTokens)) };

  test("rows keep the fixed order and shares sum to one", () => {
    const summary = summarizeTokenTypes([claude, codex], card);
    expect(summary.rows.map((row) => row.type)).toEqual(["cacheRead", "cacheWrite", "output", "input"]);
    expect(summary.rows.reduce((sum, row) => sum + (row.tokenShare ?? 0), 0)).toBeCloseTo(1, 9);
    expect(summary.rows.reduce((sum, row) => sum + (row.costShare ?? 0), 0)).toBeCloseTo(1, 9);
    expect(summary.totalTokens).toBe(4_330_500 + 952_000);
  });

  test("mixed-model cost is the sum of per-model components, never a blended rate", () => {
    const summary = summarizeTokenTypes([claude, codex], card);
    expect(summary.costAvailable).toBe(true);
    expect(summary.totalCost).toBeCloseTo(claude.breakdown.cost + codex.breakdown.cost, 9);
    const cacheRead = summary.rows.find((row) => row.type === "cacheRead")!;
    expect(cacheRead.cost).toBeCloseTo(4_000_000 * opus.cacheRead + 900_000 * sol.cacheRead, 9);
    expect(summary.impliedOneHourShare).toBeCloseTo(0.75, 6);
    expect(summary.providers.sort()).toEqual(["anthropic", "codex"]);
  });

  test("one unreconciled contributor withholds every cost cell and is named", () => {
    const broken = { agent: "claude", breakdown: breakdown("claude-opus-5", claudeTokens, price(opus, claudeTokens, 1) * 1.1) };
    const summary = summarizeTokenTypes([broken, codex], card);
    expect(summary.costAvailable).toBe(false);
    expect(summary.totalCost).toBeNull();
    expect(summary.rows.every((row) => row.cost === null && row.costShare === null)).toBe(true);
    expect(summary.rows.every((row) => row.tokens > 0 || row.type === "cacheWrite" || row.type === "input")).toBe(true);
    expect(summary.withheld).toEqual([{ model: "claude-opus-5", reason: "mismatch" }]);
  });

  test("unpriced models are withheld by name", () => {
    const summary = summarizeTokenTypes([claude, codex], card, ["gpt-5.6-sol"]);
    expect(summary.withheld).toEqual([{ model: "gpt-5.6-sol", reason: "unpriced" }]);
  });

  test("Warp rows are excluded from the rows and counted as coverage", () => {
    const warp = { agent: "warp", breakdown: breakdown("claude-opus-5", { input: 1_000, output: 1_000 }, 0) };
    const summary = summarizeTokenTypes([claude, warp], card);
    expect(summary.warpTokensExcluded).toBe(2_000);
    expect(summary.totalTokens).toBe(4_330_500);
    expect(summary.costAvailable).toBe(true);
    expect(summary.providers).toEqual(["anthropic"]);
  });

  test("a Warp-only or empty scope has no shares and no cost", () => {
    const warp = { agent: "warp", breakdown: breakdown("auto", { input: 1_000 }, 0) };
    for (const summary of [summarizeTokenTypes([warp], card), summarizeTokenTypes([], card)]) {
      expect(summary.totalTokens).toBe(0);
      expect(summary.costAvailable).toBe(false);
      expect(summary.rows.every((row) => row.tokenShare === null && row.cost === null)).toBe(true);
    }
  });

  test("a missing rate card withholds cost without touching tokens", () => {
    const summary = summarizeTokenTypes([claude], null);
    expect(summary.costAvailable).toBe(false);
    expect(summary.withheld).toEqual([{ model: "claude-opus-5", reason: "no-rate" }]);
    expect(summary.totalTokens).toBe(4_330_500);
  });
});

describe("footnotesFor", () => {
  const claudeTokens = { input: 500, output: 30_000, cacheRead: 4_000_000, cacheWrite: 300_000 };
  const claude = { agent: "claude", breakdown: breakdown("claude-opus-5", claudeTokens, price(opus, claudeTokens, 0.5)) };
  const codexTokens = { input: 40_000, output: 12_000, cacheRead: 900_000 };
  const codex = { agent: "codex", breakdown: breakdown("gpt-5.6-sol", codexTokens, price(sol, codexTokens)) };

  test("states the implied 1-hour share, Codex zero writes, and the rate provenance", () => {
    const lines = footnotesFor(summarizeTokenTypes([claude, codex], card), {
      rateCard: { status: "live", fetchedAt: "2026-09-03T12:00:00.000Z" },
      reasoning: { outputTokens: 12_000, reasoningOutputTokens: 4_000, reportedEvents: 3 },
    });
    expect(lines).toContain("Cache-write cost is the ccusage residual after input, output, and cache-read rates; about 50% of write tokens were priced at the 1-hour rate.");
    expect(lines).toContain("Codex reports cache writes as zero.");
    expect(lines.some((line) => line.includes("4,000 reasoning tokens"))).toBe(true);
    expect(lines).toContain("Cache reads count repeated reads, not unique text.");
    expect(lines).toContain("Rates: LiteLLM, fetched 2026-09-03.");
  });

  test("names withheld models and excluded Warp tokens, and drops cost lines when cost is withheld", () => {
    const warp = { agent: "warp", breakdown: breakdown("auto", { input: 5_000 }, 0) };
    const lines = footnotesFor(summarizeTokenTypes([claude, codex, warp], card, ["claude-opus-5"]), {
      rateCard: { status: "fallback", fetchedAt: null },
      effortIndexEnabled: false,
    });
    expect(lines).toContain("Cost withheld: claude-opus-5 has no rate card in ccusage.");
    expect(lines).toContain("5,000 Warp tokens excluded (no token-type detail).");
    expect(lines.some((line) => line.startsWith("Rates:"))).toBe(false);
    expect(lines.some((line) => line.includes("1-hour rate"))).toBe(false);
    expect(lines.some((line) => line.includes("effort index is off"))).toBe(true);
  });
});
