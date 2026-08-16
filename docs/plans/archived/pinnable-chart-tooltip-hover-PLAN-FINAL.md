# Pinnable chart tooltip hover — final plan

Final revision of `pinnable-chart-tooltip-hover-PLAN-REVISED.md`, checked
against the current uncommitted implementation and Recharts 3.9.2.

Work in `/Users/luis/htdocs/ai-usage-observatory`.

## Goal

Make a hovered chart tooltip's pin reachable and ensure the pin captures the
data point the user intended, without interrupting normal chart scrubbing.

Behavior contract:

- When Recharts deactivates a tooltip, retain its last valid snapshot for
  approximately 400 ms.
- Pointer or focus inside the retained tooltip cancels dismissal.
- Leaving the retained tooltip restarts a shorter, approximately 180 ms timer.
- Hovering or focusing the pin freezes the displayed snapshot, so the pin acts
  on the point that was visible when the pointer reached it.
- Pointer-down on the pin remains immediate; pin-and-drag is unaffected.
- Scrubbing across the plot area continues to update content immediately.
- Tooltip and pin state remain in memory only and clear on view change or
  reload.

## Verified constraints

The current work spans:

- `src/App.tsx`
- `src/styles.css`
- `src/chart-pins.ts`
- `src/chart-pins.test.ts`
- `src/components/chart-pins.tsx`

The four pinnable tooltip components are `ModelSignalTooltip`,
`ProviderChartTooltip`, `EffortDayTooltip`, and `ProjectDayTooltip`.

Relevant Recharts 3.9.2 behavior:

1. `Tooltip.js` replaces payload with a shared empty array and clears the label
   when the tooltip becomes inactive. Payload-derived display data must be
   captured before that happens.
2. Tooltip content is re-rendered rather than unmounted on deactivation, so a
   hook-local snapshot survives the transition.
3. The last coordinate is retained on chart leave, so the cached coordinate can
   keep the card positioned during grace.
4. `TooltipBoundingBox` sets the wrapper to `visibility: hidden` when inactive,
   even though the custom content remains mounted. Pointer events alone cannot
   make the retained card reachable.
5. The wrapper has `pointer-events: none`. A child can opt back in; the existing
   `.chart-tooltip__pin { pointer-events: auto; }` already does this.
6. Tooltip DOM is portaled into `.recharts-wrapper`, whose React `onMouseMove`
   handler drives tooltip activation. Mouse movement from an interactive
   retained card can therefore bubble back into Recharts unless contained.
7. Recharts owns active-tooltip Escape dismissal by hiding its wrapper until
   the coordinate changes.
8. The chart cursor unmounts while inactive. Its disappearance during the grace
   period is expected.

## Implementation

### 1. Add a pure retention state machine

Put timing constants and pure state transitions in `src/chart-pins.ts`, keeping
the React hook in `src/components/chart-pins.tsx`.

Do not use the revised plan's single `phase` enum. Pointer, focus, and pin holds
can overlap; releasing one must not dismiss while another remains active. Track
the independent facts needed to derive behavior, for example:

```ts
export type TooltipHoldState = {
  rechartsActive: boolean;
  cardPointer: boolean;
  focusWithin: boolean;
  pinPointer: boolean;
  pinFocus: boolean;
  deadline: number | null;
};
```

Expose pure transitions or a reducer for:

- Recharts becoming active or inactive.
- Pointer entering or leaving the card.
- Pointer entering or leaving the pin.
- Focus entering or leaving the card.
- Pin focus and blur.
- Timer expiry.
- Explicit dismissal.

Use named constants:

```ts
export const chartTooltipExitGraceMs = 400;
export const chartTooltipLeaveGraceMs = 180;
```

Derived rules:

```text
held   = cardPointer || focusWithin || pinPointer || pinFocus
frozen = pinPointer || pinFocus
shown  = rechartsActive || held || deadline has not expired
```

