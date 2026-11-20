import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateSessionQuotaContext, type ContextPolicyInput } from "../server/session-quota-context";
import { quotaRangeReadingSpanLabel, sessionQuotaImpacts } from "./app/analytics";
import { SessionQuotaContextPanel } from "./components/session-detail";
import type { SessionQuotaContext } from "./types";

const minute = 60_000;
const episode = (start: number, end: number) => ({ startAt: start * minute, endAt: end * minute });
const windowPoint = (at: number, usedPercent: number) => ({
  id: "fiveHour", kind: "window" as const, cycleId: "reset:five-hour", unit: "percentage_points" as const,
  observedAt: at * minute, usedPercent, usedUnits: null, limitUnits: null,
});
const poolPoint = (at: number, usedUnits: number, limitUnits: number) => ({
  id: "monthly", kind: "pool" as const, cycleId: "reset:monthly", unit: "warp_credit" as const,
  observedAt: at * minute, usedUnits, limitUnits, usedPercent: usedUnits / limitUnits * 100,
});

function context(overrides: Partial<ContextPolicyInput>) {
  return calculateSessionQuotaContext({
    sessionId: "session", provider: "anthropic", basis: "bracketed_account_delta",
    episodes: [episode(10, 20)], points: [], otherSessions: [], earliestObservationAt: 0,
    sourceState: "connected", ...overrides,
  });
}

const render = (value: SessionQuotaContext) =>
  renderToStaticMarkup(createElement(SessionQuotaContextPanel, { context: value, modelsUsed: [] }));

describe("session quota impact panel", () => {
  test("dates a bracketed reading by its snapshots, not by the activity it brackets", () => {
    // Active 10–12, read at 9 and 29: the whole 10-point move may have happened after minute 12.
    const result = context({
      episodes: [episode(10, 12), episode(45, 47)],
      points: [windowPoint(9, 10), windowPoint(29, 20), windowPoint(48, 20)],
    });
    const [range] = sessionQuotaImpacts(result, [])[0]!.ranges;
    expect(range).toMatchObject({
      startAt: 10 * minute, endAt: 12 * minute,
      observedStartAt: 9 * minute, observedEndAt: 29 * minute,
      bracketed: true,
    });
    expect(quotaRangeReadingSpanLabel(range!, "UTC")).toBe("Jan 1 12:09–12:29a");
    expect(render(result)).toContain("bracketed estimate");
  });

  test("keeps Warp credit movement visible when the pool limit changed", () => {
    const result = context({
      provider: "warp",
      points: [poolPoint(9, 100, 1_500), poolPoint(21, 142, 2_000)],
    });
    const html = render(result);
    expect(sessionQuotaImpacts(result, [])[0]?.cycles[0]?.magnitude).toBe(42);
    expect(html).toContain("100→142");
    expect(html).toContain(">used<");
    expect(html).not.toContain("No measurable change");
  });

  test("applies the display threshold to the number, not the localized string", () => {
    const result = context({
      provider: "warp",
      points: [poolPoint(9, 100, 3_000), poolPoint(21, 1_600, 3_000)],
    });
    const toLocaleString = Number.prototype.toLocaleString;
    // French groups thousands with a narrow no-break space: `1 500`.
    Number.prototype.toLocaleString = function (this: number, locale?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
      return toLocaleString.call(this, locale ?? "fr-FR", options);
    };
    try {
      const impacts = sessionQuotaImpacts(result, []);
      expect(impacts).toHaveLength(1);
      expect(impacts[0]!.cycles[0]!.magnitude).toBe(1_500);
      expect(render(result)).not.toContain("No measurable change");
    } finally {
      Number.prototype.toLocaleString = toLocaleString;
    }
  });

  test("keeps a zero reading's caveat while a later episode awaits its snapshot", () => {
    const result = context({
      episodes: [episode(10, 20), episode(75, 76)],
      points: [windowPoint(9, 10), windowPoint(21, 10), windowPoint(74, 20)],
      now: 77 * minute,
    });
    const reason = result.resources[0]!.reason!;
    expect(reason).toContain("still running");
    const html = render(result);
    expect(html).toContain(reason);
    expect(html).toContain("No measurable change in resolved readings");
    expect(html).not.toContain("No measurable change: ");
  });

  test("still names a resolved window that did not move", () => {
    const result = context({ points: [windowPoint(9, 10), windowPoint(21, 10)] });
    expect(render(result)).toContain("No measurable change: 5-hour window.");
  });
});
