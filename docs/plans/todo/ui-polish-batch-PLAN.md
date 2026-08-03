# UI Polish Batch — Plan

**Status:** Not started
**Date:** 2026-07-31
**Baseline:** `main` @ `62ecfb2`, working tree has an uncommitted `README.md` edit unrelated
to this plan.
**Verification bar:** `bun x tsc --noEmit -p .`, `bun test`, `bun run build`, plus a live check
of the Appearance modal (open/close, text-scale slider), Explorer (empty-filter state), and the
footer, at both desktop width and the ~620px breakpoint.

---

## Context for a cold pickup

Thirteen independent UI requests from three conversations (§1-7 from the first pass, §8-12 added
after a follow-up, §13 and the placement update in §11 added after a second follow-up). Ordered
roughly by independence — **1, 3, 4, 5, 6, 8, 9, 10 and 13 can each ship alone.** 2 (save/cancel
escape hatch) touches the same modal as 1, so do them in the same pass to avoid two rounds of
conflict in `AppearanceModal`. §9 and §10 both touch `.agent-filter__*` CSS and can reasonably
ship together with §8, since all three are the same component. §11's launcher sits in
`.global-controls` next to the Agent filter (confirmed placement — not inside any panel), which
puts it visually adjacent to §8-10's work without sharing code; fine to build independently, just
expect the two to land near each other in `App.tsx`'s top-bar JSX. §13 is self-contained to the
`ProviderTimeline`/`HourlyProviderTimeline`/`ProjectDetails` chart components and doesn't overlap
with anything else in this plan. 7 and 12 are the most open-ended items and are written as
recommended directions, not locked specs — read their "Decision needed" notes before starting.

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

1. **Change counter, visible while the modal is open.** Reuse the `initial` vs. current
   comparison that already exists for the dismissal-message selection (`App.tsx:5419-5425`), but
   compute it live and render it, not just at close time. Add a small status line near the bottom
   of the modal (not a new footer bar with buttons — just text, consistent with the whimsical
   tone the dismissal messages already have): `"No changes yet"` when the diff is empty, or
   `"3 changes will apply when you close this"` when it's non-empty. This directly answers the
   user's stated gap: people don't reconcile that dismissing *is* saving, so tell them, while
   they can still act on it.
2. **A conditional revert action.** Next to that status line, when the diff is non-empty, show a
   text-style action — `"Revert changes"` — that resets every control back to the values captured
   in the `initial` ref and clears the diff, without closing the modal. This is the escape hatch:
   it costs nothing when there are no changes (it isn't even rendered), and costs one click when
   there are. No modal-blocking "Cancel" button, no second confirmation step, no change to what
   Esc/backdrop-click/✕ do.
3. Do **not** gate the revert action behind the dismiss animation or wire it into `dismiss()`
   (`App.tsx:5396`) — it's an in-modal action that mutates state via the same setters the controls
   already use (loop `Object.entries(initial)` back through the corresponding setters), independent
   of closing.

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

**Work:** replace these literal `9px` (and any co-located `font-size`/`font:` shorthand) with
`var(--data-text-compact)`. Two things to check per site before flipping it:

- Some of these live in fixed-height chrome (badges, table header cells, quota card icons) where
  a 9px→22.5px jump at 250% will overflow or clip. Check each visually at 150%, 200%, and 250%.
  Where a literal size must stay fixed for layout reasons (e.g. an icon glyph size, not user
  text), leave it and note why in a one-line comment — don't silently skip it.
- `.measure-table thead th` and similar table headers may need `white-space` / column-width
  adjustments once the header text grows; check for wrapping/overlap, not just clipping.

Do this as a single pass across the list above rather than piecemeal — it's mechanical
(`9px` → `var(--data-text-compact)`), and the risk is entirely in the visual check, not the edit.

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

This matches the user's ask directly: a color transition (not full `all`, to avoid transitioning
layout-affecting properties unintentionally) at `.3s`, plus the underline-with-space treatment
that already exists elsewhere in the app (`.project-session-list a:hover` at `text-underline-offset:4px`,
`styles.css:368`) but currently isn't itself transitioned either — **optionally** migrate that one
and `.search-clear:hover` / `.prompt-order:hover` (`styles.css:292`, `:398`) onto the same tokens
while touching this area, since they're the same "spaced underline on hover" pattern the user
pointed at as the good reference. Not required for this ask, but low-cost since the token values
already exist after this change.