When Recharts becomes inactive, start the 400 ms deadline unless an interaction
already holds the card. When the last interaction leaves while inactive, start
the 180 ms deadline. Re-activation clears the deadline. A release event checks
all remaining hold flags before scheduling dismissal.

### 2. Add the React snapshot hook

Add a reusable hook in `src/components/chart-pins.tsx`, such as:

```ts
useChartTooltipHold<T>(current: T | null)
```

It returns:

- `snapshot: T | null`
- `retained: boolean`, meaning a cached snapshot is displayed while raw
  Recharts content is inactive
- card interaction props
- pin interaction props

Implementation requirements:

- Store the last non-null snapshot in a ref.
- Replace it immediately while `current` is non-null and the pin is not frozen.
- Ignore live Recharts snapshot changes only while the pin is hovered or
  focused. Card hover alone retains the card but does not introduce a second
  freeze rule.
- Drive deadlines with one timeout based on reducer state; clear it on changes
  and unmount.
- Use `performance.now()` (or another monotonic clock) consistently for reducer
  `now` values and timeout calculations.
- Use React boundary-aware `onFocus`/`onBlur`; check `relatedTarget` so focus
  moving within the card does not release `focusWithin`.
- Keep separate pin-pointer and pin-focus flags, so pointer leave does not thaw
  a still-focused pin and blur does not thaw a still-hovered pin.
- Include `onPointerMove` as an idempotent enter fallback. Making an element
  hittable beneath a stationary pointer does not replay `pointerenter`; the next
  small movement must still acquire the card.
- While `retained`, stop the card's React `onMouseMove` propagation. Recharts
  listens for mouse events, so a pointer handler alone does not prevent the
  retained card from reactivating the chart beneath itself.
- Listen for Escape while an inactive snapshot is retained and dismiss it
  immediately. Do not override active-tooltip Escape behavior; Recharts already
  owns that state.
- While retained, a document-level pointer-down outside the card may dismiss
  stale grace state. The listener must be capture-only state cleanup: it must
  not prevent, stop, or synthesize the user's event.
- Clean up all document listeners and timers on unmount.
- Treat `active && payload?.length > 0` as live; inactive Recharts payload is a
  stable, non-null empty array.

No special coarse-pointer state is required for this hover fix. Preserve the
existing immediate touch/pointer-down behavior of the pin; add touch-specific
logic only if manual testing demonstrates a separate failure.

### 3. Restore visibility and hit-testing only during retention

Do not apply `visibility: visible` or `pointer-events: auto` to every pinnable
tooltip. Add an attribute only when a cached snapshot is being shown while raw
Recharts content is inactive:

```css
.pinnable-chart-tooltip[data-tooltip-retained="true"] {
  visibility: visible;
  pointer-events: auto;
}
```

This distinction is essential:

- While Recharts is active, the card keeps inherited `pointer-events: none`, so
  plot scrubbing remains unchanged; only the existing pin button is hittable.
- During grace, the card overrides the wrapper's inherited hidden visibility
  and becomes interactive.
- When Recharts dismisses an active tooltip with Escape, the card does not
  unconditionally override the wrapper's hidden state.
- Pinned portal cards remain interactive through their existing
  `.pinned-chart-tooltip` rule and do not need the retention attribute.

Do not put visibility or pointer events in `wrapperStyle`; Recharts spreads that
style last, which would override its own active/dismissed state globally.

### 4. Wire the tooltip and pin without replacing drag handlers

Extend `PinnableChartTooltip` with card interaction props and a narrowly typed
set of pin hover/focus props. Spread card props onto its root `<div>`.

Pass only `onPointerEnter`, `onPointerLeave`, `onFocus`, and `onBlur` into
`PinDragHandle`. Do not accept or spread an interaction `onPointerDown`; keeping
that event out of the extension point prevents accidental replacement of the
existing immediate pin/drag handler.

The existing `PinDragHandle` pointer-down must continue to:

1. stop propagation and prevent the default action;
2. focus the button;
3. measure the displayed card;
4. pin immediately and begin drag tracking.

### 5. Capture complete snapshots in all four tooltip components

