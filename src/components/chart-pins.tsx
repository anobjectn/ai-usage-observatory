import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { Pin } from "lucide-react";
import {
  createTooltipHoldState,
  chartPinsReducer,
  clampChartPinPosition,
  isChartTooltipFrozen,
  isChartTooltipRetained,
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
    () => ({ pins, add, remove, move, raise, measure, beginDrag }),
    [pins, add, remove, move, raise, measure, beginDrag],
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
};

function tooltipNow() {
  return performance.now();
}

export function useChartTooltipHold<T>(current: T | null) {
  const live = current !== null;
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
  const snapshot = live || retained ? snapshotRef.current : null;

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
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [retained]);

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
      if (retained) event.stopPropagation();
    },
  };
  const pinInteractionProps: ChartTooltipPinInteractionProps = {
    onPointerEnter: () =>
      dispatch({ type: "pin-pointer", inside: true, now: tooltipNow() }),
    onPointerLeave: () =>
      dispatch({ type: "pin-pointer", inside: false, now: tooltipNow() }),
    onFocus: () =>
      dispatch({ type: "pin-focus", inside: true, now: tooltipNow() }),
    onBlur: () =>
      dispatch({ type: "pin-focus", inside: false, now: tooltipNow() }),
  };

  return {
    snapshot,
    retained,
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
      title={pinned ? "Drag to move · click to unpin" : "Pin and drag"}
      {...interactionProps}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <Pin aria-hidden="true" />
    </button>
  );
}

type PinnableChartTooltipProps = Omit<ChartPinDescriptor, "content"> & {
  forwardedRef?: Ref<HTMLDivElement>;
  interactionRef?: Ref<HTMLDivElement>;
  retained?: boolean;
  cardInteractionProps?: ChartTooltipCardInteractionProps;
  pinInteractionProps?: ChartTooltipPinInteractionProps;
  children: ReactNode;
};

export function PinnableChartTooltip({
  id,
  ariaLabel,
  className = "",
  children,
  forwardedRef,
  interactionRef,
  retained = false,
  cardInteractionProps,
  pinInteractionProps,
}: PinnableChartTooltipProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const descriptor = useMemo(
    () => ({ id, ariaLabel, className, content: children }),
    [id, ariaLabel, className, children],
  );
  return (
    <div
      className={`chart-tooltip pinnable-chart-tooltip ${className}`.trim()}
      data-tooltip-retained={retained ? "true" : undefined}
      {...cardInteractionProps}
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
      <div className="chart-tooltip__body">{children}</div>
    </div>
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
