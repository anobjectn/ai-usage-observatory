import { afterEach, describe, expect, test } from "bun:test";
import { decomposeModelRow, tokenTypeOrder } from "../src/token-types";
import type { ModelBreakdown } from "../src/types";
import {
  clearRateCardCache,
  ensureRateCard,
  matchRate,
  parseLiteLlmRates,
  rateCardHealth,
  refreshRateCard,
  setRateCardState,
  summarizeRateCard,
} from "./rate-card";
import fallback from "./rate-card-fallback.json";
import fixture from "./fixtures/ccusage-model-rows.json";

const liteLlm = {
  "claude-opus-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 0.5e-6,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 10e-6,
  },
  "gpt-5.6-sol": { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: 0.4e-6 },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  "mistral-large": { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
  "gpt-broken": { input_cost_per_token: "free", output_cost_per_token: 1e-6 },
};

afterEach(() => {
  clearRateCardCache();
  setRateCardState(null);
});

describe("parseLiteLlmRates", () => {
  test("keeps only ccusage families with numeric base rates and reads the 1-hour tier", () => {
    const card = parseLiteLlmRates(liteLlm);
    expect(Object.keys(card).sort()).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
    expect(card["claude-opus-5"]).toEqual({ input: 5e-6, output: 25e-6, cacheRead: 0.5e-6, cacheWrite5m: 6.25e-6, cacheWrite1h: 10e-6 });
    // A model without cache pricing falls back to its input rate for reads and writes.
    expect(card["gpt-5.6-sol"]).toEqual({ input: 4e-6, output: 20e-6, cacheRead: 0.4e-6, cacheWrite5m: 4e-6, cacheWrite1h: null });
  });

  test("tolerates garbage", () => {
    expect(parseLiteLlmRates(null)).toEqual({});
    expect(parseLiteLlmRates("nope")).toEqual({});
  });
});

describe("matchRate", () => {
  const card = parseLiteLlmRates({ ...liteLlm, "anthropic/claude-sonnet-5": { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6 } });

  test("resolves exact, prefixed, dated, and context-suffixed names", () => {
    expect(matchRate(card, "claude-opus-5")?.input).toBe(5e-6);
    expect(matchRate(card, "claude-sonnet-5")?.input).toBe(2e-6);
    expect(matchRate(card, "claude-opus-5-20260101")?.input).toBe(5e-6);
    expect(matchRate(card, "claude-opus-5[1m]")?.input).toBe(5e-6);
    expect(matchRate(card, "gpt-5.6-sol")?.output).toBe(20e-6);
  });

  test("never guesses a family rate", () => {
    expect(matchRate(card, "claude-opus-6")).toBeNull();
    expect(matchRate(card, "auto")).toBeNull();
  });
});

describe("rate card loading", () => {
  test("starts from the bundled fallback when nothing is cached", async () => {
    const state = await ensureRateCard(async () => { throw new Error("offline"); });
    expect(state.status).toBe("fallback");
    expect(state.fetchedAt).toBeNull();
    expect(Object.keys(state.card).length).toBeGreaterThan(10);
  });

  test("a successful refresh caches the table and later loads report it as cached", async () => {
    const fetcher = async () => new Response(JSON.stringify(liteLlm), { status: 200 });
    const now = () => new Date("2026-09-03T12:00:00.000Z");
    const live = await refreshRateCard(fetcher, now);
    expect(live.status).toBe("live");
    expect(live.fetchedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(live.card["claude-opus-5"]?.cacheWrite1h).toBe(10e-6);

    setRateCardState(null);
    const reloaded = await ensureRateCard(async () => { throw new Error("must not fetch"); }, () => new Date("2026-09-03T13:00:00.000Z"));
    expect(reloaded.status).toBe("cached");
    expect(reloaded.fetchedAt).toBe("2026-09-03T12:00:00.000Z");
  });

  test("a failed refresh keeps the previous card and records the error", async () => {
    setRateCardState({ card: { "claude-opus-5": { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: null } }, status: "fallback", fetchedAt: null, error: null });
    const failed = await refreshRateCard(async () => new Response("nope", { status: 503 }));
    expect(failed.card["claude-opus-5"]).toBeDefined();
    expect(failed.status).toBe("fallback");
    expect(failed.error).toContain("503");
    expect(rateCardHealth(failed).status).toBe("degraded");
  });

  test("health is healthy only for a table fetched within a week", () => {
    const fresh = rateCardHealth({ card: {}, status: "live", fetchedAt: "2026-09-01T00:00:00.000Z", error: null }, () => new Date("2026-09-03T00:00:00.000Z"));
    const stale = rateCardHealth({ card: {}, status: "cached", fetchedAt: "2026-08-01T00:00:00.000Z", error: null }, () => new Date("2026-09-03T00:00:00.000Z"));
    expect(fresh.status).toBe("healthy");
    expect(stale.status).toBe("degraded");
  });

  test("summarizeRateCard resolves each ccusage model name once", () => {
    const summary = summarizeRateCard({ card: parseLiteLlmRates(liteLlm), status: "live", fetchedAt: null, error: null }, ["claude-opus-5[1m]", "auto"]);
    expect(summary.models["claude-opus-5[1m]"]?.input).toBe(5e-6);
    expect(summary.models.auto).toBeNull();
  });
});

/** The guard for the whole feature: real ccusage 20.0.17 rows must decompose against the
 * bundled table. Codex rows reconcile exactly; Claude rows land between the all-5-minute and
 * all-1-hour cache-write bounds because ccusage prices 1-hour writes at the higher rate. */
describe("reconciliation against recorded ccusage rows", () => {
  const card = fallback.models as Record<string, import("../src/types").ModelRate>;
  const rows = fixture.rows as Array<{ agent: string; period: string; breakdown: ModelBreakdown }>;

  test("the fixture covers both providers", () => {
    expect(rows.some((row) => row.agent === "claude")).toBe(true);
    expect(rows.some((row) => row.agent === "codex")).toBe(true);
  });

  for (const row of rows) {
    test(`${row.agent} ${row.breakdown.modelName} ${row.period} reconciles`, () => {
      const rate = matchRate(card, row.breakdown.modelName);
      expect(rate).not.toBeNull();
      const result = decomposeModelRow(row.breakdown, rate, false, row.agent);
      expect(result.reason).toBeNull();
      const sum = tokenTypeOrder.reduce((total, type) => total + (result.costs?.[type] ?? 0), 0);
      expect(sum).toBeCloseTo(row.breakdown.cost, 6);
      if (row.agent === "codex") expect(result.impliedOneHourShare).toBeNull();
      else expect(result.impliedOneHourShare).not.toBeNull();
    });
  }
});