Call `useChartTooltipHold` before any tooltip early return so hook order stays
stable. Construct `current` only when active and the required payload exists.

Snapshot shapes:

| Tooltip | Snapshot |
| --- | --- |
| Model signal | `row`, `coordinate`, `metric` |
| Provider timeline | `payload`, `label`, `coordinate` |
| Effort day | `point`, `label`, `coordinate` |
| Project day | `row`, `coordinate` |

Render exclusively from the returned snapshot. In particular:

- pass snapshot presence and snapshot coordinate to `useClampedTooltip`;
- derive every visible label/value from the snapshot where Recharts can clear
  it;
- derive the pin descriptor ID and accessible label from the snapshot;
- pass the retention attribute and interaction props to
  `PinnableChartTooltip`.

External component inputs such as `providerLabel`, `usageByDay`, and `basis`
can remain regular props unless they are incorporated into a Recharts-cleared
value. The model snapshot includes `metric` because it affects both displayed
value formatting and pin identity.

## Automated tests

Extend `src/chart-pins.test.ts` with deterministic reducer/selector tests:

1. Inactive starts a 400 ms grace and expires only at the deadline.
2. Card entry before the deadline clears it; card leave starts 180 ms.
3. Recharts reactivation during grace clears the deadline.
4. Pin hover or focus freezes; ordinary card hover does not.
5. Enter card, enter pin, then leave pin remains held by the card.
6. Pointer leave while focus remains does not schedule dismissal.
7. Pin pointer leave while pin focus remains stays frozen.
8. Releasing the final hold while inactive starts the short deadline.
9. Explicit dismissal clears inactive retained state.
10. The derived `retained` flag is true only when raw Recharts content is
    inactive and a snapshot is being retained, never merely because the pin is
    held while Recharts is active.

These tests cover the interaction algebra. The DOM-specific visibility,
event-propagation, and timer cleanup still require manual verification because
this repository has no browser DOM test harness.

## Verification

Run:

```sh
bun run typecheck
bun test
bun run build
```

Before touching a server, check ports 5173 and 4318. Reuse a healthy running
app, do not broad-kill processes, and leave the app reachable when finished.
Report the final URL and whether it was preserved, restarted, or started.

Manually check each tooltip type: model signal, provider timeline, effort day,
and project day.

1. Hover a point and scrub sideways. Content updates immediately with no lag,
   flicker, or chart hang.
2. Move onto the pin. The visible point freezes as the pin is entered.
3. Click to pin. The pinned card matches the frozen point.
4. Press and drag directly from the pin. Dragging begins on the first movement.
5. Leave the plot toward the card. The card remains visible and becomes
   interactive without a hide/show oscillation.
6. Pause over the retained card for longer than 400 ms, then leave. It dismisses
   after approximately 180 ms.
7. Leave away from the card. It dismisses after approximately 400 ms.
8. Move from card body to pin and back; neither transition dismisses the card.
9. Keep keyboard focus on the pin while moving the pointer away; it remains
   visible and frozen until focus also leaves.
10. Tab to the pin and activate it with Enter or Space.
11. Press Escape on an active tooltip and on a retained tooltip. Both disappear
    immediately; the active tooltip stays dismissed until Recharts moves to a
    new coordinate.
12. Move quickly between charts and confirm retained content does not intercept
    normal interaction in the next chart. Note that outside-pointer dismissal
    cannot retarget an event already received by an overlapping card, so this is
    a required regression check rather than a guaranteed consequence of the
    document listener.
13. Confirm the cursor highlight disappearing during grace is acceptable.
14. Change view and reload; pins and transient tooltip state clear.

## Repository requirements

- Use the available `frontend-design` skill before implementing the UI/CSS
  behavior.
- Preserve unrelated uncommitted changes in `src/App.tsx` and `src/styles.css`.
- Use `apply_patch` for source edits.
- Do not commit unless explicitly asked.
- Any proposed commit message must use Conventional Commits, for example:

```text
fix(charts): hold pinnable tooltips through hover exit
```
