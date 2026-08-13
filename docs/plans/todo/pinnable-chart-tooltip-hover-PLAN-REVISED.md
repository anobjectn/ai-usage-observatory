# Pinnable chart tooltip hover — revised plan

Revision of `pinnable-chart-tooltip-hover-HANDOFF.md`. The goal is unchanged;
the mechanism is corrected against how Recharts 3.9.2 actually renders tooltips
and against the current state of the uncommitted work.

Work in `/Users/luis/htdocs/ai-usage-observatory`.

## Goal

Make the pin control of a hovered chart tooltip reachable and make the pin
capture the data point the user meant, without regressing chart scrubbing.

Behavior contract:

- When Recharts deactivates the tooltip, retain the last valid snapshot for a
  grace period of ~400 ms.
- Pointer or focus inside the tooltip card cancels dismissal.
- Leaving the card restarts a shorter dismissal timer of ~180 ms.
- Hovering or focusing the pin button freezes tooltip content, so the pin acts
  on the data point that was showing when the pointer reached it.
- Pointer-down on the pin stays immediate; pin-and-drag is unaffected.
- Scrubbing across the plot area still updates content immediately.
- No tooltip or pin state persists across reload or view change.

## Ground truth verified in the code

Current uncommitted files: `src/App.tsx`, `src/styles.css`, `src/chart-pins.ts`,
`src/chart-pins.test.ts`, `src/components/chart-pins.tsx`.

Four pinnable tooltips, all rendered through `<Tooltip content={...}>` with
`isAnimationActive={false}` and `wrapperStyle={chartTooltipWrapperStyle}`
(`transition: "none"`):

| Component | `src/App.tsx` | Data needed for a snapshot |
| --- | --- | --- |
| `ModelSignalTooltip` | 785 | `row` (`payload[0].payload`), `coordinate`, `metric` |
| `ProviderChartTooltip` | 947 | `payload` array, `label`, `coordinate` |
| `EffortDayTooltip` | 3143 | `point` (`payload[0].payload.__point`), `label`, `coordinate` |
| `ProjectDayTooltip` | 4945 | `row` (`payload[0].payload`), `coordinate` |

Recharts facts confirmed in `node_modules/recharts/lib`:

1. `Tooltip.js:152` — when inactive, `finalPayload` is replaced by the shared
   `emptyPayload` constant. The `label` also becomes `undefined`. So payload and
   label must be cached; the handoff is right about this.
2. `tooltipSlice.js:161` (`mouseLeaveChart`) and
   `combineTooltipInteractionState.js` — `coordinate` is deliberately preserved
   on leave. Positioning therefore stays stable through the grace window and
   `useClampedTooltip` keeps producing the same `--tooltip-x`.
3. `Tooltip.js:207` — the content element is re-rendered, never unmounted, when
   the tooltip deactivates. Hook state inside the tooltip component survives, so
   a hook-local snapshot ref is a valid place to keep the cache.
4. **`TooltipBoundingBox.js:99` — the wrapper gets
   `visibility: !dismissed && active && hasPayload ? "visible" : "hidden"`.**
   The handoff misses this entirely. `pointer-events: auto` alone leaves the
   graced card invisible *and* unhittable, and removes the pin button from the
   tab order. This is the blocker for the handoff's approach.
5. `TooltipBoundingBox.js:93` — the wrapper is `pointer-events: none`. A
   descendant may still opt back in; `.chart-tooltip__pin{pointer-events:auto}`
   (`src/styles.css:248`) already relies on this and works today.
6. `Tooltip.js:186` — `<Cursor>` unmounts when inactive, so the cursor line or
   bar highlight disappears during the grace window. Expected, not a bug.

## Corrections to the handoff

### 1. Restore visibility, not just pointer events (blocker)

The card must override the inherited `visibility: hidden`:

```css
.pinnable-chart-tooltip { visibility: visible; }
```

Do **not** put `visibility` into `wrapperStyle`. `props.wrapperStyle` is spread
after `visibility` in `outerStyle`, so it would pin every tooltip visible
forever. The override belongs on the card, where our own render gate (the hook
returns `null` once grace expires) controls whether a card exists at all.

### 2. Scope `pointer-events: auto` to the grace window only

The handoff's blanket `.pinnable-chart-tooltip { pointer-events: auto }` will
reproduce the hang it warns about. With `offset={0}` and
`transform: translate(var(--tooltip-x), -6px)`, the card sits directly under the
pointer over the plot area. An always-hittable card intercepts the scrub, the
chart stops updating, and enter/leave oscillation follows.

Gate it with a data attribute the hook drives:

```css
.pinnable-chart-tooltip[data-tooltip-grace="true"] { pointer-events: auto; }
```

While Recharts is active the card stays `pointer-events: none` — exactly today's
proven behavior — with the pin button as the only hittable child.

### 3. Freeze content on pin hover (missing requirement)

Reaching the pin is not only a dismissal problem. The pin sits at
`left: 7px; top: 7px` of a card up to 410 px wide that is horizontally centered
on the cursor, so traveling to it crosses ~200 px of plot area. The card is
click-through, the chart keeps scrubbing, the snapshot changes under the pointer,
and the descriptor `id` changes with it — the user pins a neighbouring point.

Fix: `pointerenter`/`focus` on the pin button sets a freeze flag that makes the
tooltip ignore incoming Recharts updates and keep rendering the current
snapshot. `pointerleave`/`blur` releases it and content snaps to live. Because
the button is a DOM descendant of `.recharts-wrapper`, pointer events still
bubble and Recharts stays active — no deactivation loop.

This makes the state a single rule rather than two features:

```
held = pointerInsideCard || pointerInsidePin || focusWithinCard || withinGraceWindow
```

### 4. Put the timer logic in a pure module so it is testable