**Migrate existing hardcoded speedy transitions** (optional, low-priority cleanup while the tokens
exist): `.recent-session__tag` (`styles.css:283`, `.16s ease` ×3), `.session-detail-toggle`
(`styles.css:295`, `.2s ease` ×4), `.session-row td` (`styles.css:295`, `.18s ease`) → all fit
`--duration-speedy` + `--ease-standard`. Do this only if it doesn't risk visual drift — `.16s`/`.18s`
vs. the new `140ms` token is close enough not to be noticeable, but check by eye.

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
- The Explorer's **Model signals** chart (`App.tsx:3010-3068`) has **no guard at all** — an empty
  filter selection renders a blank chart (empty axes, no bars, no message).
- A richer, icon+text empty-state component already exists (`Empty`, `chrome.tsx:200-207`, CSS
  `styles.css:352`) and is used in four other places in the app, but not by either of these two
  charts.

**Work:**

1. **New shared helper**, e.g. `describeActiveFilters(filters): string` in a small shared module
   (alongside the existing agent-filter helpers in `src/agent-filter.ts`, or a new
   `src/filter-summary.ts` if it needs range/path-tag inputs `agent-filter.ts` doesn't have).
   Input: whatever the Explorer/Overview already thread through as the active filter state
   (agent selection, date range, path tag). Output: a short templated string, e.g.
   `"Models: none selected · Time frame: Last 30 days · Path: project-x"`. Only include a clause
   for a filter dimension when it's actually narrowing (e.g. omit "Path: —" when no path tag is
   set) — keep it terse.
2. **Wire it into `Empty`** as the message body wherever a widget's emptiness is caused by the
   active filters, not by a genuine absence of data. This distinction matters for `EffortByDay`
   specifically: its `EffortState` wrapper (`src/components/effort/index.tsx:208-249`) already
   has separate not-indexed/disabled/error states that are **not** about filters — only the
   filter-caused `drawable === false` branch should switch to the new templated message; leave
   the other `EffortState` branches as they are.
3. **Add the missing guard to Model signals** (`App.tsx:3010-3068`): compute `modelData.length ===
   0` before rendering `<BarChart>`, and render `<Empty icon=... message={describeActiveFilters(...)}
   />` in that case instead of an empty chart shell.
4. Treat this as the general pattern going forward — any future widget that can go empty purely
   because of the top-level filters should use `Empty` + `describeActiveFilters`, not a bespoke
   message.

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

