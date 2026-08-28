import { describe, expect, test } from "bun:test";
import { calculateSessionQuotaContext, type ContextPolicyInput } from "./session-quota-context";

const episode = { startAt: 10 * 60_000, endAt: 20 * 60_000 };

function input(overrides: Partial<ContextPolicyInput> = {}): ContextPolicyInput {
  return {
    sessionId: "session",
    provider: "anthropic",
    basis: "bracketed_account_delta",
    episodes: [episode],
    points: [],
    otherSessions: [],
    earliestObservationAt: 0,
    sourceState: "connected",
    ...overrides,
  };
}

function windowPoint(observedAt: number, usedPercent: number, cycleId = "reset:3600000") {
  return {
    id: "fiveHour",
    kind: "window" as const,
    observedAt,
    usedPercent,
    usedUnits: null,
    limitUnits: null,
    cycleId,
    unit: "percentage_points" as const,
  };
}

describe("session quota policy", () => {
  test("reports account movement with bracket coverage and non-additive semantics", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 51), windowPoint(21 * 60_000, 100)],
    }));
    expect(result.resources[0]).toMatchObject({
      id: "fiveHour", deltaPercentagePoints: 49, cycleCount: 1, measurable: true,
    });
    expect(result.confidence).toBe("high");
    expect(result.additive).toBe(false);
    expect(result.concurrency.externalActivity).toBe("unknown");
  });

  test("splits reset cycles instead of subtracting a pre-reset value from a post-reset value", () => {
    const result = calculateSessionQuotaContext(input({
      points: [
        windowPoint(9 * 60_000, 10, "reset:a"),
        windowPoint(14 * 60_000, 20, "reset:a"),
        windowPoint(16 * 60_000, 1, "reset:b"),
        windowPoint(21 * 60_000, 5, "reset:b"),
      ],
    }));
    expect(result.resources[0]).toMatchObject({ deltaPercentagePoints: 14, cycleCount: 2 });
    expect(result.resources[0]?.episodes).toHaveLength(2);
  });

  test("rejects a counter decrease inside one cycle", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 70), windowPoint(21 * 60_000, 60)],
    }));
    expect(result.confidence).toBe("insufficient");
    expect(result.reason).toContain("decreased");
  });

  test("keeps Warp unit movement but omits percentage movement when the pool limit changes", () => {
    const pool = (observedAt: number, usedUnits: number, limitUnits: number) => ({
      id: "monthly", kind: "pool" as const, observedAt,
      usedPercent: usedUnits / limitUnits * 100, usedUnits, limitUnits,
      cycleId: "reset:monthly", unit: "warp_credit" as const,
    });
    const result = calculateSessionQuotaContext(input({
      provider: "warp",
      points: [pool(9 * 60_000, 100, 1_500), pool(21 * 60_000, 142, 2_000)],
    }));
    expect(result.resources[0]).toMatchObject({
      deltaUnits: 42, deltaPercentagePoints: null, limitChanged: true,
    });
  });

  test("does not pull quota movement across a long paused interval", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 10), windowPoint(80 * 60_000, 50)],
    }));
    expect(result.resources).toEqual([]);
    expect(result.confidence).toBe("insufficient");
  });

  test("counts same-provider and cross-provider overlap separately", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 10), windowPoint(21 * 60_000, 15)],
      otherSessions: [
        { sessionId: "same", provider: "anthropic", episodes: [{ startAt: 11 * 60_000, endAt: 13 * 60_000 }] },
        { sessionId: "cross", provider: "codex", episodes: [{ startAt: 12 * 60_000, endAt: 14 * 60_000 }] },
      ],
    }));
    expect(result.concurrency).toMatchObject({
      distinctOtherSameProviderSessions: 1,
      maxOtherSameProviderSessions: 1,
      distinctOtherProviderSessions: 1,
      maxOtherProviderSessions: 1,
    });
  });
});
