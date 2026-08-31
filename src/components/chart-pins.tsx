import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Info, Pin, X } from "lucide-react";
import {
  createTooltipHoldState,
  chartPinsReducer,
  clampChartPinPosition,
  isChartTooltipFrozen,
  isChartTooltipInteractive,
  isChartTooltipReach,
  isChartTooltipRetained,
  chartTooltipReachMargin,
  tooltipHoldReducer,
  type ChartPinAction,
  type ChartPinDescriptor,
  type ChartPinItem,
} from "../chart-pins";

const dragThreshold = 4;

type ChartPinContextValue = {
  pins: ChartPinItem[];
  add: (descriptor: ChartPinDescriptor, bounds: DOMRect) => ChartPinItem;
  remove: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  raise: (id: string) => void;
  measure: (id: string, width: number, height: number) => void;
  beginDrag: (
    descriptor: ChartPinDescriptor,
    bounds: DOMRect,
    pointer: { id: number; x: number; y: number },
    wasPinned: boolean,
  ) => void;
  claimTransient: (id: string, dismiss: () => void) => void;
  releaseTransient: (id: string) => void;
};

const ChartPinContext = createContext<ChartPinContextValue | null>(null);

function viewportSize() {
  return {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  };
}

export function ChartPinProvider({ children }: { children: ReactNode }) {
  const [pins, setPins] = useState<ChartPinItem[]>([]);
  const pinsRef = useRef(pins);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const transientRef = useRef<{ id: string; dismiss: () => void } | null>(
    null,
  );
  pinsRef.current = pins;
  const dispatch = useCallback((action: ChartPinAction) => {
    setPins((current) => chartPinsReducer(current, action));
  }, []);

  const add = useCallback(
    (descriptor: ChartPinDescriptor, bounds: DOMRect) => {
      const viewport = viewportSize();
      const position = clampChartPinPosition(
        bounds.left,
        bounds.top,
        bounds.width,
        bounds.height,
        viewport.width,
        viewport.height,
      );
      const item = {
        ...descriptor,
        ...position,
        width: bounds.width,
        height: bounds.height,
      };
      dispatch({ type: "add", item });
      return item;
    },
    [dispatch],
  );
  const remove = useCallback(
    (id: string) => dispatch({ type: "remove", id }),
    [dispatch],
  );
  const move = useCallback(
    (id: string, x: number, y: number) => {
      const item = pinsRef.current.find((candidate) => candidate.id === id);
      if (!item) return;
      const viewport = viewportSize();
      const position = clampChartPinPosition(
        x,
        y,
        item.width,
        item.height,
        viewport.width,
        viewport.height,
      );
      dispatch({ type: "move", id, ...position });
    },
    [dispatch],
  );
  const raise = useCallback(
    (id: string) => dispatch({ type: "raise", id }),
    [dispatch],
  );
  const measure = useCallback(
    (id: string, width: number, height: number) => {
      const viewport = viewportSize();
      dispatch({
        type: "measure",
        id,
        width,
        height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    },
    [dispatch],
  );
  const beginDrag = useCallback(
    (
      descriptor: ChartPinDescriptor,
      bounds: DOMRect,
      pointer: { id: number; x: number; y: number },
      wasPinned: boolean,
    ) => {
      dragCleanupRef.current?.();
      const activeItem =
        pinsRef.current.find((item) => item.id === descriptor.id) ??
        add(descriptor, bounds);
      raise(descriptor.id);
      let moved = false;
      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== pointer.id) return;
        const deltaX = event.clientX - pointer.x;
        const deltaY = event.clientY - pointer.y;
        if (Math.hypot(deltaX, deltaY) >= dragThreshold) moved = true;
        if (!moved) return;
        event.preventDefault();
        const current =
          pinsRef.current.find((item) => item.id === descriptor.id) ??
          activeItem;
        const viewport = viewportSize();
        const position = clampChartPinPosition(
          activeItem.x + deltaX,
          activeItem.y + deltaY,
          current.width,
          current.height,
          viewport.width,
          viewport.height,
        );
        dispatch({ type: "move", id: descriptor.id, ...position });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerUp, true);
        window.removeEventListener("pointercancel", onPointerCancel, true);
        if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
      };
      const onPointerUp = (event: PointerEvent) => {
        if (event.pointerId !== pointer.id) return;
        if (!moved && wasPinned) remove(descriptor.id);
        cleanup();
      };
      const onPointerCancel = (event: PointerEvent) => {
        if (event.pointerId === pointer.id) cleanup();
      };
      window.addEventListener("pointermove", onPointerMove, {
        capture: true,
        passive: false,
      });
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerCancel, true);
      dragCleanupRef.current = cleanup;
    },
    [add, dispatch, raise, remove],
  );
  const claimTransient = useCallback((id: string, dismiss: () => void) => {
    const current = transientRef.current;
    if (current?.id !== id) current?.dismiss();
    transientRef.current = { id, dismiss };
  }, []);
  const releaseTransient = useCallback((id: string) => {
    if (transientRef.current?.id === id) transientRef.current = null;
  }, []);

  useEffect(() => {
    const clamp = () => {
      const viewport = viewportSize();
      dispatch({
        type: "clamp",
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [dispatch]);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const value = useMemo(
    () => ({
      pins,
      add,
      remove,
      move,
      raise,
      measure,
      beginDrag,
      claimTransient,
      releaseTransient,
    }),
    [
      pins,
      add,
      remove,
      move,
      raise,
      measure,
      beginDrag,
      claimTransient,
      releaseTransient,
    ],
  );
  return (
    <ChartPinContext.Provider value={value}>
      {children}
      <ChartPinLayer />
    </ChartPinContext.Provider>
  );
}

function useChartPins() {
  const context = useContext(ChartPinContext);
  if (!context)
    throw new Error("Pinnable chart tooltips require ChartPinProvider");
  return context;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

type ChartTooltipCardInteractionProps = {
  onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onFocus: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onBlur: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

type ChartTooltipPinInteractionProps = {
  onPointerEnter: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onFocus: (event: ReactFocusEvent<HTMLButtonElement>) => void;
  onBlur: (event: ReactFocusEvent<HTMLButtonElement>) => void;
  onRelease: () => void;
};

function tooltipNow() {
  return performance.now();
}

// Pointer-down focuses the pin so arrow keys can nudge it, but only keyboard
// focus should hold and freeze the tooltip behind it.
function isKeyboardFocus(element: HTMLElement) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function useChartTooltipHold<T>(
  current: T | null,
  claimKey: string | null,
) {
  const live = current !== null;
  const transientId = useId();
  const { claimTransient, releaseTransient } = useChartPins();
  const [state, dispatch] = useReducer(
    tooltipHoldReducer,
    live,
    createTooltipHoldState,
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<T | null>(null);
  if (current !== null && !isChartTooltipFrozen(state))
    snapshotRef.current = current;

  const renderNow = tooltipNow();
  const renderState =
    state.rechartsActive === live
      ? state
      : tooltipHoldReducer(state, {
          type: "recharts",
          active: live,
          now: renderNow,
        });
  const retained =
    !live &&
    isChartTooltipRetained(
      renderState,
      snapshotRef.current !== null,
      renderNow,
    );
  const snapshot =
    !renderState.superseded && (live || retained)
      ? snapshotRef.current
      : null;

  const dismissForSupersede = useCallback(() => {
    const card = cardRef.current;
    const focused =
      typeof document !== "undefined" ? document.activeElement : null;
    if (card && focused instanceof Node && card.contains(focused)) return;
    dispatch({ type: "supersede" });
  }, []);

  useLayoutEffect(() => {
    if (!live || claimKey === null) return;
    claimTransient(transientId, dismissForSupersede);
    dispatch({ type: "restore" });
  }, [claimKey, claimTransient, dismissForSupersede, live, transientId]);

  useEffect(() => {
    if (snapshot !== null) return;
    releaseTransient(transientId);
  }, [releaseTransient, snapshot, transientId]);

  useEffect(
    () => () => releaseTransient(transientId),
    [releaseTransient, transientId],
  );

  useLayoutEffect(() => {
    dispatch({ type: "recharts", active: live, now: tooltipNow() });
  }, [live]);

  useEffect(() => {
    if (state.deadline === null) return;
    const timeout = window.setTimeout(
      () => dispatch({ type: "timer", now: tooltipNow() }),
      Math.max(0, state.deadline - tooltipNow()),
    );
    return () => window.clearTimeout(timeout);
  }, [state.deadline]);

  // Watching the pointer here rather than on the card itself: while the chart
  // drives the tooltip the card is transparent to the pointer, so it never sees
  // the approach that is meant to reach it.
  useEffect(() => {
    let last: { x: number; y: number } | null = null;
    let engaged = false;
    const onPointerMove = (event: PointerEvent) => {
      const card = cardRef.current;
      const previous = last;
      last = { x: event.clientX, y: event.clientY };
      if (!card) {
        if (!engaged) return;
        engaged = false;
        dispatch({ type: "card-reach", inside: false, now: tooltipNow() });
        return;
      }
      const rect = card.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top - chartTooltipReachMargin &&
        event.clientY <= rect.bottom;
      const movement = previous
        ? { dx: event.clientX - previous.x, dy: event.clientY - previous.y }
        : { dx: 0, dy: 0 };
      const reach = isChartTooltipReach(movement, inside, engaged);
      if (reach === engaged) return;
      engaged = reach;
      dispatch({ type: "card-reach", inside: reach, now: tooltipNow() });
    };
    window.addEventListener("pointermove", onPointerMove, true);
    return () =>
      window.removeEventListener("pointermove", onPointerMove, true);
  }, []);

  useEffect(() => {
    if (!retained) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "dismiss" });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !cardRef.current?.contains(target))
        dispatch({ type: "dismiss" });
    };
    const releasePointerHolds = () => {
      const now = tooltipNow();
      dispatch({ type: "pin-pointer", inside: false, now });
      dispatch({ type: "card-pointer", inside: false, now });
      dispatch({ type: "card-reach", inside: false, now });
    };
    const onPointerMove = (event: PointerEvent) => {
      const card = cardRef.current;
      if (!card || event.composedPath().includes(card)) return;
      releasePointerHolds();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden")
        dispatch({ type: "dismiss" });
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointercancel", releasePointerHolds, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", releasePointerHolds);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointercancel", releasePointerHolds, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", releasePointerHolds);
    };
  }, [retained]);

  // Hovering the pin freezes the card while the pointer is still over the
  // chart; that freeze, and the retained state after the pointer leaves, are
  // the two moments the card is stable enough to accept clicks of its own.
  const interactive = isChartTooltipInteractive(renderState, retained);
  const cardInteractionProps: ChartTooltipCardInteractionProps = {
    onPointerEnter: () =>
      dispatch({ type: "card-pointer", inside: true, now: tooltipNow() }),
    onPointerMove: () =>
      dispatch({ type: "card-pointer", inside: true, now: tooltipNow() }),
    onPointerLeave: () =>
      dispatch({ type: "card-pointer", inside: false, now: tooltipNow() }),
    onFocus: (event) => {
      const related = event.relatedTarget;
      if (!(related instanceof Node) || !event.currentTarget.contains(related))
        dispatch({ type: "card-focus", inside: true, now: tooltipNow() });
    },
    onBlur: (event) => {
      const related = event.relatedTarget;
      if (!(related instanceof Node) || !event.currentTarget.contains(related))
        dispatch({ type: "card-focus", inside: false, now: tooltipNow() });
    },
    onMouseMove: (event) => {
      // Recharts reads mouse moves that reach the chart behind this card as a
      // scrub to another point, which would swap the data out from under a
      // pointer that is on its way to a control inside the card.
      if (interactive) event.stopPropagation();
    },
  };
  const releasePin = useCallback(() => {
    const now = tooltipNow();
    dispatch({ type: "pin-pointer", inside: false, now });
    dispatch({ type: "pin-focus", inside: false, now });
    dispatch({ type: "card-pointer", inside: false, now });
    dispatch({ type: "card-focus", inside: false, now });
  }, []);
  const pinInteractionProps = useMemo<ChartTooltipPinInteractionProps>(
    () => ({
      onPointerEnter: () =>
        dispatch({ type: "pin-pointer", inside: true, now: tooltipNow() }),
      onPointerLeave: () =>
        dispatch({ type: "pin-pointer", inside: false, now: tooltipNow() }),
      onFocus: (event) => {
        if (!isKeyboardFocus(event.currentTarget)) return;
        dispatch({ type: "pin-focus", inside: true, now: tooltipNow() });
      },
      onBlur: () =>
        dispatch({ type: "pin-focus", inside: false, now: tooltipNow() }),
      onRelease: releasePin,
    }),
    [releasePin],
  );

  return {
    snapshot,
    retained,
    interactive,
    cardRef,
    cardInteractionProps,
    pinInteractionProps,
  };
}