**Decision needed before implementation** (flagging this rather than picking silently, since the
user was explicit they hadn't settled on an approach): stacking a full provider×effort color
matrix into either chart's bars would multiply the legend from 4 (or 3) swatches to up to 12, and
risks color collisions since effort colors and provider colors are two independently-set palettes.
Recommendation below avoids that by keeping each chart's *primary* color encoding as-is and adding
the *other* dimension as a secondary visual cue plus tooltip detail — cheaper to build, and
doesn't ask the reader to decode a 12-color legend.

**Recommended approach — a shared HSL-variant utility, used in both directions:**

1. New helper, e.g. `src/color-utils.ts`: `hexToHsl(hex)` / `hslToHex(h,s,l)` and
   `effortVariant(baseHex, level)` — given a provider's base color, generate a family of 4
   colors by holding hue (and roughly saturation) constant and stepping lightness per effort
   level (e.g. `low: +22% L, medium: base, high: -14% L, xhigh: -28% L`, clamped to stay legible
   against `--bg`/`--surface`). This is the "dynamically generate a group of colors based around
   the user color" mechanism the user asked for, and it's reusable in both charts below.
2. **Model signals**: keep bars colored by provider as today (that's the chart's primary axis —
   which provider), but derive each bar's exact shade from `effortVariant(providerBaseColor,
   model's dominant effort level)` instead of the flat provider color. Same provider still reads
   as "the same color family" at a glance; effort becomes a lightness cue within that family.
   Extend the tooltip to list the model's effort-level breakdown (tokens or share per level) —
   this is the "tooltip cross-reference" the user explicitly OK'd as sufficient for some of the
   detail.
3. **Effort by day**: keep bars colored/stacked by effort level as today (that's this chart's
   primary axis), and add a thin provider-colored strip (using the real, unmodified
   `--anthropic-color` etc., not a variant) along the bottom or edge of each day's bar, sized or
   colored by the day's dominant provider — a quick-glance cue without touching the existing
   stacked-segment encoding. Extend `EffortDayTooltip` / `EffortDayPoint` to carry a per-provider
   (or per-model, if not too heavy) breakdown within the day, for the same tooltip
   cross-reference treatment.
4. Either way, **color is never the sole carrier** — this codebase is explicit about that
   elsewhere (see the `effortColor` doc comment, and the `SplitPill` convention from the prior
   agent-filter-cascade plan). Keep text labels in the tooltip for every value a color encodes;
   don't rely on the HSL variant alone to communicate effort level in Model signals, or on the
   provider strip alone to communicate provider in Effort by day.

**Explicitly not doing:** a full provider×effort grouped/stacked matrix in either chart, or
changing either chart's primary sort/grouping axis. If the "recommended approach" above turns out
to feel thin once built, revisit with a live look rather than guessing further in the plan.

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

**Decision needed:** "provider favicons" would mean either (a) sourcing and vendoring actual
Anthropic/OpenAI/Warp brand marks as local SVG/PNG assets — a licensing/trademark question worth
a beat of thought, not just an engineering task — or (b) reusing the existing color-swatch
convention (a small colored dot per provider, same visual language as `.provider-legend`)
instead of a literal logo. **Recommend (b) as the default**: add a small `<i
className="provider-dot" style={{background: providerColor}}/>`-style swatch next to the trigger
button's summary text (and optionally in the menu-head), reusing the `PROVIDERS` array
(`App.tsx:432-434`) that already maps `key`/`label`/`color`. This needs no new assets, stays
consistent with how the rest of the app already signals "this is provider X," and sidesteps the
brand-asset question entirely. If real logos are wanted later, swap the dot for an `<img>` once
assets are sourced — the summary-area layout doesn't need to change either way.

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
3. **State change at the call sites**: the existing `benchmarkModal` state at each trigger site
   (`App.tsx:2332` and `App.tsx:4694`) is a plain boolean. Change it to carry the initial site,
   e.g. `useState<(typeof BENCHMARK_SITES)[number]["id"] | null>(null)`, and pass it through to
   `<BenchmarkModal initialSiteId={benchmarkModal} onClose={...}/>` when non-null.
4. **Placement — confirmed: the top bar, next to the Agent filter.** Not the Overview panel and
   not a replacement for either existing trigger. Add `BenchmarkSplitLauncher` as a new, third
   control in `.global-controls`, adjacent to the `.global-filter--agent` block
   (`App.tsx:6622-6624`) — same row, so it's reachable from every page rather than only from
   Overview's Agent Mix panel. Leave both existing triggers (`App.tsx:2595-2601` Overview
   icon-button, `App.tsx:4731-4735` Models `.secondary-button`) exactly as they are; this is an
   additional, always-visible entry point, not a consolidation of the other two. Match its height
   to the other `.global-controls` items (`height:35px`, per `styles.css:96`) so it sits flush in
   the row rather than needing its own vertical alignment fix.
5. **CSS**: new `.benchmark-split-pill` rule — a rounded-pill flex container with two `<button>`
   children, a hairline divider between halves (reuse `--line`/`--line-bright`), each button sized
   to just its favicon plus a few px of padding, with a per-half hover state (background tint on
   the hovered half only, not the whole pill) so it's clear the two halves are independently
   clickable.

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
existing naming conventions. The one failure mode: a model whose name doesn't contain a
recognizable vendor substring/prefix falls into `AgentTree.unparented`
(`src/agent-filter.ts:28,34-42`) — it still works as a standalone filterable model, it just isn't
grouped under its agent's parent checkbox, and nothing today surfaces that this happened.

