import { expect, test } from "bun:test";
import {
  chartTooltipExitGraceMs,
  chartTooltipLeaveGraceMs,
  chartTooltipDateLabel,
  chartPinsReducer,
  clampChartPinPosition,
  createTooltipHoldState,
  isChartTooltipFrozen,
  isChartTooltipHeld,
  isChartTooltipInteractive,
  isChartTooltipReach,
  isChartTooltipRetained,
  isChartTooltipShown,
  tooltipHoldReducer,
  type ChartPinItem,
} from "./chart-pins";

function pin(id: string, x = 20, y = 30): ChartPinItem {
  return {
    id,
    ariaLabel: `${id} details`,
    content: null,
    x,
    y,
    width: 200,
    height: 120,
  };
}

test("chart pins append new panels and replace duplicate data points", () => {
  const first = chartPinsReducer([], { type: "add", item: pin("day-one") });
  const second = chartPinsReducer(first, {
    type: "add",
    item: { ...pin("day-two"), x: 80 },
  });
  const updated = chartPinsReducer(second, {
    type: "add",
    item: { ...pin("day-one"), x: 140 },
  });

  expect(updated.map((item) => item.id)).toEqual(["day-two", "day-one"]);
  expect(updated[1]?.x).toBe(140);
});

test("chart tooltip dates use a shared weekday and full-month format", () => {
  expect(chartTooltipDateLabel("2026-07-26")).toBe("Sun July 26");
  expect(chartTooltipDateLabel("2026-08-03")).toBe("Mon August 3");
});

test("chart pins can move, rise above siblings, and be removed", () => {
  const initial = [pin("first"), pin("second"), pin("third")];
  const moved = chartPinsReducer(initial, {
    type: "move",
    id: "first",
    x: 155,
    y: 210,
  });
  const raised = chartPinsReducer(moved, { type: "raise", id: "first" });
  const removed = chartPinsReducer(raised, { type: "remove", id: "second" });

  expect(removed.map((item) => item.id)).toEqual(["third", "first"]);
  expect(removed[1]).toMatchObject({ x: 155, y: 210 });
});

test("chart pin positions stay inside the usable viewport", () => {
  expect(clampChartPinPosition(-40, -20, 200, 120, 800, 600)).toEqual({
    x: 8,
    y: 8,
  });
  expect(clampChartPinPosition(760, 580, 200, 120, 800, 600)).toEqual({
    x: 592,
    y: 472,
  });
  expect(clampChartPinPosition(100, 90, 900, 700, 800, 600)).toEqual({
    x: 8,
    y: 8,
  });
});

test("chart pins re-clamp after measurement and viewport changes", () => {
  const measured = chartPinsReducer([pin("day", 700, 500)], {
    type: "measure",
    id: "day",
    width: 260,
    height: 180,
    viewportWidth: 800,
    viewportHeight: 600,
  });
  const resized = chartPinsReducer(measured, {
    type: "clamp",
    viewportWidth: 500,
    viewportHeight: 400,
  });

  expect(measured[0]).toMatchObject({ x: 532, y: 412, width: 260, height: 180 });
  expect(resized[0]).toMatchObject({ x: 232, y: 212 });
  expect(chartPinsReducer(resized, { type: "clear" })).toEqual([]);
});

test("inactive tooltips retain for the exit grace and expire at the deadline", () => {
  const inactive = tooltipHoldReducer(createTooltipHoldState(true), {
    type: "recharts",
    active: false,
    now: 100,
  });

  expect(inactive.deadline).toBe(100 + chartTooltipExitGraceMs);
  expect(isChartTooltipShown(inactive, 499)).toBe(true);
  expect(
    tooltipHoldReducer(inactive, { type: "timer", now: 499 }),
  ).toEqual(inactive);
  const expired = tooltipHoldReducer(inactive, {
    type: "timer",
    now: 500,
  });
  expect(expired.deadline).toBeNull();
  expect(isChartTooltipShown(expired, 500)).toBe(false);
});