function PinDragHandle({
  descriptor,
  cardRef,
  interactionProps,
}: {
  descriptor: ChartPinDescriptor;
  cardRef: React.RefObject<HTMLDivElement | null>;
  interactionProps?: ChartTooltipPinInteractionProps;
}) {
  const { pins, add, remove, move, raise, beginDrag } = useChartPins();
  const item = pins.find((candidate) => candidate.id === descriptor.id);
  const pinned = Boolean(item);
  const { onRelease, ...handlers } = interactionProps ?? {};
  // A card removed under the pointer emits no pointerleave or blur, so the
  // holds it opened have to be released when the handle goes away with it.
  useEffect(() => () => onRelease?.(), [onRelease]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.focus();
    const bounds = cardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    beginDrag(
      descriptor,
      bounds,
      { id: event.pointerId, x: event.clientX, y: event.clientY },
      pinned,
    );
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && pinned) {
      event.preventDefault();
      event.stopPropagation();
      remove(descriptor.id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const bounds = cardRef.current?.getBoundingClientRect();
      if (pinned) remove(descriptor.id);
      else if (bounds) add(descriptor, bounds);
      return;
    }
    if (!item || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 24 : 8;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    raise(descriptor.id);
    move(descriptor.id, item.x + delta[0], item.y + delta[1]);
  };

  return (
    <button
      type="button"
      className={`chart-tooltip__pin${pinned ? " is-pinned" : ""}`}
      aria-label={
        pinned
          ? `Unpin or move ${descriptor.ariaLabel}`
          : `Pin ${descriptor.ariaLabel}`
      }
      aria-pressed={pinned}
      title={
        pinned ? "Drag to move · click or Escape to unpin" : "Pin and drag"
      }
      {...handlers}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <Pin aria-hidden="true" />
    </button>
  );
}

type PinnableChartTooltipProps = Omit<ChartPinDescriptor, "content"> & {
  contextLabel: string;
  contextDescription: string;
  contextPlacement?: "header" | "inline";
  forwardedRef?: Ref<HTMLDivElement>;
  interactionRef?: Ref<HTMLDivElement>;
  retained?: boolean;
  /** Whether the card is stable enough to take pointer input of its own. */
  interactive?: boolean;
  cardInteractionProps?: ChartTooltipCardInteractionProps;
  pinInteractionProps?: ChartTooltipPinInteractionProps;
  children: ReactNode;
};

export function PinnableChartTooltip({
  id,
  ariaLabel,
  contextLabel,
  contextDescription,
  contextPlacement = "header",
  className = "",
  children,
  forwardedRef,
  interactionRef,
  retained = false,
  interactive = false,
  cardInteractionProps,
  pinInteractionProps,
}: PinnableChartTooltipProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const { pins } = useChartPins();
  const descriptor = useMemo(
    () => ({
      id,
      ariaLabel,
      contextLabel,
      contextDescription,
      contextPlacement,
      className,
      content: children,
    }),
    [
      id,
      ariaLabel,
      contextLabel,
      contextDescription,
      contextPlacement,
      className,
      children,
    ],
  );
  // Recharts renders this card inside the chart, and its accessibility layer
  // reads any focus that reaches the chart as the start of keyboard navigation,
  // which opens a second tooltip on the first data point. Focusing the pin
  // handle must stay inside the card.
  const {
    onFocus: onCardFocus,
    onBlur: onCardBlur,
    ...cardHandlers
  } = cardInteractionProps ?? {};
  // The pinned copy already shows this data point, so the in-chart card would
  // only duplicate it — including while the pin is being dragged away.
  if (pins.some((item) => item.id === id)) return null;
  return (
    <div
      className={`chart-tooltip pinnable-chart-tooltip ${className}`.trim()}
      data-tooltip-retained={retained ? "true" : undefined}
      data-tooltip-interactive={interactive ? "true" : undefined}
      {...cardHandlers}
      onFocus={(event) => {
        event.stopPropagation();
        onCardFocus?.(event);
      }}
      onBlur={(event) => {
        event.stopPropagation();
        onCardBlur?.(event);
      }}
      ref={(node) => {
        localRef.current = node;
        setRef(forwardedRef, node);
        setRef(interactionRef, node);
      }}
    >
      <PinDragHandle
        descriptor={descriptor}
        cardRef={localRef}
        interactionProps={pinInteractionProps}
      />
      {contextPlacement === "header" && (
        <ChartTooltipContext
          label={contextLabel}
          description={contextDescription}
        />
      )}
      <div className="chart-tooltip__body">{children}</div>
    </div>
  );
}

export function ChartTooltipContext({
  label,
  description,
  className = "",
}: {
  label?: string;
  description?: string;
  className?: string;
}) {
  const descriptionId = useId();
  const infoRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
    placement: "right" | "left" | "bottom" | "top";
  } | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const pointerActiveRef = useRef(false);
  const keyboardFocusRef = useRef(false);
  const pointerDismissTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pointerDismissTimerRef.current !== null) {
        window.clearTimeout(pointerDismissTimerRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!popoverOpen || !description) return;
    const updatePosition = () => {
      const info = infoRef.current;
      const popover = popoverRef.current;
      if (!info || !popover) return;

      const anchor = info.getBoundingClientRect();
      const popoverBounds = popover.getBoundingClientRect();
      const edgePadding = 12;
      const gap = 10;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const clamp = (value: number, min: number, max: number) =>
        Math.min(Math.max(value, min), Math.max(min, max));
      const canPlaceRight =
        anchor.right + gap + popoverBounds.width <= viewportWidth - edgePadding;
      const canPlaceLeft =
        anchor.left - gap - popoverBounds.width >= edgePadding;

      let left: number;
      let top: number;
      let placement: "right" | "left" | "bottom" | "top";
      if (canPlaceRight) {
        left = anchor.right + gap;
        top = anchor.top + (anchor.height - popoverBounds.height) / 2;
        placement = "right";
      } else if (canPlaceLeft) {
        left = anchor.left - gap - popoverBounds.width;
        top = anchor.top + (anchor.height - popoverBounds.height) / 2;
        placement = "left";
      } else {
        left = anchor.left + (anchor.width - popoverBounds.width) / 2;
        const belowTop = anchor.bottom + gap;
        const aboveTop = anchor.top - gap - popoverBounds.height;
        if (belowTop + popoverBounds.height <= viewportHeight - edgePadding) {
          top = belowTop;
          placement = "bottom";
        } else {
          top = aboveTop;
          placement = "top";
        }
      }

      setPopoverPosition((previous) => {
        const next = {
          left: clamp(
            left,
            edgePadding,
            viewportWidth - edgePadding - popoverBounds.width,
          ),
          top: clamp(
            top,
            edgePadding,
            viewportHeight - edgePadding - popoverBounds.height,
          ),
          placement,
        };
        return previous &&
          previous.left === next.left &&
          previous.top === next.top &&
          previous.placement === next.placement
          ? previous
          : next;
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("pointermove", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("pointermove", updatePosition);
    };
  }, [description, popoverOpen]);

  if (!label && !description) return null;
  const infoLabel = label ? `About ${label}` : "More information";
  const cancelPointerDismiss = () => {
    if (pointerDismissTimerRef.current === null) return;
    window.clearTimeout(pointerDismissTimerRef.current);
    pointerDismissTimerRef.current = null;
  };
  const showPopover = () => setPopoverOpen(true);
  const hidePopover = () => {
    cancelPointerDismiss();
    setPopoverOpen(false);
    setPopoverPosition(null);
  };
  const schedulePointerDismiss = () => {
    cancelPointerDismiss();
    pointerDismissTimerRef.current = window.setTimeout(() => {
      pointerDismissTimerRef.current = null;
      if (!pointerActiveRef.current && !keyboardFocusRef.current) {
        hidePopover();
      }
    }, 180);
  };
  const showForPointer = () => {
    cancelPointerDismiss();
    pointerActiveRef.current = true;
    showPopover();
  };
  const hideForPointer = () => {
    pointerActiveRef.current = false;
    if (!keyboardFocusRef.current) schedulePointerDismiss();
  };
  const showForKeyboard = () => {
    if (!pointerActiveRef.current) keyboardFocusRef.current = true;
    showPopover();
  };
  const hideForKeyboard = () => {
    keyboardFocusRef.current = false;
    if (!pointerActiveRef.current) schedulePointerDismiss();
  };
  const closeFromControl = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    pointerActiveRef.current = false;
    keyboardFocusRef.current = false;
    event.currentTarget.blur();
    hidePopover();
  };
  const stopPopoverPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };
  const showForPopoverFocus = () => {
    cancelPointerDismiss();
    keyboardFocusRef.current = true;
    showPopover();
  };
  const hideForPopoverFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    const related = event.relatedTarget;
    if (!(related instanceof Node) || !event.currentTarget.contains(related)) {
      keyboardFocusRef.current = false;
      if (!pointerActiveRef.current) schedulePointerDismiss();
    }
  };
  return (
    <>
      <span className={`chart-tooltip__context ${className}`.trim()}>
        {label && <span className="chart-tooltip__context-label">{label}</span>}
        {description && (
          <button
            ref={infoRef}
            type="button"
            className="chart-tooltip__info"
            aria-label={infoLabel}
            aria-describedby={descriptionId}
            onPointerEnter={showForPointer}
            onPointerLeave={hideForPointer}
            onPointerCancel={hideForPointer}
            onFocus={showForKeyboard}
            onBlur={hideForKeyboard}
            onPointerDown={(event) => {
              cancelPointerDismiss();
              pointerActiveRef.current = true;
              event.stopPropagation();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <Info aria-hidden="true" />
          </button>
        )}
      </span>
      {description && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              className={`chart-tooltip__context-popover${popoverPosition ? " is-visible" : ""}`}
              data-placement={popoverPosition?.placement ?? "right"}
              role="dialog"
              aria-label={infoLabel}
              onPointerEnter={showForPointer}
              onPointerLeave={hideForPointer}
              onPointerDown={stopPopoverPointerDown}
              onFocus={showForPopoverFocus}
              onBlur={hideForPopoverFocus}
              style={{
                left: popoverPosition?.left ?? 0,
                top: popoverPosition?.top ?? 0,
                visibility: popoverPosition ? "visible" : "hidden",
              }}
            >
              <span id={descriptionId}>{description}</span>
              <button
                type="button"
                className="chart-tooltip__context-close"
                aria-label={`Close ${label ?? "description"}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={closeFromControl}
              >
                <X aria-hidden="true" />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PinnedTooltipCard({
  item,
  stackIndex,
}: {
  item: ChartPinItem;
  stackIndex: number;
}) {
  const { raise, measure } = useChartPins();
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const update = () => measure(item.id, card.offsetWidth, card.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(card);
    return () => observer.disconnect();
  }, [item.id, measure]);
  const descriptor = useMemo<ChartPinDescriptor>(
    () => ({
      id: item.id,
      ariaLabel: item.ariaLabel,
      contextLabel: item.contextLabel,
      contextDescription: item.contextDescription,
      contextPlacement: item.contextPlacement,
      className: item.className,
      content: item.content,
    }),
    [item],
  );
  const style = {
    left: item.x,
    top: item.y,
    width: item.width,
    zIndex: stackIndex + 1,
  } satisfies CSSProperties;
  return (
    <div
      className={`chart-tooltip pinnable-chart-tooltip pinned-chart-tooltip ${item.className ?? ""}`.trim()}
      ref={cardRef}
      style={style}
      role="region"
      aria-label={`Pinned ${item.ariaLabel}`}
      data-chart-pin={item.id}
      onPointerDownCapture={() => raise(item.id)}
      onFocusCapture={() => raise(item.id)}
    >
      <PinDragHandle descriptor={descriptor} cardRef={cardRef} />
      {item.contextPlacement !== "inline" && (
        <ChartTooltipContext
          label={item.contextLabel}
          description={item.contextDescription}
        />
      )}
      <div className="chart-tooltip__body">{item.content}</div>
    </div>
  );
}

function ChartPinLayer() {
  const { pins } = useChartPins();
  if (typeof document === "undefined" || pins.length === 0) return null;
  return createPortal(
    <div className="chart-pin-layer" aria-label="Pinned chart details">
      {pins.map((item, index) => (
        <PinnedTooltipCard key={item.id} item={item} stackIndex={index} />
      ))}
    </div>,
    document.body,
  );
}
