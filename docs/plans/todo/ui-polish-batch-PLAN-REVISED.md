# UI Polish Batch — Revised Plan

**Status:** Reviewed; ready for execution
**Date:** 2026-07-31
**Reviewed:** 2026-08-02
**Baseline:** `main` @ `3386426`. The working tree already contains unrelated README and plan
archive changes; preserve them. This revised plan is a planning-only addition.
**Verification bar:** `bun run typecheck`, `bun test`, `bun run build`, plus a live check
of the Appearance modal (open/close, text-scale stepper), Headroom Orrery motion, Explorer
(empty-filter state), and the footer, at both desktop width and the ~620px breakpoint.

## Recommended executor

**Codex with `gpt-5.6-sol`, high reasoning, as one persistent agent.** GPT-5.6 Sol is the
flagship-capability model and current OpenAI guidance specifically notes stronger frontend layout,
visual hierarchy, and design judgment. High reasoning is appropriate here because the run combines
React state, canvas animation, CSS, data semantics, tests, and browser-based visual decisions.

- Keep one agent responsible for all slices so it retains the Appearance, Agent-filter, chart, and
  Headroom Orrery context and can preserve the shared running browser session.
- Do not parallelize implementation across agents: `src/App.tsx` and `src/styles.css` are shared by
  most slices, so concurrent edits would add conflict and inconsistent visual judgment.
- If an independent review is desired, run it only after the implementation and full verification
  pass, using a fresh `gpt-5.6-sol` high-reasoning context against the final diff and Definition of
  done.
- Use `gpt-5.6-terra` at high reasoning only as the lower-cost fallback; expect the Sol executor to
  be the safer choice for the motion and responsive-layout judgment in this batch.