**Does this need quota-service?** No. `quota-service` (a separate sibling project, adapter at
`server/quota.ts`) is queried only via generic `/usage`, `/resets`, `/status` endpoints scoped by
`provider` (`"anthropic"`/`"codex"`) and `window` (`"fiveHour"`/`"weekly"`) — it has no concept of
individual model names at all, and per `docs/ARCHITECTURE.md:59` explicitly does not supply
analytical cost. A new model release doesn't change what this app asks quota-service for, so
there's nothing to prepare there. **Do not scope quota-service work into this item** unless a
future request specifically wants model-level (not just provider-level) quota granularity, which
quota-service doesn't support today regardless of how new the model is.

**Recommended process** (the actual deliverable, small and self-contained): make the one real
failure mode above visible instead of silent.

1. Where `agentFilterGroups` is built from `agentTree` (`App.tsx:6400-6432`), check
   `agentTree.unparented.length > 0` and surface it — e.g. a small note in the Agent filter popover
   ("N models couldn't be grouped by provider — check provider.ts") or a line in the existing
   Rules/settings area. Low-key, not a blocking banner; this is a maintainer signal, not a
   user-facing error.
2. That note is the whole "process": when it appears, someone updates the
   `providerFromModel`/`providerFromAgent` regexes in `src/provider.ts` to recognize the new
   name's convention. No scheduled job, no external polling — the app already re-derives
   `agentTree` from live session data every load, so the signal appears naturally the first time a
   session using an unrecognized model name gets indexed.
3. Treat this as sufficient. A periodic manual check of provider release notes is not something to
   build tooling around; the in-app signal above is strictly better since it only fires when it's
   actually actionable (a real session with a real unrecognized model showed up).

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

**Fix — omit unselected providers from the render list, not just fade them.** The chart already
receives `activeProvider = selectionProvider(agent)` (`agent-filter.ts:191-200`), but that's a
single-provider-or-`null` value used only for quota-marker filtering elsewhere in the component —
it collapses to `null` for a multi-provider selection, so it can't drive per-provider visibility
on its own. Instead, derive a selected-providers set from the full `AgentSelection`, the same way
`agentSelectionParams` already does (`agent-filter.ts:204-208`, `providers` array) — a provider is
visible if the selection is empty (nothing filtered → show all) or if it's in that `providers`
list.

- Filter `stackedProviderSeries` to selected providers before mapping to `<Area>`
  (`App.tsx:1514-1531`): `stackedProviderSeries.filter(isSelectedProvider).map(...)`.
- Since a filtered-out provider's values are already all-zero, there's nothing meaningful to
  fade — **omission, not opacity**, is the right fix here; there's no visible area to fade into a
  ghost, only a stray stroke to eliminate. (Contrast with §7, where fading/blending was about two
  *both-present* dimensions — this is about a dimension that's supposed to be entirely absent.)
- Also filter the matching `<def>` gradient block (`App.tsx:1451-1472`) and whatever renders the
  legend swatches for this chart (check the component for a legend loop over the same series
  array — it should match the filtered set, or a hidden provider will still show a swatch with no
  area to back it).
- Apply the same selected-provider filter to `HourlyProviderTimeline`
  (`App.tsx:1563-1766`, `<Bar>` series) and `ProjectDetails`'s daily chart (`App.tsx:4285-4296`,
  `<Bar>` series) for consistency — their zero-height `<Bar>` elements don't currently leak a
  visible stroke the way `<Area>` does (bars have no `stroke`), so they aren't visibly broken
  today, but they should behave the same way as the fixed `ProviderTimeline` rather than being an
  exception a future reader has to puzzle over.

**Do not** touch `activeProvider`'s existing single-provider emphasis behavior (used for quota
markers) — that's a separate, already-working feature; this fix is about whether a provider is
drawn at all, not about which drawn provider is emphasized.

---

## Risks / watch-items

- §1 and §3 are the two items with real visual risk — a slower-but-earlier fade can look janky if
  it desyncs from the blur/message layers, and 250% text can overflow fixed-size chrome. Budget
  time for the live check on both, don't ship on CSS reasoning alone.