test("card entry cancels exit grace and card leave starts the short grace", () => {
  const inactive = tooltipHoldReducer(createTooltipHoldState(true), {
    type: "recharts",
    active: false,
    now: 0,
  });
  const entered = tooltipHoldReducer(inactive, {
    type: "card-pointer",
    inside: true,
    now: 200,
  });
  const left = tooltipHoldReducer(entered, {
    type: "card-pointer",
    inside: false,
    now: 300,
  });

  expect(entered.deadline).toBeNull();
  expect(left.deadline).toBe(300 + chartTooltipLeaveGraceMs);
});

test("Recharts reactivation clears a pending deadline", () => {
  const inactive = tooltipHoldReducer(createTooltipHoldState(true), {
    type: "recharts",
    active: false,
    now: 0,
  });
  const active = tooltipHoldReducer(inactive, {
    type: "recharts",
    active: true,
    now: 100,
  });

  expect(active.rechartsActive).toBe(true);
  expect(active.deadline).toBeNull();
});

test("pin hover and focus freeze snapshots while ordinary card hover does not", () => {
  const card = tooltipHoldReducer(createTooltipHoldState(false), {
    type: "card-pointer",
    inside: true,
    now: 0,
  });
  const pinPointer = tooltipHoldReducer(card, {
    type: "pin-pointer",
    inside: true,
    now: 0,
  });
  const pinFocus = tooltipHoldReducer(card, {
    type: "pin-focus",
    inside: true,
    now: 0,
  });

  expect(isChartTooltipFrozen(card)).toBe(false);
  expect(isChartTooltipFrozen(pinPointer)).toBe(true);
  expect(isChartTooltipFrozen(pinFocus)).toBe(true);
});

test("leaving the pin remains held while the pointer is still in the card", () => {
  const card = tooltipHoldReducer(createTooltipHoldState(false), {
    type: "card-pointer",
    inside: true,
    now: 0,
  });
  const pin = tooltipHoldReducer(card, {
    type: "pin-pointer",
    inside: true,
    now: 10,
  });
  const leftPin = tooltipHoldReducer(pin, {
    type: "pin-pointer",
    inside: false,
    now: 20,
  });

  expect(isChartTooltipHeld(leftPin)).toBe(true);
  expect(leftPin.deadline).toBeNull();
});

test("pointer leave does not dismiss while focus remains within the card", () => {
  const focused = tooltipHoldReducer(
    tooltipHoldReducer(createTooltipHoldState(false), {
      type: "card-pointer",
      inside: true,
      now: 0,
    }),
    { type: "card-focus", inside: true, now: 0 },
  );
  const pointerLeft = tooltipHoldReducer(focused, {
    type: "card-pointer",
    inside: false,
    now: 20,
  });

  expect(isChartTooltipHeld(pointerLeft)).toBe(true);
  expect(pointerLeft.deadline).toBeNull();
});

test("pin pointer leave stays frozen while pin focus remains", () => {
  const held = tooltipHoldReducer(
    tooltipHoldReducer(createTooltipHoldState(false), {
      type: "pin-pointer",
      inside: true,
      now: 0,
    }),
    { type: "pin-focus", inside: true, now: 0 },
  );
  const pointerLeft = tooltipHoldReducer(held, {
    type: "pin-pointer",
    inside: false,
    now: 20,
  });

  expect(isChartTooltipFrozen(pointerLeft)).toBe(true);
  expect(pointerLeft.deadline).toBeNull();
});

test("releasing the final inactive hold starts the short grace", () => {
  const held = tooltipHoldReducer(createTooltipHoldState(false), {
    type: "card-focus",
    inside: true,
    now: 0,
  });
  const released = tooltipHoldReducer(held, {
    type: "card-focus",
    inside: false,
    now: 50,
  });

  expect(released.deadline).toBe(50 + chartTooltipLeaveGraceMs);
});

test("explicit dismissal clears inactive retained state", () => {
  const inactive = tooltipHoldReducer(createTooltipHoldState(true), {
    type: "recharts",
    active: false,
    now: 0,
  });
  const dismissed = tooltipHoldReducer(inactive, { type: "dismiss" });

  expect(dismissed).toEqual(createTooltipHoldState(false));
  expect(isChartTooltipShown(dismissed, 1)).toBe(false);
});

test("superseded tooltips hide even if Recharts still reports them active", () => {
  const active = createTooltipHoldState(true);
  const superseded = tooltipHoldReducer(active, { type: "supersede" });

  expect(superseded.rechartsActive).toBe(true);
  expect(superseded.superseded).toBe(true);
  expect(isChartTooltipShown(superseded, 0)).toBe(false);
});