Model-selection basis: [OpenAI's current GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model.md).

---

## Context for a cold pickup

Fourteen UI requests from the ongoing polish pass. Execute them as four slices, with verification
after each slice: Appearance and scene motion (§1-3 and §14), chrome/filter/launcher (§4-5 and
§8-12), Explorer charts and empty states (§6-7 and §13), then full regression. The
executor-facing sequence is included at the end of this revised plan.

The 2026-08-02 review resolved the formerly open implementation choices:

- §6 uses the existing `Empty` API (`text`, not `icon`/`message`) and describes only filters that
  actually narrow results. An empty Agent selection means **all agents**, never “none selected.”
- §7 uses existing dashboard rows for the Effort-by-day tooltip and the scoped `group=model`
  effort endpoint for Model signals. It does not add a provider×effort matrix or a new server API.
- §9 uses the existing provider color-dot language. No trademarked logo assets are added.
- §11 adds one App-level launcher/modal state. Existing page-local benchmark triggers remain
  unchanged.
- §12 builds on the already-visible `Other models` group rather than adding polling or
  quota-service work.
- §13 determines rendered providers from non-zero chart data. It does not thread selection state
  through three chart components or rely on `selectionProvider`, which intentionally becomes
  `null` for mixed selections.
- §14 renames the generic orbital art to **Headroom Orrery** and makes known headroom the semantic
  driver of satellite angular speed while retaining the user's global speed multiplier.

Key files:

| Area | File |
| --- | --- |
| Appearance modal + dismiss animation | `src/App.tsx:5349-5710` (`AppearanceModal`) |
| Dismiss animation keyframes | `src/styles.css:351` |
| Text-scale setting + token wiring | `src/App.tsx:5563-5591` (control), `src/App.tsx:6244-6269` (token wiring) |
| Design tokens | `src/styles.css:1-38` (`:root`) |
| Footer | `src/views/chrome.tsx:220-273` (`InformationSources`), CSS `src/styles.css:134` |
| Agent filter | `src/views/chrome.tsx:104-198` (`AgentFilter`), CSS `src/styles.css:96-127` |
| Agent filter selection logic | `src/agent-filter.ts` (`splitSelection`, `buildAgentTree`, `normalizeSelection`) |
| Explorer charts | `src/App.tsx:2757-2876` (`EffortByDay`), `src/App.tsx:3010-3068` (Model signals) |
| Empty-state component | `src/views/chrome.tsx:200-207` (`Empty`), CSS `src/styles.css:352` |
| Effort colors | `src/components/effort/index.tsx:8-31` (`effortColor`/`effortLabel`) |
| Provider colors | `src/App.tsx:427-431` (`providerSeries`), stored via `providerColorsStorageKey` (`App.tsx:184`) |
| Benchmarks modal + triggers | `src/App.tsx:6074-6153` (`BENCHMARK_SITES`, `BenchmarkTriggerIcons`, `BenchmarkModal`); trigger call sites `App.tsx:2332,2595-2601` (Overview) and `App.tsx:4694,4731-4735` (Models) |
| Model/provider naming inference | `src/model-family.ts:7-9` (`familyOf`), `src/provider.ts:7-23` (`providerFromAgent`/`providerFromModel`) |
| Quota-service adapter | `server/quota.ts` |
| Provider timeline charts | `src/App.tsx:1331-1537` (`ProviderTimeline`), `src/App.tsx:1563-1766` (`HourlyProviderTimeline`), `src/App.tsx:4285-4296` (`ProjectDetails` daily chart) |
| Global top-bar controls | `src/App.tsx:6622-6624` (`.global-controls`/`.global-filter--agent`), CSS `src/styles.css:96` |
| Headroom orbital art | `src/scene.tsx:190-434` (`RINGS`, `OrbitalScene`), CSS `src/styles.css:167-172` (`.orbital-viz`, `.orbit-legend`) |

---

## 1. Modal dismiss: lighten sooner, same total duration

**Current behavior** (`src/styles.css:351`): the darkening layer
(`.modal-backdrop--dismissing::before`, a radial-gradient scrim, darkest at center) is driven by
`animation: appearance-shade-out .429s 1.581s linear both`. It stays at full opacity for the
first 1.581s of the ~2.05s dismiss sequence (`window.setTimeout(onClose, 2050)`,
`src/App.tsx:5427`), then drops to 0 linearly over the last .429s. In other words: hold, then
snap-fade at the very end.

**Change:** start the fade much earlier and use a decelerating (ease-out) curve instead of
linear, while keeping the same overall ~2.05s dismiss budget:

- Move the delay from `1.581s` to roughly `0.3s–0.4s`.
- Extend the duration to roughly `1.4s–1.6s` so the layer still reaches `opacity:0` around the
  same overall completion point (~1.7s–1.9s, comfortably inside the 2.05s total).
- Swap `linear` for a decelerate curve — `cubic-bezier(0,0,.2,1)` (Material's "standard
  decelerate") or `ease-out`.

Why this reads the way the user wants: a decelerating curve drops opacity fastest right after it
starts, then slows to a long, shallow tail. Because the layer is a radial gradient (opacity
stops from `rgba(0,0,0,.9)` at center to `.5` at the edge), the shallow tail disproportionately
preserves the *center* — the edges have already faded to near-nothing by then, so the remaining
visible darkness concentrates on the focused middle of the screen. That's the "let the central
focused darker area carry more of the visibility burden in the latter part" effect the user
described, achieved without touching the gradient stops themselves.

Keep `appearance-blur-out` (the `backdrop-filter: blur` layer, currently `.572s .078s linear`)
roughly where it is, or nudge its delay down slightly to stay ahead of the shade fade — a blurred
background that's still fully dark reads as heavier than a blurred-but-lightening one. Re-check
by eye; don't reason about this one from the numbers alone.

**Do not** change the total 2050ms budget or the `appearance-message-cycle`/`appearance-modal-out`
timings — the request is specifically about *when the darkening starts to visibly lighten* within
the existing envelope, not about making the close feel faster or slower overall.

---

## 2. Save/cancel escape hatch (balance, not a mode change)

**Current behavior:** every Appearance modal control (`src/App.tsx:5477-5591`) writes straight to
`useState` setters in `App`, whose effects (`App.tsx:6190-6269`) immediately push the value to
`document.documentElement.style` and `localStorage`. There is no draft state — the modal's
`initial` ref (`App.tsx:5381-5387`) exists only to pick a dismissal message, not to gate
persistence. Dismissing the modal (Esc, backdrop click, close button) is purely a cosmetic
animation; every change is already saved before it plays.

**Decision:** keep this. Converting to an explicit-Save model would slow down the common case
(the user's own stated preference is "change-dismiss-applied"), and would require draft-state
plumbing through every control. Do not add a blocking Save/Cancel pair.

**Add instead — a visible, reversible trail:**

1. **Change counter, visible while the modal is open.** Compute a live count against
   `initial.current`. Count user-facing settings, not object identities: Accent (1), each provider
   color (up to 3), favorite-colors collection (1 when any slot differs), data-text scale (1),
   and each `SceneEffects` field (up to 6). Render `"No changes yet"`, `"1 change will apply when
   you close this"`, or `"N changes will apply when you close this"` near the bottom of the modal.
   Use the same count (`count > 0`) for dismissal-message selection so the modal has one definition
   of “changed.”
2. **A conditional revert action.** Next to that status line, when the diff is non-empty, show a
   text-style action — `"Revert changes"` — that resets every control back to the values captured
   in the `initial` ref and clears the diff, without closing the modal. This is the escape hatch:
   it costs nothing when there are no changes (it isn't even rendered), and costs one click when
   there are. No modal-blocking "Cancel" button, no second confirmation step, no change to what
   Esc/backdrop-click/✕ do.
3. Do **not** gate the revert action behind the dismiss animation or wire it into `dismiss()`.
   Restore values with the existing typed setters explicitly (including cloned arrays/objects),
   and leave the modal open. Also leave the existing “Reset appearance” action intact: **Revert**
   means “restore values from when this modal opened”; **Reset** means “restore product defaults.”

This gives the "count the changes, offer an out" shape the user asked for, without adding a
Cancel button that changes the meaning of the existing close gestures.

---

## 3. Text size scale: raise the ceiling, fix the components that don't scale

**Current range** (`src/App.tsx:5563-5591`): 90%–150% in steps of 10
(`Math.max(90, dataTextScale - 10)` / `Math.min(150, dataTextScale + 10)`).

**Change:** raise the max to **250%** (keep the 90% floor and the step of 10 — 17 steps total is
fine for a stepper). If 250% turns out to break layouts badly during the live check, fall back to
200% rather than adding intermediate logic; don't add a second step size for the upper range.

**The `--data-text-*` tokens already scale correctly** (`App.tsx:6244-6269`) — `--data-text-compact`
is `9 * scale`px, so anything using `var(--data-text-compact)` already grows with the setting.
The user's "should NOT stay 9px" complaint is about text that is *not* wired to that token at all:
literal `9px` scattered through `src/styles.css` as UI chrome, e.g.:

- `.brand-version` — `styles.css:58`
- `.agent-filter__group>.overline` — `styles.css:113`
- `.quota-card__head i` — `styles.css:198`
- `.quota-bucket__top span`, `.quota-bucket small` — `styles.css:213`
- `.banked-resets .reset-use` — `styles.css:216`
- `.project-detail__summary span` — `styles.css:300`
- `.measure-table thead th` — `styles.css:340`
- several Appearance-modal-internal rules (`.accent-control code`, `.signal-color-note`, the
  `.data-text-control output` labels) — `styles.css:351`

**Work:** audit the listed declarations and replace textual sizes that are part of dense data
display with `var(--data-text-compact)`. Do **not** run a global `9px` replacement: spacing,
dimensions, icon glyphs, brand chrome, and modal help text are outside the “Data text size”
setting. For each listed declaration, first classify it as data text or fixed chrome and record any
intentional fixed-size exception in the implementation summary. In particular, `.brand-version`
and Appearance-modal help copy should remain fixed chrome unless the live UI demonstrates they are
part of the reported defect. Two things to check per changed site:

- Some of these live in fixed-height chrome (badges, table header cells, quota card icons) where
  a 9px→22.5px jump at 250% will overflow or clip. Check each visually at 150%, 200%, and 250%.
  Where a literal size must stay fixed for layout reasons (e.g. an icon glyph size, not user
  text), leave it and note why in a one-line comment — don't silently skip it.
- `.measure-table thead th` and similar table headers may need `white-space` / column-width
  adjustments once the header text grows; check for wrapping/overlap, not just clipping.

Make this one audited pass, then verify at 90%, 150%, 200%, and 250%. The risk is visual; a clean
typecheck is not evidence that the sizing is acceptable.

---

## 4. Footer list: right-align labels to pair with their values

**Current** (`src/views/chrome.tsx:227-262`, CSS `src/styles.css:134`): `.information-sources ul
li` is `grid-template-columns:145px minmax(0,1fr)`, and the label (`ccusage` / `Local agent
records` / `quota-service`) has no explicit `text-align`, so it defaults left — it sits far from
its paired value in the second column, with a ragged gap between label and value across rows of
different label lengths.

**Change:** `text-align:right` on the label element (`.information-sources li>a,
.information-sources li>b`), so each label hugs the fixed `12px` gap before its value column,
visually pairing them regardless of label length.

**Watch:** at the ≤620px breakpoint (`styles.css:358`) the `li` already collapses to a single
column (label above value). Right-aligned text in a single-column stacked layout reads oddly —
reset to `text-align:left` inside that media query.

---

## 5. Design tokens for transitions/easing/spacing + footer link hover

There is currently **no token layer for motion** — every `transition:` in `src/styles.css` hardcodes
its own duration and curve inline (e.g. `.16s ease`, `.2s ease`, `.65s cubic-bezier(.4,0,.7,1)`),
and the footer links have **no transition at all** (`.information-sources a:hover{color:var(--accent)}`,
`styles.css:134` — color changes snap instantly on hover).

**Add to `:root`** (`src/styles.css:1-38`, alongside the existing color/radius/data-text tokens):

```css
--ease-standard: cubic-bezier(.4,0,.2,1);
--ease-decelerate: cubic-bezier(0,0,.2,1);   /* fast-in, long tail — also used by §1 */
--ease-accelerate: cubic-bezier(.4,0,1,1);
--duration-speedy: 140ms;   /* tags, toggles, row backgrounds — snappy micro-interactions */
--duration-base: 200ms;
--duration-slow: 300ms;     /* link color/underline hovers */
--link-underline-offset: 0.3em;  /* relative unit, per user's "slightly too much is better than too little" */
```

These are **values to reference, not a mandatory shared class.** Per the user's note — "it matter
more to me that the text hovers should be centrally manageable rather them be universal identical"
— each hover rule keeps its own selector and can mix tokens (e.g. one link-like element might use
`--duration-slow` with `--ease-standard`, another might only transition `color` while a third also
transitions `background`), but they all pull their numbers from this one place so a future
"make hovers snappier" edit is a token change, not a grep across the file.

**Footer links specifically** (`styles.css:134`):

```css
.information-sources a {
  transition: color var(--duration-slow) var(--ease-standard);
}
.information-sources a:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: var(--link-underline-offset);
}
```

This matches the request directly: transition only `color`, then add the spaced underline on
hover. Do not migrate unrelated hardcoded transitions or hover rules in this batch; the new tokens
can support that later without expanding this change's regression surface.

**Explicitly out of scope for the token system:** the Appearance modal's dismiss animation (§1) —
its `appearance-modal-out`, `appearance-message-cycle`, `appearance-blur-out`, `appearance-shade-out`
keyframes stay bespoke with their own literal timings, per the user's note that "the modal
dismissal has its own custom transition ideas that are unique." The one exception is
`--ease-decelerate`, which §1 can reference since it's the same curve shape either way.

---

## 6. Empty-filter state: templated "no data" message across widgets

**Current gap:** the Agent filter (`src/views/chrome.tsx:104-198`) has no awareness of how much
data its selection produces.

- `EffortByDay` (`App.tsx:2757-2876`) already guards on `drawable` and shows a plain-text
  `<p className="effort-empty">No attributable effort activity in this range.</p>`
  (`App.tsx:2869-2871`) — generic, not filter-aware.
- The Explorer's **Model signals** chart (`App.tsx:3010-3068`) has **no guard at all** — a filter
  combination that yields no model rows renders a blank chart (empty axes, no bars, no message).
- A richer, icon+text empty-state component already exists (`Empty`, `chrome.tsx:200-207`, CSS
  `styles.css:352`) and is used in four other places in the app, but not by either of these two
  charts.

**Work:**

1. Add a pure helper in `src/filter-summary.ts`, with focused tests, that accepts
   `AgentSelection`, `MetricRange`, and `pathTag`. Move/export the small `MetricRange` union from
   `App.tsx` into this module so the helper does not import `App.tsx`. It returns a complete sentence:
   `"No data matches Agent: claude + gpt-5.6-sol · Range: 30 days · Path: project-x."` Include
   only narrowing dimensions: omit Agent when `selection.length === 0` (that state means all),
   omit Range for `all`, and omit Path for `all`. If nothing narrows, return a generic
   `"No data is available for this widget."`
2. Use the existing component contract, `<Empty text={...} />`. Do not invent `icon` or `message`
   props.
3. Pass the computed sentence to `EffortByDay`. Only its `drawable === false` branch changes;
   the `EffortState` not-indexed/disabled/error states remain authoritative and unchanged.
4. Guard Model signals before constructing `ResponsiveContainer`. When `modelData.length === 0`,
   render `<Empty text={...} />` instead of the empty chart shell.

This establishes a reusable helper, but converting other widgets is out of scope for this batch.

---

## 7. Cross-reference model info in Effort by day, and effort info in Model signals

**Current split:**

- `EffortByDay` colors stacked bars by **effort level**, with fixed colors
  (`effortColor` in `src/components/effort/index.tsx:8-31`: `low/medium/high/xhigh` mapped to
  `--aqua/--accent/--orange/--violet`, unrelated to provider). Its tooltip
  (`EffortDayTooltip`, `App.tsx:2878-2925`) shows date/provider/coverage/per-level totals — no
  per-model breakdown; `EffortDayPoint` (`src/effort-model.ts:107-114`) doesn't carry one.
- **Model signals** colors bars by **provider**, using the user's configurable provider colors
  from the Appearance modal (`providerSeries`, `App.tsx:427-431`, resolving `--anthropic-color` /
  `--openai-color` / `--warp-color`). Its tooltip (generic `ChartTooltip`, `App.tsx:642-665`)
  shows model name + metric value — no effort info at all.

**Resolved approach:** preserve each chart's existing primary encoding and add the cross-reference
through existing data plus tooltips. Do not build a provider×effort matrix, add a server endpoint,
or add a decorative strip that changes the plotted totals.

1. **Model signals effort data:** in `Explorer`, request `useEffortAggregate("model",
   globalEffortScope(agent, metricRange, pathTag))`. Join its rows to `modelDistribution` by the
   raw `modelName`; keep a separate display label so stripping `claude-`/`gpt-` does not break the
   join. If effort data is loading, disabled, unavailable, or has no exact row, render the current
   provider color and current tooltip behavior—usage charts must not depend on the derived index.
2. **Model signals color family:** for models with a dominant effort value, use a small helper that
   returns CSS `color-mix(in oklch, ...)` expressions based on the existing provider CSS variable.
   This preserves live Appearance-modal colors and avoids parsing `var(--openai-color)` as hex.
   Keep `medium` at the base color; mix `low` modestly toward white and `high`/`xhigh` progressively
   toward black. Unknown/future effort values use the base provider color. Verify SVG rendering in
   the supported browser before keeping this cue.
3. **Model signals tooltip:** introduce a chart-specific tooltip that retains model/metric output
   and adds dominant effort, token coverage, and non-zero effort-level shares from the joined
   `EffortSummary`. Text carries every meaning also conveyed by shade.
4. **Effort-by-day model context:** pass the already-filtered `rows` into `EffortByDay`. Build a
   view-only lookup by day from each row's `agents` and `modelBreakdowns`; do not add fields to the
   shared `EffortDayPoint` type. Extend `EffortDayTooltip` with the day's provider totals and top
   three models by tokens (plus an “N more” line). Keep the effort stack colors and geometry
   unchanged.
5. Keep failures isolated: the existing usage rows still render when the effort request fails,
   and the effort chart still renders when model breakdowns are absent.

---

## 8. Agent filter summary: count individual models, not top-level entries

**Current bug** (`src/views/chrome.tsx:142-146`): the summary string counts `selection.length`,
i.e. the number of stored `AgentEntry` items — and a fully-checked agent is deliberately stored
as a single collapsed `agent:claude` entry, not its expanded model list (`normalizeSelection`,
`src/agent-filter.ts:70-81`, by design — see that function's doc comment: the collapsed form
still matches sessions whose model breakdown is missing/unrecognized, which the expanded list
can't). So checking both `agent:claude` and `agent:codex` yields `selection.length === 2`, and
the button reads `"2 selected"` even though every individual model family (~15 at present,
across both providers — this number is not hardcoded anywhere, it's however many distinct
families exist in the currently loaded dataset) is checked.

**Fix:** count checked *leaf* models instead of stored entries. `AgentFilter` already receives
`groups: AgentFilterGroup[]` where each `group.options[]` carries a `checked` boolean per model
(chrome.tsx:182-190, `option.checked` — already correctly reflects the collapsed-parent case via
whatever computed it upstream, since the tri-state checkbox rendering already relies on it).
Replace the count in the `summary` computation (chrome.tsx:142-146):

```ts
const modelCount = groups.reduce((sum, group) => sum + group.options.filter((o) => o.checked).length, 0);
const summary = selection.length === 0
  ? "All agents"
  : selection.length === 1
    ? labelFor(selection[0]) ?? "1 selected"
    : `${modelCount} selected`;
```

This only changes the multi-selection branch — `"All agents"` (nothing checked) and the
single-entry label branch are untouched. No change needed in `src/agent-filter.ts`; this is
purely a `chrome.tsx` display fix, reusing state the component already has.

---

## 9. Popover text color + provider marks in the summary area

**Text color.** There are three related text nodes, not two — worth being precise about which is
which before editing:

| # | What | Location | Current color |
| --- | --- | --- | --- |
| (a) | Menu-head summary, left of Clear | `chrome.tsx:162-166`, CSS `styles.css:108` (`.agent-filter__menu-head>span`) | `var(--dim)` |
| (b) | Trigger button summary (closed pill) | `chrome.tsx:150-157`, CSS `styles.css:103,105` (`.agent-filter__button`) | `var(--text)` — already the lighter one |
| (c) | Static "AGENT" label outside the popover | `App.tsx:6622-6624`, CSS `styles.css:98` | `var(--dim)` |

"The summary shown next to the AGENT label" is (b) — the trigger button's own summary text sits
inside the labeled `.global-filter--agent` group and is already `var(--text)` (the light tier).
(a) is the one that needs to change to match it. Edit `styles.css:108`:

```diff
-.agent-filter__menu-head>span{color:var(--dim);font:10px var(--font-label);...}
+.agent-filter__menu-head>span{color:var(--text);font:10px var(--font-label);...}
```

Leave (c) — the "AGENT" label itself — alone; it's a field label, not a summary, and dimming
labels relative to their values is the same convention the footer uses (§4).

**Provider marks in the summary area.** No local provider logo/favicon assets exist anywhere in
the repo today — providers are represented only as CSS color swatches
(`--anthropic-color`/`--openai-color`/`--warp-color`, `styles.css:20-22`, used as small `<i>` dots
in `.provider-legend`/`.quota-marker-legend`). The only real `<img>` favicons in the app are
external benchmark-site icons (see §11) — those aren't provider marks.

**Decision:** use the existing color-swatch convention; do not source provider logos. Extend
`AgentFilterGroup` with an optional summary color. `App.tsx` resolves each parent group through
`providerFromAgent` and the existing `providerSeries` constant (there is no `PROVIDERS` constant).
In `AgentFilter`, render a compact, deduplicated dot set before the trigger summary:

- empty selection (“All agents”): every parent-group provider color;
- narrowed selection: colors only for parent groups with at least one checked child;
- unparented-only selection: no guessed provider color.

Give the dot set an `aria-hidden="true"`; the adjacent text remains the accessible carrier. Apply
the dots to the trigger only, not the menu-head, to avoid duplicate decoration and extra width.

---

## 10. Trigger button and open panel: reduce excess width

**Trigger button** (`.agent-filter__button`, `styles.css:103`): `padding:0 9px 0 0` reserves 9px
of dead space to the right of the summary text, on top of the chevron icon's own 13px width + 6px
gap — this is the "extra negative space" the request points at. Reduce the right padding to hug
the chevron more closely, e.g. `padding:0 4px 0 0` (test 2-6px by eye; don't go to 0, the chevron
needs a hair of breathing room from the container edge). Also re-check `min-width:132px` while
here — it may itself be forcing width beyond what the current (now-shorter, post-§8) summary text
needs; if the button visibly has slack at `min-width` with typical selections, lower it or drop
it in favor of natural content sizing (`display:flex` already handles width via content + padding
without it).

**Open panel** (`.agent-filter__menu`, `styles.css:106`): fixed `width:268px`. Reduce by 10-13%,
i.e. to roughly **234px-241px** — pick a round number, e.g. `236px`. This is a plain fixed-width
edit, no layout logic depends on the exact number. **Check after the edit:** the child model
checkbox rows (`.agent-filter__child`, indented under a parent) have the longest label text in
the popover — confirm at the new width that model family names don't wrap or get clipped/ellipsed
awkwardly, especially for longer family names. If any do, either accept slightly less than the
full 13% reduction or revisit `.agent-filter__child` padding, but don't change the panel's
`max-height`/positioning rules (`top:calc(100% + 7px);right:0`) — those are unrelated to width.

---

## 11. Split-pill launcher for the benchmarks modal

**Current triggers** (two separate, unlinked ones): an icon-only button in Overview's Agent Mix
panel (`App.tsx:2595-2601`, shows both favicons via `<BenchmarkTriggerIcons/>` but always opens
to the default `"deepswe"` tab), and a labeled `.secondary-button` in the Models page
(`App.tsx:4731-4735`). `BenchmarkModal` (`App.tsx:6101-6153`) is a single-pane, tab-switched
modal — `siteId` state defaults to `"deepswe"` (`App.tsx:6103`) and there is no way today to open
it pre-selected to the other site.

**Good news:** the favicons this request wants are already in hand — `BENCHMARK_SITES`
(`App.tsx:6074-6089`) already carries `favicon: "https://deepswe.datacurve.ai/favicon.ico"` and
`"https://artificialanalysis.ai/favicon.ico"`, fetched live and already rendered elsewhere via
`BenchmarkTriggerIcons` (`App.tsx:6091-6099`). No new asset sourcing needed for this item (unlike
§9's provider marks, which have no existing source).

**Work:**

1. **Thread an initial tab through the modal.** Add an `initialSiteId?: (typeof
   BENCHMARK_SITES)[number]["id"]` prop to `BenchmarkModal`, and seed the `siteId` state
   (`App.tsx:6103`) from it: `useState(initialSiteId ?? "deepswe")`.
2. **New `BenchmarkSplitLauncher` component**, near `BenchmarkTriggerIcons`
   (`App.tsx:6091-6099`): a small two-segment pill, one half per `BENCHMARK_SITES` entry, each
   half rendering just that entry's favicon (~16-18px) as its button art, each with its own
   `onClick` that opens the modal with that entry's `id` as `initialSiteId`. This is the "deep
   link to the side clicked" behavior — clicking the DeepSWE half opens straight to the DeepSWE
   tab, clicking the Artificial Analysis half opens straight to that one.
3. **App-level state for the new launcher only:** add
   `useState<BenchmarkSiteId | null>(null)` in `App`, render its `BenchmarkModal` once alongside
   the other top-level modals, and have the split launcher set the clicked site id. Do not lift or
   rewrite the two page-local boolean states; their current default-tab behavior remains intact.
4. **Placement — confirmed: the top bar, next to the Agent filter when that filter is present.**
   Put the launcher outside the existing `view !== "models"` conditional so it remains reachable
   on Models and Projects too; DOM adjacency may differ on pages where the Agent filter is hidden.
   Leave both existing page triggers unchanged. Match the 35px global-control height.
5. **CSS and accessibility**: new `.benchmark-split-pill` rule — a rounded-pill flex container with two `<button>`
   children, a hairline divider between halves (reuse `--line`/`--line-bright`), each button sized
   to just its favicon plus a few px of padding, with a per-half hover state (background tint on
   the hovered half only, not the whole pill) so it's clear the two halves are independently
   clickable. Each button gets an explicit accessible label (`Open DeepSWE benchmark`, etc.); the
   favicon remains decorative. Verify the control at ~620px where `.global-controls` wraps the
   available top-bar width.

---

## 12. Process for detecting new Claude/Codex model releases — does it need quota-service?

**Finding: model/provider detection is already fully automatic on the client, with zero catalog
to maintain.** There is no hardcoded list of model names anywhere in this repo:

- `familyOf()` (`src/model-family.ts:7-9`) strips a trailing datestamp or `latest` suffix via
  regex — any new model name is grouped into its own family automatically as long as it follows
  the existing datestamp-suffix convention.
- `providerFromAgent()`/`providerFromModel()` (`src/provider.ts:7-23`) infer provider from
  substring/prefix matching (`claude`/`anthropic` → anthropic, `codex`/`openai` or a
  `gpt|o\d|text-|davinci` prefix → codex), not an enumerated list.
- `buildAgentTree` (`src/agent-filter.ts:32-44`) builds its groups from whatever agents/families
  are actually present in the loaded session data at runtime — there's no static catalog file to
  update when a new model ships.
- No local pricing table exists either — cost comes straight from ccusage, so a new model's cost
  data doesn't need a local update.

**A new Claude or Codex model release "just works" today**, provided its raw name follows the
existing naming conventions. A model whose name doesn't contain a recognizable vendor
substring/prefix falls into `AgentTree.unparented` (`src/agent-filter.ts:28,34-42`) — it still
works as a standalone filterable model and appears under `Other models`, but the UI does not yet
explain why it was placed there.

**Does this need quota-service?** No. `quota-service` (a separate sibling project, adapter at
`server/quota.ts`) is queried only via generic `/usage`, `/resets`, `/status` endpoints scoped by
`provider` (`"anthropic"`/`"codex"`) and `window` (`"fiveHour"`/`"weekly"`) — it has no concept of
individual model names at all, and per `docs/ARCHITECTURE.md:59` explicitly does not supply
analytical cost. A new model release doesn't change what this app asks quota-service for, so
there's nothing to prepare there. **Do not scope quota-service work into this item** unless a
future request specifically wants model-level (not just provider-level) quota granularity, which
quota-service doesn't support today regardless of how new the model is.

**Process and deliverable:** the popover already renders `agentTree.unparented` as `Other models`,
so detection is not silent. Keep that group and add one muted explanatory line beneath its heading:
`"Provider not recognized; model remains filterable."` Include the count in the heading when
non-zero (`"Other models (N)"`). Do not expose an internal filename in user-facing copy.

When this group appears, the maintainer action is to add the new naming convention to
`providerFromModel`/`providerFromAgent` and add a focused test in `src/agent-filter.test.ts` or a
provider test file. No scheduled job, release-note scraper, external polling, or quota-service
change is in scope.

---

## 13. Filtered-out providers still show a colored line in the timeline chart

**Bug:** `ProviderTimeline` (`App.tsx:1331-1537`, mounted on Overview at `App.tsx:2528-2533` and
Explorer at `App.tsx:3009-3014`) stacks one Recharts `<Area>` per provider by mapping
`stackedProviderSeries` unconditionally (`App.tsx:1514-1531`) — it does not check the Agent
filter at all when deciding *which* areas to render, only when computing their values. The
underlying data is already correct: `daily`/`rows` are pre-filtered via `selectAgentRow`
(`src/agent-filter.ts:148-186`, wired at `App.tsx:6445-6453`), so a filtered-out provider's value
is `0` at every point, not stale data. But Recharts still paints that `<Area>`'s
`stroke={provider.color}` (1.8px, full provider color, e.g. `var(--openai-color)`) along the
zero-height top edge of the stack — which lands directly on the boundary of the remaining active
provider's area beneath it, reading as a live line for a provider that's supposed to be hidden.
This is the "color coded lines... the color confuses the display" problem: a Codex line can
appear to still be present, in full Codex color, purely because Codex is currently *not*
selected and therefore contributes nothing but a zero-baseline.

**Fix — derive renderable series from the chart data, not selection representation.** After each
chart computes provider totals, define its visible series as providers whose total is greater than
zero. This is both simpler and more correct than threading `AgentSelection`: it handles parent,
model-only, mixed-provider, date, and path filters after their data has already been resolved.

- In `ProviderTimeline`, use the same non-zero list for legend items, `<defs>` gradients, axis tick
  provider labels, and `<Area>` elements. Reverse that filtered list only where stack paint order
  requires it. A provider with no values must contribute no SVG stroke.
- In `HourlyProviderTimeline`, use its non-zero totals for legend items and `<Bar>` elements.
- In `ProjectDetails`, `projectProviderSeries` already computes and filters non-zero totals; render
  bars from its reversed order instead of the unconditional `stackedProviderSeries`.
- Preserve `activeProvider` solely for quota-marker behavior. Do not change
  `selectionProvider` or `agentSelectionParams` for this bug.

If every provider total is zero in `ProviderTimeline` or `HourlyProviderTimeline`, render the
appropriate empty state rather than an empty legend and zero-series chart. `ProjectDetails` may
still have unattributed tokens or run counts; keep that chart and omit only its zero-value provider
series.

---

## 14. Headroom Orrery: more headroom means faster satellite motion

**Naming decision:** rename the code-facing concept from the generic `OrbitalScene` / `.orbital-viz`
to **Headroom Orrery**: `HeadroomOrrery`, `.headroom-orrery`, and
`.headroom-orrery__legend`. An orrery is an orbital model, and “headroom” states what this one
communicates. Keep `Starfield`, the shared camera, and unrelated `.brand-orbit` names unchanged.

**Current behavior:** the user's Appearance speed setting already scales the shared scene `clock`
in `stepScene`. Each satellite then uses a fixed provider-specific rate from `RINGS`:
`angle = ring.phase + clock * ring.speed * ring.dir`. Headroom affects ring opacity, satellite
size, pulse, and trail length, but not motion. Consequently a nearly exhausted provider can move
faster than a provider with abundant headroom solely because its fixed `ring.speed` is higher.

**Change:** known headroom must monotonically control angular speed across providers, while the
user setting remains the global multiplier.

1. Add a pure, exported helper near the scene code, e.g.
   `headroomOrbitRate(percent: number | null): number`. Clamp known values to 0-100 and map them
   through a smooth monotonic curve:

   ```ts
   const normalized = clamp(percent / 100, 0, 1);
   const eased = normalized * normalized * (3 - 2 * normalized); // smoothstep
   return MIN_ORBIT_RATE + (MAX_ORBIT_RATE - MIN_ORBIT_RATE) * eased;
   ```

   Start with `MIN_ORBIT_RATE = 0.22` and `MAX_ORBIT_RATE = 0.62`, which brackets the current
   `0.29-0.50` rates without making either extreme static or frantic. Unknown headroom uses a
   neutral `0.36` rate; it must not be interpreted as zero/exhausted. A stale but known reading
   uses its last known percent-derived rate and retains the existing stale dimming.
2. Remove provider-specific `speed` from `RINGS`; keep radius, tilt, direction, and phase as the
   providers' visual distinctions. Equal known headroom should produce equal angular velocity,
   and any higher known percent should move faster than any lower known percent regardless of
   provider.
3. Integrate a persistent angle per provider using the delta of the already speed-scaled shared
   `clock`. Do **not** substitute a dynamic rate into `ring.phase + clock * rate`: when quota data
   refreshes and the rate changes, that absolute formula can teleport the satellite. Rate changes
   affect subsequent motion only; the current position remains continuous.
4. Preserve the existing interaction contract: the Appearance speed setting multiplies every
   satellite's motion; direct drag remains 1:1; reduced-motion stops ambient orbital motion; and
   headroom continues to control satellite size/trail/opacity as it does today.
5. Rename the component and CSS selectors in the same contained edit, including responsive rules.
   No user-visible title or explanatory copy is required; the legend already identifies the
   visualization's data.

**Tests:** add focused unit coverage for clamping, unknown neutrality, endpoints, and strict
ordering across representative known values (`0 < 25 < 50 < 75 < 100`). The browser check must
also exercise a live headroom update and confirm there is no positional jump.

---

## Risks / watch-items

- §1 and §3 are the two items with real visual risk — a slower-but-earlier fade can look janky if
  it desyncs from the blur/message layers, and 250% text can overflow fixed-size chrome. Budget
  time for the live check on both, don't ship on CSS reasoning alone.
- §5's token introduction touches `:root`, which is also mutated at runtime for accent/provider
  colors and the data-text scale (`App.tsx:6190-6269`) — adding static tokens alongside those is
  fine (they're never overwritten by JS), just don't name a new token the same as anything JS
  sets via `setProperty`.
- §7 joins two sources with different failure modes. Match on the raw model name, never the
  shortened chart label, and preserve the current provider color/tooltip when the derived effort
  index is unavailable. Verify that `color-mix(in oklch, ...)` renders when used as an SVG fill;
  fall back to the base provider color if it does not.
- §9's "provider favicons" and §11's benchmark favicons are **not the same asset question** —
  don't let one implementation answer the other. §11's favicons already exist (external benchmark
  site icons, already fetched today). §9's do not exist for Anthropic/OpenAI/Warp and default to
  the color-dot fallback unless real logo assets are separately sourced.
- §13 must use non-zero chart totals, not `activeProvider` or a reconstructed provider selection.
  The filtered rows are the source of truth, and `activeProvider` intentionally cannot represent a
  mixed selection.
- §8 and §9 both read `group.options` state that already exists for tri-state checkboxes. Do not
  add a second flattened selection store.
- §14's dynamic rate must be integrated from delta time. Multiplying the long-running absolute
  `clock` by a changing rate will visibly jump the satellite on every quota refresh. Unknown data
  remains neutral, and reduced motion remains motionless.

## Definition of done

- [ ] §1: darkening layer visibly begins lightening well before the old 1.581s mark; total dismiss
      duration unchanged (~2.05s); center reads darker than edges through the tail of the fade.
- [ ] §2: modal shows a live, non-blocking change count; a "Revert changes" action appears only
      when the diff is non-empty and correctly restores `initial` values without closing.
- [ ] §3: text-scale stepper reaches 250% (or 200% if 250% proves unworkable); every audited data
      text site scales with it, while fixed chrome exceptions are recorded.
- [ ] §4: footer labels right-align against their values at desktop width; single-column mobile
      layout resets to left-align.
- [ ] §5: `:root` motion tokens exist; footer links have a `.3s` color transition and a spaced
      underline on hover.
- [ ] §6: Model signals shows the `Empty` component with a templated filter summary when the
      selection yields no data; Effort by day's filter-caused empty state does too, without
      touching its other (not-indexed/disabled/error) states.
- [ ] §7: Model signals joins scoped model effort by raw model name, shades only rows with known
      dominant effort, and exposes textual effort detail; Effort by day adds provider/top-model
      tooltip context without changing its stack geometry; either chart survives missing effort
      or model-breakdown data.
- [ ] §8: checking both provider parents (all models) reads as the real per-model count (e.g.
      "~15 selected"), not "2 selected"; single-selection and empty-selection labels unchanged.
- [ ] §9: menu-head summary text matches the trigger button's lighter color; trigger dots reflect
      all providers, narrowed providers, and unparented-only selections without guessing.
- [ ] §10: trigger button hugs its text/chevron with no dead right-side padding; open panel is
      10-13% narrower with no clipped/wrapped model labels at the new width.
- [ ] §11: a split-pill launcher sits in the top bar next to the Agent filter; each half deep-links
      to its own benchmark tab via a real `initialSiteId` prop, not just opening the default tab.
- [ ] §12: `Other models (N)` explains that unrecognized models remain filterable; no
      quota-service, polling, or release-scraping work is added.
- [ ] §13: every provider chart renders only non-zero provider series in its marks and legend;
      `ProviderTimeline` has no stray stroke, and all-zero data produces an empty state.
- [ ] §14: `HeadroomOrrery` replaces the generic component/class names; for known readings, higher
      headroom always produces higher angular speed; user speed still scales all satellites;
      unknown is neutral, reduced motion is still, and headroom refreshes do not jump position.
- [ ] `bun run typecheck` clean, `bun test` green, `bun run build` succeeds.
- [ ] Live check: Appearance modal open/close + revert, text-scale stepper at 90/150/200/250%,
      Headroom Orrery speed ordering and refresh continuity, Explorer with a filter combination
      that yields no rows, footer at desktop and ~620px widths, Agent filter trigger/panel widths,
      benchmark split-pill deep links, and provider timeline with one/two providers filtered out.

---

# Execution run plan

## Executor rules

- Read `AGENTS.md`, inspect `git status --short`, and preserve every pre-existing change. The
  README edit and plan archive moves observed at review time are unrelated.
- Before touching a server, check `http://127.0.0.1:5173` and `http://127.0.0.1:4318`. Reuse a
  healthy app; do not restart it for client hot-reload changes. Leave the app reachable at the end.
- Use the current code as the authority when line numbers drift. Search symbols with `rg`.
- Do not commit unless explicitly asked. If asked, verify git identity first and use Conventional
  Commit messages.
- Do not expand optional cleanup. Touch only files required by this revised plan and tests.
- Keep accessibility semantics: visible focus, text alternatives for color, explicit labels for
  icon-only buttons, and reduced-motion behavior.

## Slice 0 — Baseline and test inventory

1. Record `git status --short`, current commit, and which app port is healthy.
2. Run the baseline commands:

   ```sh
   bun run typecheck
   bun test
   bun run build
   ```

3. Locate the current implementations by symbol, not recorded line number:
   `AppearanceModal`, `AgentFilter`, `InformationSources`, `Explorer`, `EffortByDay`,
   `ProviderTimeline`, `HourlyProviderTimeline`, `ProjectDetails`, `BenchmarkModal`, and
   `.global-controls`.

Stop if a baseline command fails for a reason unrelated to the requested work. Report the exact
failure instead of folding an unrelated repair into this batch.

## Slice 1 — Appearance and Headroom Orrery (§1-3, §14)

### Implement

1. Add the motion tokens required by §5 first only if §1 references `--ease-decelerate`; otherwise
   keep the broader token/footer edit in Slice 2.
2. Retune only `appearance-shade-out` timing/curve. Preserve the 2050ms close timer and the modal,
   message, and total-dismiss durations.
3. Add one live appearance diff calculation with the counting rules in §2. Reuse it for status,
   conditional Revert, and dismissal-message selection.
4. Revert explicitly restores the modal-open snapshot through typed setters and does not close the
   modal. Keep Reset appearance as a separate defaults action.
5. Raise the data-text stepper maximum to 250%. Audit the listed 9px declarations; convert only
   dense data text. Do not globally replace `9px`.
6. Rename `OrbitalScene` / `.orbital-viz` / `.orbit-legend` to the Headroom Orrery names from
   §14, including responsive selectors.
7. Add and test the monotonic headroom-to-orbit-rate helper. Replace provider-fixed rates with
   per-provider angles integrated from delta shared-clock time; do not multiply the absolute clock
   by a rate that can change when quota data refreshes.

### Automated gate

- Add focused tests for extracted diff/count logic if it is moved to a pure helper. Do not create
  a helper solely to satisfy a test count.
- Test the headroom orbit mapping for clamping, unknown neutrality, endpoints, and strict ordering
  across representative known percentages.
- Run `bun run typecheck` and the relevant tests, then `bun test`.

### Browser gate

- Open Appearance; verify no-change, singular-change, multi-change, Revert, Reset, Esc, backdrop,
  and close-button behavior.
- Confirm the shade visibly starts lightening before the old 1.581s point while the close still
  completes at roughly 2.05s.
- Check 90%, 150%, 200%, and 250% at desktop and ~620px. Inspect wrapping, clipping, horizontal
  page overflow, and modal reachability. Attempt 250% before considering the documented 200%
  fallback; if fallback is necessary, record the exact broken layouts.
- Observe satellites with deliberately different known headroom values: higher must rotate faster
  regardless of provider/ring, while the user speed control scales all of them. Verify unknown is
  neutral, reduced motion stops them, dragging stays 1:1, and a headroom refresh changes velocity
  without jumping position.

Do not continue until the app is still usable at the chosen maximum, Revert restores every counted
setting, and the Headroom Orrery satisfies the semantic motion rule without discontinuities.

## Slice 2 — Footer, global controls, and model-release signal (§4-5, §8-12)

### Implement

1. Right-align footer labels on desktop and reset them to left alignment in the existing ≤620px
   media query.
2. Add the scoped motion/link tokens and footer-link hover from §5. Do not migrate unrelated
   transitions.
3. In `AgentFilter`, count checked leaf options for the multi-entry summary. Preserve “All agents”
   and the single-entry label behavior.
4. Set the menu-head summary to `var(--text)`. Add provider summary colors to group data and render
   the deduplicated trigger dots exactly as §9 specifies.
5. Reduce trigger padding/min-width only as far as content allows; reduce the menu toward 236px,
   backing off if real model labels clip or wrap.
6. Enhance the existing `Other models` group with its count and explanatory copy. Do not add
   polling, quota-service work, or internal filenames to the UI.
7. Add `BenchmarkSiteId`, `initialSiteId`, the two-button split launcher, and one App-level
   modal state. Place the launcher outside the Models conditional. Leave both existing page-local
   benchmark triggers unchanged.

### Automated gate

- Add or update focused Agent filter/provider-mapping tests for any extracted pure behavior.
- Run `bun run typecheck`, `bun test`, and `bun run build`.

### Browser gate

- Agent summary: all agents; one parent; one model; both parents; partial parent; unparented-only.
- Confirm trigger dots match those states and are not the sole accessible label.
- Open the narrowed popover and inspect the longest real model family names.
- Check the footer and top bar at desktop, ~900px, and ~620px.
- Click each benchmark half from at least two views, including Models; verify the requested initial
  tab, focus trap, Esc, close button, and return focus. Confirm existing triggers still work.

## Slice 3 — Explorer empty states and chart context (§6-7, §13)

### Implement

1. Add and test the pure filter-summary helper; move the `MetricRange` union out of `App.tsx` so
   the helper does not import the application component. Remember: `AgentSelection=[]` means all.
2. Guard Model signals and the all-zero timeline/hourly charts with `<Empty text={...} />` before
   creating empty Recharts shells. Preserve `EffortState`'s disabled/indexing/error branches.
3. Derive non-zero provider series from computed totals in each chart. Use the same list for marks,
   legends, gradients, and tick metadata. Keep `activeProvider` only for quota markers. In Project
   detail, retain the chart when unattributed tokens or run counts remain.
4. Add the scoped model-effort request in Explorer and join by raw model name. Keep display labels
   separate. Missing or failed effort data must leave the usage chart functional.
5. Add effort-aware Model signals shading via CSS `color-mix(in oklch, ...)` only after confirming
   it renders in SVG. Add textual effort details in the chart-specific tooltip.
6. Pass filtered usage rows to `EffortByDay`; build a view-only day lookup and add provider/top-model
   context to its tooltip. Do not change `EffortDayPoint`, stack geometry, or server APIs.

### Automated gate

- Test filter-summary output for all/all, agent-only, model-only, mixed, range-only, path-only, and
  combined filters.
- Test any pure series-visibility or effort-color helper if extracted.
- Run `bun run typecheck`, `bun test`, and `bun run build`.

### Browser gate

- Create a filter combination with no matching rows; verify complete, truthful empty text and no
  blank axes.
- Filter to Claude only, Codex only, a model-only selection, and a mixed selection. Confirm no
  zero-value provider stroke, bar, gradient, or legend item remains.
- Exercise daily and 1-day/hourly Explorer modes plus an expanded Project detail chart.
- Verify Model signals with effort enabled and disabled/unavailable. The base provider chart must
  remain usable in both states.
- Inspect both updated tooltips with keyboard/pointer interaction and confirm color is duplicated by
  text.

## Slice 4 — Full regression and handoff

1. Run:

   ```sh
   bun run typecheck
   bun test
   bun run build
   ```

2. Repeat this revised plan's complete Definition of done. Check the browser console and document
   overflow at desktop and ~620px.
3. Review `git diff --check`, `git diff --stat`, and the actual diff. Remove only artifacts created
   by this run. Do not clean unrelated files.
4. Confirm the previously healthy local app is still reachable. If prior work left it stopped,
   start `bun run dev` and leave it running.
5. Report:
   - files changed and behavior delivered by slice;
   - exact test/build results;
   - browser widths and scenarios checked;
   - whether 250% was retained or why 200% was required;
   - any intentional fixed-size text exceptions;
   - Headroom Orrery rates/scenarios checked, including refresh continuity;
   - final local URL and whether the server was preserved, restarted, or started;
   - unrelated working-tree changes that were preserved.

If commits are explicitly requested, suitable Conventional Commit drafts are:

- `feat(ui): refine appearance controls and text scaling`
- `feat(ui): polish global filters and benchmark launcher`
- `feat(explorer): improve filtered chart context`
