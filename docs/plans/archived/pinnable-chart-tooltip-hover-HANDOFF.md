# Pinnable chart tooltip hover handoff

Continue work in `/Users/luis/htdocs/ai-usage-observatory`.

## Goal

Fix pinnable graph tooltips whose pin control is currently unreachable: when the pointer leaves the chart's active date/data point to move onto the tooltip, Recharts deactivates the tooltip and it disappears.

Implement a cancellable hover grace period:

- When Recharts reports the tooltip inactive, retain its last valid contents for about 400ms.
- Entering or focusing the tooltip card cancels dismissal.
- Leaving the card restarts a shorter dismissal timer, around 160–200ms.
- Pointer-down on the pin must remain immediate so pinning and dragging is reliable.
- Normal chart scrubbing should still update tooltip content immediately.
- Do not persist tooltip or pin state across reloads or app navigation.

## Existing implementation

Pinnable and draggable chart tooltips were already added. Current uncommitted files:

- `src/App.tsx`
- `src/styles.css`
- `src/chart-pins.ts`
- `src/chart-pins.test.ts`
- `src/components/chart-pins.tsx`

Existing behavior includes:

- In-memory pinned-tooltip state through `ChartPinProvider`.
- Pinned cards rendered in a portal.
- Newer pinned cards come to the front.
- The pin button doubles as a drag handle.
- Pointer-down immediately pins and begins drag tracking.
- Keyboard pin/unpin and arrow-key movement.
- Pins clear when the app view changes because `ChartPinProvider` is keyed by `view`.
- Pins naturally clear on reload.

The four pinnable tooltip components in `src/App.tsx` are:

- `ModelSignalTooltip`
- `ProviderChartTooltip`
- `EffortDayTooltip`
- `ProjectDayTooltip`

## Recommended implementation

Add a reusable hook to `src/components/chart-pins.tsx`, such as:

```ts
useChartTooltipGrace<T>(current: T | null)
```

It should:

- Store the last non-null tooltip snapshot in a ref.
- Return the current snapshot immediately while active.
- Retain the cached snapshot during the exit grace period.
- Cancel dismissal on card `pointerenter` or focus.
- Resume dismissal on `pointerleave` or when focus moves outside the card.
- Clean up pending timers on unmount.
- Return interaction props that can be spread onto the tooltip card.

Extend `PinnableChartTooltip` with an `interactionProps` prop and spread those handlers onto its root `<div>`.

Each tooltip component must cache everything it needs before Recharts clears the payload. For example:

- Model: `{ row, coordinate }`
- Provider: `{ payload, label, coordinate }`
- Effort: `{ point, label, coordinate }`
- Project: `{ row, coordinate }`

Call `useClampedTooltip` using the retained snapshot, not the raw `active` value.

Update CSS so the actual card can receive pointer events:

```css
.pinnable-chart-tooltip {
  pointer-events: auto;
}
```

Keep the Recharts tooltip wrapper itself non-interactive. A previous attempt to set the entire `.recharts-tooltip-wrapper` or `wrapperStyle` to `pointerEvents: "auto"` caused chart mouse-event feedback/hanging. Only the tooltip card should become interactive.

## Verification

Run:

```sh
bun run typecheck
bun test
bun run build
```

Then verify in the live app that:

1. Hover a chart point/date.
2. Move from the chart onto the tooltip.
3. The card stays visible.
4. Hover/focus the pin without rushing.
5. Click to pin.
6. Drag immediately from the pin.
7. Move away without pinning and confirm delayed dismissal.
8. Scrub across chart points and confirm immediate content updates.
9. Check all four tooltip types.
10. Confirm navigation/reload still clears pins.

The app was previously healthy on both `http://localhost:5173` and `http://localhost:4318`. Follow repository guidance: preserve the running server and report which URL remains available.

## Repository requirements

- Read and use `/Users/luis/.agents/skills/frontend-design/SKILL.md`; this task triggers that skill.
- Use `apply_patch` for edits.
- Do not overwrite unrelated user changes.
- Do not commit unless explicitly asked.
- Any proposed commit message must use Conventional Commit format, for example:

```text
fix(charts): keep pinnable tooltips reachable after hover exit
```