There is no DOM test harness in this repo — every file in `src/*.test.ts` tests
pure functions under `bun test`, and `bunfig.toml` only preloads
`server/test-setup.ts`. A hook written entirely inside
`src/components/chart-pins.tsx` ships untested.

Mirror the existing split (`src/chart-pins.ts` pure, `components/chart-pins.tsx`
React) and add a pure reducer to `src/chart-pins.ts`:

```ts
export type TooltipHoldState = {
  phase: "idle" | "live" | "held" | "grace";
  deadline: number | null;
};

export type TooltipHoldEvent =
  | { type: "recharts-active" }
  | { type: "recharts-inactive"; now: number }
  | { type: "enter-card" }
  | { type: "leave-card"; now: number }
  | { type: "enter-pin" }
  | { type: "leave-pin"; now: number }
  | { type: "focus-in" }
  | { type: "focus-out"; now: number }
  | { type: "dismiss" }
  | { type: "tick"; now: number };

export function tooltipHoldReducer(
  state: TooltipHoldState,
  event: TooltipHoldEvent,
): TooltipHoldState;
```

Timings as named constants in the same module: `chartTooltipExitGraceMs = 400`,
`chartTooltipLeaveGraceMs = 180`.

Add cases to `src/chart-pins.test.ts`:

- inactive then no interaction → dismissed after 400 ms, not before;
- inactive then `enter-card` before the deadline → deadline cleared;
- `leave-card` → dismissal at 180 ms, not 400 ms;
- re-activation during grace → back to `live`, snapshot replaced;
- `enter-pin` while live → `held`, and `recharts-active` events while held do not
  change phase;
- `dismiss` from any phase → `idle`.

### 5. Hook and component wiring

In `src/components/chart-pins.tsx`:

```ts
export function useChartTooltipHold<T>(current: T | null): {
  snapshot: T | null;
  cardProps: {
    "data-tooltip-grace": "true" | undefined;
    onPointerEnter: ...;
    onPointerMove: ...;
    onPointerLeave: ...;
    onFocus: ...;
    onBlur: ...;
  };
  pinProps: { onPointerEnter: ...; onPointerLeave: ...; onFocus: ...; onBlur: ... };
};
```

Implementation notes that are easy to get wrong:

- Keep the snapshot in a ref and mirror the phase in state, so a phase change
  re-renders but a snapshot write during render does not.
- Include `onPointerMove` alongside `onPointerEnter`. The card only becomes
  hittable at the moment grace starts, and a `pointerenter` is not replayed for
  a pointer that is already stationary over the newly-hittable element.
- Use React `onFocus`/`onBlur` (delegated `focusin`/`focusout`, they bubble) —
  not native `focus`/`blur`, which do not.
- Dismiss immediately on `Escape` (matching Recharts' own dismissal) and on
  `pointerdown` outside the card, so a stale graced card from one chart cannot
  sit over another chart and swallow its input.
- Clear all timers on unmount. `ChartPinProvider` is keyed by `view`, so a view
  change unmounts the tree and the timers with it.
- Gate on `active && payload?.length` rather than payload truthiness: Recharts
  passes a stable non-null empty array when inactive.
- On a coarse pointer (`event.pointerType === "touch"`), treat the tap as
  entering the card directly; do not rely on hover transitions.

`PinnableChartTooltip` gains `interactionProps` and `pinInteractionProps`,
spread onto the root `<div>` and forwarded to `PinDragHandle`'s `<button>`
respectively. `PinDragHandle`'s existing `onPointerDown` must keep running
before any hold logic — do not wrap it in a handler that can swallow the event.

In each of the four tooltip components:

- Call `useChartTooltipHold` **above** the existing `if (!active || ...) return null`
  early return, next to `useId`/`useClampedTooltip`, to keep hook order stable.
- Feed `useClampedTooltip` the retained active flag and retained coordinate, not
  the raw props.
- Derive the pin descriptor `id` from the snapshot, so a graced or frozen card
  pins the point it is displaying.

## Verification

```sh
bun run typecheck
bun test
bun run build
```

Per `AGENTS.md`: check `http://localhost:5173` and `http://localhost:4318`
first, reuse a healthy server, never broad-kill processes, and report the final
URL and whether the app was preserved, restarted, or started.

Manual checks, per tooltip type (model signal, provider timeline, effort day,
project day):

1. Hover a point; scrub sideways — content updates immediately, no lag or
   flicker, chart never freezes. *(Regression check for the previous hang.)*
2. Move onto the pin button; content freezes on that point.
3. Click to pin — the pinned card matches the frozen point, not a neighbour.
4. Press and drag straight off the pin — drag starts on the first move.
5. Leave the chart toward the card; the card stays and becomes interactive.
6. Enter the card, pause well past 400 ms, then leave — dismissal after ~180 ms.
7. Leave the chart away from the card — dismissal after ~400 ms.
8. Tab to the pin during grace and activate with Enter/Space.
9. Press Escape during grace — card dismisses at once.
10. Move quickly between two charts — no stale card blocks the second chart.
11. Change view and reload — pins clear both times.
12. Confirm the cursor highlight disappearing during grace looks acceptable.

## Repository requirements

- Invoke the `frontend-design` skill via the Skill tool before writing UI code.
  (The handoff's path `/Users/luis/.agents/skills/frontend-design/SKILL.md` and
  its `apply_patch` instruction are from a different harness; use the Edit/Write
  tools here.)
- Do not overwrite unrelated uncommitted user changes in `src/App.tsx` and
  `src/styles.css`.
- Do not run `git commit` unless explicitly asked.
- Any proposed commit message uses Conventional Commits with no
  `Co-Authored-By` trailer, for example:

```text
fix(charts): hold pinnable tooltips through hover exit
```
