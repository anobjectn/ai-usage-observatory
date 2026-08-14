import type { ReactNode } from "react";

const viewportGap = 8;

export const chartTooltipExitGraceMs = 400;
export const chartTooltipLeaveGraceMs = 180;

export function chartTooltipDateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")} ${part("month")} ${part("day")}`;
}

export type TooltipHoldState = {
  rechartsActive: boolean;
  superseded: boolean;
  cardPointer: boolean;
  focusWithin: boolean;
  pinPointer: boolean;
  pinFocus: boolean;
  deadline: number | null;
};

export type TooltipHoldAction =
  | { type: "recharts"; active: boolean; now: number }
  | { type: "card-pointer"; inside: boolean; now: number }
  | { type: "card-focus"; inside: boolean; now: number }
  | { type: "pin-pointer"; inside: boolean; now: number }
  | { type: "pin-focus"; inside: boolean; now: number }
  | { type: "timer"; now: number }
  | { type: "supersede" }
  | { type: "restore" }
  | { type: "dismiss" };

export function createTooltipHoldState(
  rechartsActive = false,
): TooltipHoldState {
  return {
    rechartsActive,
    superseded: false,
    cardPointer: false,
    focusWithin: false,
    pinPointer: false,
    pinFocus: false,
    deadline: null,
  };
}

export function isChartTooltipHeld(state: TooltipHoldState) {
  return (
    state.cardPointer ||
    state.focusWithin ||
    state.pinPointer ||
    state.pinFocus
  );
}

export function isChartTooltipFrozen(state: TooltipHoldState) {
  return state.pinPointer || state.pinFocus;
}

export function isChartTooltipShown(state: TooltipHoldState, now: number) {
  return (
    !state.superseded &&
    (state.rechartsActive ||
      isChartTooltipHeld(state) ||
      (state.deadline !== null && now < state.deadline))
  );
}

export function isChartTooltipRetained(
  state: TooltipHoldState,
  hasSnapshot: boolean,
  now: number,
) {
  return (
    !state.rechartsActive &&
    hasSnapshot &&
    isChartTooltipShown(state, now)
  );
}

function setTooltipHold(
  state: TooltipHoldState,
  key: "cardPointer" | "focusWithin" | "pinPointer" | "pinFocus",
  inside: boolean,
  now: number,
) {
  if (state[key] === inside) return state;
  const next = { ...state, [key]: inside };
  if (next.rechartsActive) return { ...next, deadline: null };
  if (isChartTooltipHeld(next)) return { ...next, deadline: null };
  return { ...next, deadline: now + chartTooltipLeaveGraceMs };
}

export function tooltipHoldReducer(
  state: TooltipHoldState,
  action: TooltipHoldAction,
): TooltipHoldState {
  if (action.type === "recharts") {
    if (action.active === state.rechartsActive) return state;
    if (action.active)
      return {
        ...state,
        rechartsActive: true,
        superseded: false,
        deadline: null,
      };
    const next = { ...state, rechartsActive: false };
    return {
      ...next,
      deadline: isChartTooltipHeld(next)
        ? null
        : action.now + chartTooltipExitGraceMs,
    };
  }
  if (action.type === "card-pointer")
    return setTooltipHold(state, "cardPointer", action.inside, action.now);
  if (action.type === "card-focus")
    return setTooltipHold(state, "focusWithin", action.inside, action.now);
  if (action.type === "pin-pointer")
    return setTooltipHold(state, "pinPointer", action.inside, action.now);
  if (action.type === "pin-focus")
    return setTooltipHold(state, "pinFocus", action.inside, action.now);
  if (action.type === "timer") {
    if (
      state.rechartsActive ||
      isChartTooltipHeld(state) ||
      state.deadline === null ||
      action.now < state.deadline
    )
      return state;
    return { ...state, deadline: null };
  }
  if (action.type === "supersede")
    return {
      ...createTooltipHoldState(state.rechartsActive),
      superseded: true,
    };
  if (action.type === "restore")
    return state.superseded ? { ...state, superseded: false } : state;
  return createTooltipHoldState(state.rechartsActive);
}

export type ChartPinDescriptor = {
  id: string;
  ariaLabel: string;
  contextLabel?: string;
  contextDescription?: string;
  contextPlacement?: "header" | "inline";
  className?: string;
  content: ReactNode;
};

export type ChartPinItem = ChartPinDescriptor & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ChartPinAction =
  | { type: "add"; item: ChartPinItem }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; x: number; y: number }
  | {
      type: "measure";
      id: string;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
    }
  | { type: "raise"; id: string }
  | { type: "clamp"; viewportWidth: number; viewportHeight: number }
  | { type: "clear" };

export function clampChartPinPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const availableWidth = Math.max(0, viewportWidth - viewportGap * 2);
  const availableHeight = Math.max(0, viewportHeight - viewportGap * 2);
  const boundedWidth = Math.min(width, availableWidth);
  const boundedHeight = Math.min(height, availableHeight);
  return {
    x: Math.min(
      Math.max(viewportGap, x),
      Math.max(viewportGap, viewportWidth - boundedWidth - viewportGap),
    ),
    y: Math.min(
      Math.max(viewportGap, y),
      Math.max(viewportGap, viewportHeight - boundedHeight - viewportGap),
    ),
  };
}

export function chartPinsReducer(
  state: ChartPinItem[],
  action: ChartPinAction,
): ChartPinItem[] {
  if (action.type === "add") {
    const existing = state.find((item) => item.id === action.item.id);
    return existing
      ? [
          ...state.filter((item) => item.id !== action.item.id),
          { ...existing, ...action.item },
        ]
      : [...state, action.item];
  }
  if (action.type === "remove")
    return state.filter((item) => item.id !== action.id);
  if (action.type === "move")
    return state.map((item) =>
      item.id === action.id ? { ...item, x: action.x, y: action.y } : item,
    );
  if (action.type === "measure")
    return state.map((item) => {
      if (item.id !== action.id) return item;
      const position = clampChartPinPosition(
        item.x,
        item.y,
        action.width,
        action.height,
        action.viewportWidth,
        action.viewportHeight,
      );
      return {
        ...item,
        ...position,
        width: action.width,
        height: action.height,
      };
    });
  if (action.type === "raise") {
    const item = state.find((candidate) => candidate.id === action.id);
    return item
      ? [...state.filter((candidate) => candidate.id !== action.id), item]
      : state;
  }
  if (action.type === "clamp")
    return state.map((item) => ({
      ...item,
      ...clampChartPinPosition(
        item.x,
        item.y,
        item.width,
        item.height,
        action.viewportWidth,
        action.viewportHeight,
      ),
    }));
  return [];
}