test("a new live point restores a superseded tooltip", () => {
  const superseded = tooltipHoldReducer(createTooltipHoldState(true), {
    type: "supersede",
  });
  const restored = tooltipHoldReducer(superseded, { type: "restore" });

  expect(restored.superseded).toBe(false);
  expect(isChartTooltipShown(restored, 0)).toBe(true);
});

test("dismissal releases every hold but keeps the live Recharts state", () => {
  const held = tooltipHoldReducer(
    tooltipHoldReducer(createTooltipHoldState(true), {
      type: "pin-pointer",
      inside: true,
      now: 0,
    }),
    { type: "pin-focus", inside: true, now: 0 },
  );
  const dismissed = tooltipHoldReducer(held, { type: "dismiss" });

  expect(dismissed).toEqual(createTooltipHoldState(true));
  expect(isChartTooltipFrozen(dismissed)).toBe(false);
});

test("retained is limited to inactive tooltips with a cached snapshot", () => {
  const active = createTooltipHoldState(true);
  const activePin = tooltipHoldReducer(active, {
    type: "pin-pointer",
    inside: true,
    now: 0,
  });
  const inactive = tooltipHoldReducer(active, {
    type: "recharts",
    active: false,
    now: 0,
  });

  expect(isChartTooltipRetained(activePin, true, 10)).toBe(false);
  expect(isChartTooltipRetained(inactive, false, 10)).toBe(false);
  expect(isChartTooltipRetained(inactive, true, 10)).toBe(true);
});

test("the card accepts pointer input while the pin freezes it over a live chart", () => {
  const live = createTooltipHoldState(true);
  const frozen = tooltipHoldReducer(live, {
    type: "pin-pointer",
    inside: true,
    now: 0,
  });
  // Leaving the pin for the card body itself has to keep the card clickable,
  // or a pointer travelling toward a control inside it falls through to the
  // chart and scrubs to another day.
  const insideCard = tooltipHoldReducer(
    tooltipHoldReducer(frozen, { type: "card-pointer", inside: true, now: 0 }),
    { type: "pin-pointer", inside: false, now: 0 },
  );

  expect(isChartTooltipInteractive(live, false)).toBe(false);
  expect(isChartTooltipInteractive(frozen, false)).toBe(true);
  expect(isChartTooltipInteractive(insideCard, false)).toBe(true);
  expect(isChartTooltipInteractive(live, true)).toBe(true);
});

test("a climb into the card reads as a reach, a scrub across it does not", () => {
  const scrub = { dx: 14, dy: 2 };
  const climb = { dx: 2, dy: -14 };
  const drift = { dx: 3, dy: -2 };
  const diagonal = { dx: 10, dy: -10 };
  const shallow = { dx: 14, dy: -11 };

  expect(isChartTooltipReach(scrub, true)).toBe(false);
  expect(isChartTooltipReach(drift, true)).toBe(false);
  expect(isChartTooltipReach(shallow, true)).toBe(false);
  expect(isChartTooltipReach(climb, true)).toBe(true);
  expect(isChartTooltipReach(diagonal, true)).toBe(true);
  // Outside the card nothing counts, and a reach already under way survives the
  // sideways moves that follow it toward a control.
  expect(isChartTooltipReach(climb, false)).toBe(false);
  expect(isChartTooltipReach(scrub, true, true)).toBe(true);
  expect(isChartTooltipReach(scrub, false, true)).toBe(false);
});

test("a reach holds and freezes the card while the chart is still live", () => {
  const live = createTooltipHoldState(true);
  const reaching = tooltipHoldReducer(live, {
    type: "card-reach",
    inside: true,
    now: 0,
  });
  const left = tooltipHoldReducer(reaching, {
    type: "card-reach",
    inside: false,
    now: 0,
  });

  expect(isChartTooltipFrozen(reaching)).toBe(true);
  expect(isChartTooltipInteractive(reaching, false)).toBe(true);
  expect(isChartTooltipFrozen(left)).toBe(false);
  expect(isChartTooltipInteractive(left, false)).toBe(false);
});
