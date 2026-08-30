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

  test("anchors a fresh cycle to the unstarted window that preceded it", () => {
    const result = calculateSessionQuotaContext(input({
      points: [
        windowPoint(9 * 60_000, 0, "observed:540000"),
        windowPoint(21 * 60_000, 8, "reset:3600000"),
      ],
    }));
    expect(result.resources[0]).toMatchObject({
      deltaPercentagePoints: 8, cycleCount: 1, measurable: true,
    });
    expect(result.reason).toBeNull();
    expect(result.confidence).toBe("high");
  });

  test("resolves a session that never started the window as zero movement", () => {
    const result = calculateSessionQuotaContext(input({
      points: [
        windowPoint(9 * 60_000, 0, "observed:540000"),
        windowPoint(21 * 60_000, 0, "observed:1260000"),
      ],
    }));
    expect(result.resources[0]).toMatchObject({ deltaPercentagePoints: 0, measurable: false });
    expect(result.reason).toBeNull();
  });

  test("still reports an unreadable cycle when the window carries usage without a reset", () => {
    const result = calculateSessionQuotaContext(input({
      points: [
        windowPoint(9 * 60_000, 12, "observed:540000"),
        windowPoint(21 * 60_000, 20, "observed:1260000"),
      ],
    }));
    expect(result.resources[0]).toMatchObject({
      id: "fiveHour", confidence: "insufficient", deltaPercentagePoints: null,
    });
    expect(result.confidence).toBe("insufficient");
    expect(result.reason).toContain("do not resolve both sides");
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
    expect(result.resources[0]).toMatchObject({ confidence: "insufficient", deltaPercentagePoints: null });
    expect(result.confidence).toBe("insufficient");
    expect(result.reason).toContain("do not resolve both sides");
  });

  test("names the missing closing snapshot when the session is still running", () => {
    const endAt = 20 * 60_000;
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 10)],
      now: endAt + 90_000,
    }));
    expect(result.resources[0]?.reason).toBe("Waiting for the first snapshot after this session's last activity.");
    expect(result.reason).toBe("Waiting for the first snapshot after this session's last activity.");
  });

  test("scales the confidence tiers to the cadence the collector actually achieved", () => {
    // Snapshots every 3.5 minutes: a bracket one poll wide is as tight as this service gets.
    const points = [0, 210_000, 420_000, 630_000, 840_000, 1_050_000, 1_260_000]
      .map((observedAt, index) => windowPoint(observedAt, index));
    const result = calculateSessionQuotaContext(input({ points }));
    expect(result.coverage.observationCadenceMs).toBe(210_000);
    expect(result.confidence).toBe("high");
    expect(result.resources[0]?.confidence).toBe("high");
  });

  test("reports a resolved sibling beside an unresolved one", () => {
    const weekly = (observedAt: number, usedPercent: number) => ({
      ...windowPoint(observedAt, usedPercent, "reset:7200000"), id: "weekly",
    });
    const result = calculateSessionQuotaContext(input({
      points: [
        windowPoint(9 * 60_000, 12, "observed:540000"),
        windowPoint(21 * 60_000, 20, "observed:1260000"),
        weekly(9 * 60_000, 40),
        weekly(21 * 60_000, 43),
      ],
    }));
    expect(result.resources.find((resource) => resource.id === "weekly")).toMatchObject({
      deltaPercentagePoints: 3, confidence: "high",
    });
    expect(result.resources.find((resource) => resource.id === "fiveHour")?.confidence).toBe("insufficient");
    expect(result.confidence).toBe("high");
    expect(result.reason).toBeNull();
  });

  test("reports the closing balance beside the movement", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 51), windowPoint(21 * 60_000, 100)],
    }));
    expect(result.resources[0]).toMatchObject({
      endUsedPercent: 100,
      endObservedAt: 21 * 60_000,
      endCycleId: "reset:3600000",
      endGapMs: 60_000,
    });
  });

  test("closing balance comes from the newest cycle when the session spans a reset", () => {
    const result = calculateSessionQuotaContext(input({
      points: [
        windowPoint(9 * 60_000, 10, "reset:a"),
        windowPoint(14 * 60_000, 20, "reset:a"),
        windowPoint(16 * 60_000, 1, "reset:b"),
        windowPoint(21 * 60_000, 5, "reset:b"),
      ],
    }));
    expect(result.resources[0]).toMatchObject({ endUsedPercent: 5, endCycleId: "reset:b" });
  });

  test("closing balance survives the counter decrease that blanks movement", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 70), windowPoint(21 * 60_000, 60)],
    }));
    expect(result.confidence).toBe("insufficient");
    expect(result.resources[0]).toMatchObject({
      deltaPercentagePoints: null,
      endUsedPercent: 60,
      endObservedAt: 21 * 60_000,
    });
  });

  test("closing balance is null when no snapshot follows the session within tolerance", () => {
    const result = calculateSessionQuotaContext(input({
      points: [windowPoint(9 * 60_000, 10), windowPoint(80 * 60_000, 50)],
    }));
    expect(result.resources[0]).toMatchObject({ endUsedPercent: null, endObservedAt: null, endGapMs: null });
  });

  test("closing balance reports pool units and the pool limit", () => {
    const pool = (observedAt: number, usedUnits: number, limitUnits: number) => ({
      id: "monthly", kind: "pool" as const, observedAt,
      usedPercent: usedUnits / limitUnits * 100, usedUnits, limitUnits,
      cycleId: "reset:monthly", unit: "warp_credit" as const,
    });
    const result = calculateSessionQuotaContext(input({
      provider: "warp",
      points: [pool(9 * 60_000, 100, 1_500), pool(21 * 60_000, 142, 1_500)],
    }));
    expect(result.resources[0]).toMatchObject({ endUsedUnits: 142, limitUnits: 1_500 });
  });

  test("embedded basis closes at the last observation inside the session", () => {
    const result = calculateSessionQuotaContext(input({
      basis: "embedded_account_observation",
      points: [windowPoint(11 * 60_000, 12), windowPoint(18 * 60_000, 30)],
    }));
    expect(result.resources[0]).toMatchObject({
      endUsedPercent: 30,
      endObservedAt: 18 * 60_000,
      endGapMs: 2 * 60_000,
    });
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