- §5's token introduction touches `:root`, which is also mutated at runtime for accent/provider
  colors and the data-text scale (`App.tsx:6190-6269`) — adding static tokens alongside those is
  fine (they're never overwritten by JS), just don't name a new token the same as anything JS
  sets via `setProperty`.
- §7 depends on `src/color-utils.ts` (or wherever the HSL helper lands) not existing yet — confirm
  there isn't already a color-math helper elsewhere before adding a new file (a quick grep for
  `hexToHsl`/`hsl(` turned up nothing in the exploration pass, but re-check at implementation time
  since this plan predates the actual edit).
- §9's "provider favicons" and §11's benchmark favicons are **not the same asset question** —
  don't let one implementation answer the other. §11's favicons already exist (external benchmark
  site icons, already fetched today). §9's do not exist for Anthropic/OpenAI/Warp and default to
  the color-dot fallback unless real logo assets are separately sourced.
- §13's fix must key off the full `AgentSelection`, not `activeProvider` — `activeProvider`
  collapses to `null` for any multi-provider selection (`selectionProvider`,
  `agent-filter.ts:191-200`), so driving visibility from it alone would leave every provider
  showing (or none) whenever more than one is selected, which is the common case, not the edge
  case. Use the same `providers` derivation `agentSelectionParams` already computes.
- §8's fix and §13's fix both read `group.options`/selection-derived state that already exists for
  other reasons (tri-state checkboxes, `agentSelectionParams`) — resist the urge to add a new
  parallel "flattened selection" data structure for either; reuse what's already computed.

## Definition of done

- [ ] §1: darkening layer visibly begins lightening well before the old 1.581s mark; total dismiss
      duration unchanged (~2.05s); center reads darker than edges through the tail of the fade.
- [ ] §2: modal shows a live, non-blocking change count; a "Revert changes" action appears only
      when the diff is non-empty and correctly restores `initial` values without closing.
- [ ] §3: text-scale slider reaches 250% (or 200% if 250% proves unworkable); every listed literal
      `9px` site scales with it or has a documented reason it doesn't.
- [ ] §4: footer labels right-align against their values at desktop width; single-column mobile
      layout resets to left-align.
- [ ] §5: `:root` motion tokens exist; footer links have a `.3s` color transition and a spaced
      underline on hover.
- [ ] §6: Model signals shows the `Empty` component with a templated filter summary when the
      selection yields no data; Effort by day's filter-caused empty state does too, without
      touching its other (not-indexed/disabled/error) states.
- [ ] §7: HSL-variant helper exists and is used by both charts as described; tooltips carry the
      cross-reference detail; no chart's primary color axis changed.
- [ ] §8: checking both provider parents (all models) reads as the real per-model count (e.g.
      "~15 selected"), not "2 selected"; single-selection and empty-selection labels unchanged.
- [ ] §9: menu-head summary text matches the trigger button's lighter color; a provider indicator
      (color-dot by default) appears in the summary area.
- [ ] §10: trigger button hugs its text/chevron with no dead right-side padding; open panel is
      10-13% narrower with no clipped/wrapped model labels at the new width.
- [ ] §11: a split-pill launcher sits in the top bar next to the Agent filter; each half deep-links
      to its own benchmark tab via a real `initialSiteId` prop, not just opening the default tab.
- [ ] §12: an in-app signal appears when a model can't be grouped to a provider (`unparented`
      length > 0); no quota-service changes made or needed.
- [ ] §13: filtering out a provider removes its line/area (and legend swatch) from
      `ProviderTimeline` entirely — no stray full-color stroke along the remaining provider's
      boundary; `HourlyProviderTimeline` and `ProjectDetails`' chart behave consistently.
- [ ] `bun x tsc --noEmit -p .` clean, `bun test` green, `bun run build` succeeds.
- [ ] Live check: Appearance modal open/close + revert, text-scale slider at 90/150/200/250%,
      Explorer with an empty Agents filter, footer at desktop and ~620px widths, Agent filter
      trigger/panel widths, benchmark split-pill deep links, and provider timeline with one/two
      providers filtered out.
