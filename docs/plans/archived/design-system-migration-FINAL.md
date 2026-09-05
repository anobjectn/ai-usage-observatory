# Design system migration — FINAL

Slug: design-system-migration · Date: 2026-09-05
Author: Claude Fable 5.1 (medium)
Based on: design-system-migration-REVISED.md
Execution state: executed 2026-09-05 (see Execution notes)

## Changes from REVISED

Accepted from the reviewer without change:

- Corrected counts: 83% of type declarations are hard pixel sizes (408 of 489), 33 distinct
  sizes, 21 distinct tracking values, 39 transitions of which 26 lack motion tokens, 57 box
  shadows, 17 radius literals plus 50%, 1,087 stylesheet lines. The two 1,000ms animations
  named in the audit no longer exist; they were removed with the Models table commit.
- No token may hold a whole `font` shorthand. Family, size, weight, line height, and tracking
  are separate tokens composed in role selectors.
- Staged stylesheet split through a temporary `legacy.css`; no cascade layers, no custom-media
  tooling, no new React components for the migration.
- Defer z-index tokens until a stacking-context inventory exists.
- The shadow performance claim is unverified; profile before changing elevation for speed.
- The Models table is a partial pilot only: its data cells are tokenised, its headings, marks,
  and controls are not.
- Runtime-written custom properties keep their names; renames need an atomic JavaScript change
  because saved settings depend on them.
- Keep literal hex defaults in `App.tsx` for the favicon and canvas scene; CSS variable strings
  cannot enter `scene.tsx` mixers or the favicon.

Decided by the user on 2026-09-05:

1. **Interface text scale is added** as a second Appearance setting, separate from the existing
   data text size. This overrides the reviewer's recommendation to keep the setting data-only.
   The reviewer's constraint still holds: the new scale does not hide under the existing control.
2. **Accent is interaction-only.** Effort levels, trends, and model families move to stable
   tokens in step 4.
3. **The 11px floor is approved** as a visible change, applied per view in steps 8 to 13.
4. **Two label roles.** Tracked uppercase mono for data-oriented labels and table headers;
   sentence-case sans for help text and ordinary control labels.

Host additions the reviewer did not cover:

- Baseline is `main` @ `63e6192` (Models table committed), not `7e4f877`.
- `scripts/capture-data-screenshot.ts` is the existing headless-Chrome capture; step 1 extends
  it rather than writing a second launcher.
- AGENTS.md rules apply throughout: reuse the app on 5173 and 4318, never restart a
  user-owned process, leave the app reachable at the end of each step.
- The interface scale changes the runtime token count from 9 to 10 properties and adds one
  localStorage key; step 2 owns both.

## Verified baseline

Counts from the working tree on 2026-09-05 at `63e6192`.

| Area | Confirmed state |
| --- | --- |
| Stylesheet | `src/styles.css`: 1,087 lines, 197,875 bytes, 1,908 opening braces including media and keyframe blocks. 22 lines exceed 1,500 characters; the longest is 8,359. |
| Type | 331 `font:` declarations (285 pixel sizes) and 158 `font-size:` declarations (123 pixels): 408 of 489, about 83%. 33 distinct sizes; 10px ×122, 9px ×101, 12px ×41, 8px ×36, 11px ×27. `var(--font-label)` ×315, `var(--serif-font)` ×6, uppercase ×78, 21 distinct em tracking values. |
| Data scale | Four `--data-text-*` tokens, 67 uses. `--data-text-scale` has no CSS consumer; JavaScript writes the scalar and the four derived pixel values. The stepper allows 90 to 250; `savedDataTextScale` rejects anything above 150 on reload. |
| Colour | `var(--accent)` ×235, `color-mix()` ×135, 33 distinct raw hex values, `#07100f` ×14. Colour tables in `App.tsx` (palette, defaults), `token-types.tsx` (four duplicated palette hexes), `combo.ts` (effort and family maps plus a six-colour fallback), `scene.tsx` (9 scene hexes). |
| Shape | 182 `border-radius` declarations, 17 pixel values plus 50%, `var(--radius)` ×3. 57 `box-shadow`, `var(--shadow)` ×4, 6 backdrop filters. |
| Layout | 19 distinct z-index values. 41 width media blocks over 14 query expressions, plus 2 reduced-motion blocks. |
| Motion | 39 transitions; 13 use motion tokens, 26 do not. No 1,000ms animations; the only 1s value is the loading spin. |
| Structure | `.model-quick-links` is dead. `App.tsx` has 36 inline style objects, mostly data-driven and to be kept. |
| Runtime theme | Appearance writes 9 properties today: accent, three provider colours, the data scalar, four derived data sizes. |
| Tests | `App.test.ts`, `effort-ui.test.ts`, `quick-overview.test.ts` assert server-rendered HTML with exact class strings; `combo.test.ts` and `effort-ui.test.ts` assert exact CSS variable strings. |
| View transitions | None remain. Reduced motion is handled in two CSS blocks, `App.tsx`, and `scene.tsx`. |

## Contracts

- **Data text size** (existing): scales only `--data-text-*`. Range 90 to 250, persisted and
  restored at the same range. Values are JavaScript-derived as today.
- **Interface text size** (new): scales every UI type token except data text. Separate
  stepper, separate storage key, default 100, range 90 to 130. Implemented as
  `--type-scale-ui` consumed by `calc()` in CSS, so JavaScript writes one scalar only.
- **Accent**: focus, links, active states, selection. Nothing else.
- **Status colours**: `--color-up`, `--color-down`, `--color-warn`, `--color-danger`,
  `--color-info`, stable across accents.
- **Series and effort colours**: `--color-series-1..6` and one token per effort level, stable.
- **Type floor**: 11px at 100% interface scale for any text a person is expected to read.
- **Label roles**: `.label` (tracked uppercase mono) for data labels and table headers only;
  `.caption` (sentence-case sans, dim) for help and ordinary control labels.
- **State classes**: no mass rename. New work uses `is-*` for transient state and `--variant`
  for static variants.

Stop before the view walk (step 8) if any contract above is reopened.

## Plan

### 1. Freeze the baseline and visual matrix

Files: `scripts/capture-data-screenshot.ts` (extend), `docs/plans/todo/design-system-migration-FINAL.md`.

- Record the commit and rerun the counts table.
- Check 5173 and 4318 first; reuse the running app.
- Capture all six views at 1440, 1024, and 390 CSS pixels.
- Also capture: collapsed sidebar, an expanded Models row and Sessions row, a chart tooltip,
  the agent filter and date popovers, quick overview, Appearance, a non-default accent, custom
  provider colours, data scale at 90, 125, 150, and 250.
- Force reduced motion or disable scene effects so the canvas does not invalidate comparisons.
- Treat live quotas, timestamps, and chart series as masked regions unless the data snapshot
  is fixed.

Verification: `bun run typecheck`, `bun test`, `bun run build`, then the capture matrix.

Stop when: a baseline check already fails, or dynamic content prevents a trustworthy
comparison. Record the failure before touching CSS.

### 2. Repair and extend the Appearance contract

Files: `src/App.tsx`, `src/App.test.ts`, `src/styles.css`.

- Extract a pure normaliser for the data scale; test 90, 150, 250, invalid, and missing.
- Make persistence accept 90 to 250 to match the stepper.
- Add the interface scale: state, storage key, normaliser (90 to 130), stepper in the
  Appearance modal beside the data stepper, `documentElement.style.setProperty("--type-scale-ui", …)`,
  reset handling. Default 100 renders identically to today.
- Keep the nine existing runtime property names. Document all ten as runtime-owned.
- Document that `--data-text-scale` is metadata; the four derived pixel values remain
  JavaScript-written.

Verification: targeted `App.test.ts`, full checks. Set data scale to 250, reload, confirm the
value and all four computed tokens survive. Set interface scale to 130, reload, confirm the
scalar survives and the UI reflows without clipping the topbar, sidebar, or Appearance modal.
Repeat for custom accent and provider colours.

Stop when: 250% data scale or 130% interface scale clips essential text or controls. Fix the
reflow or lower the range; never leave the control and persistence disagreeing.

### 3. Add unused foundation tokens

Files: `src/styles.css`.

Add without changing consumers:

- Type: `--text-2xs` 11px through `--text-4xl` 44px, each as
  `calc(<base> * var(--type-scale-ui, 1))`; weights; line heights; two tracking values.
- Space: 4px scale, `--space-1` to `--space-8`.
- Radius roles: control 8px, chip 4px, card 12px, panel 16px, pill 999px.
- Elevation roles: panel, floating, modal.
- Colour: status, one per effort level, six series. Keep every existing colour name.
- Defer z-index.

Verification: computed styles and baseline screenshots unchanged. Literal counts unchanged
because nothing consumes the tokens yet.

Stop when: adding declarations changes any computed style or runtime-set token.

### 4. Separate semantic colours from the accent

Files: `src/styles.css`, `src/App.tsx`, `src/combo.ts`, `src/components/token-types.tsx`,
`src/combo.test.ts`, `src/effort-ui.test.ts`.

- Point trends, warnings, availability states, and effort maps at their new roles.
- Replace the `App.tsx` palette and `tokenTypeColors` values with CSS-variable references.
- Move `combo.ts` fallback and fixed maps to series or semantic references.
- Keep literal defaults for the favicon and `scene.tsx`.
- Confirm Recharts resolves CSS variables in SVG presentation attributes before removing
  chart literal fallbacks.
- Define an `--on-accent` policy before placing text over a user accent.
- Update the exact-string assertions in `combo.test.ts` and `effort-ui.test.ts` deliberately.

Verification: combo, effort, token-type, chart, and rendered-HTML tests; inspect every series,
legend, trend arrow, warning state, and a custom accent.

Stop when: an SVG or canvas receives an unresolved variable, colour becomes the only state cue,
or accent contrast fails. Resolve colour at the rendering boundary rather than adding a
parallel palette.

### 5. Consolidate shared patterns in the monolith

Files: `src/styles.css`, `src/App.tsx`, `src/views/chrome.tsx`, `src/views/data/effort.tsx`,
`src/components/*`.

One pattern at a time:

1. Type roles: `.label`, `.caption`, body, data value, panel title, page title. Apply the two
   label roles; the 11px floor lands here for shared text.
2. Panels and panel headings.
3. Segmented controls and searches.
4. Method chips, effort badges, split pills, agent pills.
5. Sort headers and detail toggles.
6. Text links, ghost, primary, and secondary buttons, empty states.
7. Table styles now carried by bare `table`, `th`, `td` selectors.

Verification: related rendered-HTML tests after each JSX class change; compare default, hover,
focus-visible, disabled, open, loading, and empty states.

Stop when: a shared rule needs several `!important` overrides or component exceptions. Split it
into explicit variants.

### 6. Split the stylesheet through `legacy.css`

Files: `src/main.tsx`, `src/styles.css`, new `src/styles/`.

```text
src/styles/
  index.css
  tokens.css
  base.css
  primitives.css
  chrome.css
  motion.css
  legacy.css
  views/{models,sessions,explorer,projects,data,overview}.css
```

- `main.tsx` imports only `styles/index.css`.
- Move tokens, base, and consolidated patterns first; everything else goes to `legacy.css`,
  imported after the structural files.
- Preserve selector text and order; reformat to one declaration per line as rules move.
- Do not combine the split with dead-rule deletion or specificity cleanup.

Verification: build, inspect emitted CSS order, compare computed styles for representative
elements, full visual matrix.

Stop when: import order changes a computed declaration. Restore order before continuing.

### 7. Migrate chrome, overlays, and responsive ownership

Files: `src/styles/chrome.css`, `tokens.css`, `legacy.css`, `src/App.tsx`, `src/views/chrome.tsx`.

- Move shell, sidebar, topbar, filters, modals, Appearance, quick overview, footer, overlays.
- Inventory stacking contexts, then tokenise global layers by role; leave local 0 to 4 alone.
- Keep responsive queries beside their component; merge duplicate blocks only when cascade
  order is preserved. Document 620, 900, and 1180 as the breakpoints.
- Preserve both CSS reduced-motion blocks and both JavaScript hooks.

Verification: sidebar and scrim at mobile widths, sticky topbar, filter menu, date popover,
modal, action popover, chart popover, toast, model-session card; focus trapping and focus
visibility.

Stop when: an overlay crosses a modal or sticky boundary incorrectly, or a merged query
changes precedence.

### 8. Migrate Models (pilot view)

Files: `src/App.tsx`, `src/styles/views/models.css`, `legacy.css`, `src/App.test.ts`.

- Move every Models rule including responsive and expanded-row rules.
- Tokenise headings, marks, controls, spacing, radii, local elevation; apply the floor.
- Keep calculated viewport widths and data-driven inline colours inline.

Verification: sort every column, expand rows, sticky column, session card; 390, 1024, 1440 at
all supported scales.

Stop when: sticky columns overlap, expanded content clips, or a data value is lost at 250%.

### 9. Migrate Sessions

Files: `src/App.tsx`, `src/components/effort/index.tsx`, `src/components/page-jump.tsx`,
`src/styles/views/sessions.css`, `legacy.css`, `src/App.test.ts`.

- Table, pagination, expanded detail, transcript sections, quota context, action menus, badges.
- Preserve dynamic custom properties for widths, fills, placement.

Verification: sorting, paging, jump menu, row expansion, source actions, loading and error
states, keyboard use, all viewport and scale combinations.

Stop when: navigation, rendered-HTML contracts, popover placement, or column scrolling regress.

### 10. Migrate Explorer

Files: `src/App.tsx`, `src/combo.ts`, `src/components/chart-pins.tsx`,
`src/styles/views/explorer.css`, `legacy.css`, combo, effort, chart-pin tests.

- Composition panels, charts, legends, tooltips, filter-empty states, effort views.
- Keep chart geometry separate from typography tokens.

Verification: empty and populated filters, hover and pinned tooltips, legends, axes, all
effort combinations, custom accent, reduced motion.

Stop when: chart labels clip, pinned tooltips change layer, or variable colours fail in SVG.

### 11. Migrate Projects

Files: `src/App.tsx`, `src/styles/views/projects.css`, `legacy.css`, project-grouping,
model-slope, chart-pin tests.

Verification: sorting, expansion, session links, charts, narrow layouts, scaling.

Stop when: chart geometry, row hierarchy, or expanded-detail order changes.

### 12. Migrate Data

Files: `src/App.tsx`, `src/views/data/*.tsx`, `src/components/token-types.tsx`,
`src/styles/views/data.css`, `legacy.css`, token, quota, effort tests.

- Keep serif only for the intentional score treatment.
- One table and one caption system across the data modules.

Verification: every subsection, token tables, profiles, effort analysis, outliers, Warp
ledger, missing-data states, all viewport and scale combinations.

Stop when: a dense table cannot reflow at a supported scale or a panel loses hierarchy.

### 13. Migrate Overview last

Files: `src/App.tsx`, `src/scene.tsx`, `src/views/chrome.tsx`, `src/styles/views/overview.css`,
`legacy.css`, quick-overview, scene, App tests.

- Hero, metric cards, quota panels, recent sessions, quick overview, scene-adjacent layout.
- Keep scene palette and canvas arithmetic independent from CSS variable strings.
- Reassess repeated uppercase mono eyebrows against the two-role contract.

Verification: live, stale, and unavailable quota states, hero scene, quick overview modes,
collapsed sidebar, mobile, reduced motion, custom appearance.

Stop when: animation suppression fails, quota meaning relies on colour alone, or the hero and
cards lose hierarchy.

### 14. Motion, elevation, cleanup

Files: `src/styles/motion.css`, all migrated CSS, `legacy.css`, affected tests.

- Replace the 26 untokenised transitions, preserving current duration and easing first.
- Consolidate reduced-motion CSS into `motion.css`, imported last; keep the page-jump text
  fallback and both JavaScript listeners.
- Profile before claiming shadow cost; apply panel, floating, and modal elevation by hierarchy.
- Run CSS coverage through every recorded state; delete `.model-quick-links` and other dead
  selectors only when search and coverage agree.
- Delete `legacy.css` only when empty.
- Record justified literal exceptions: chart geometry, canvas colours, icon dimensions,
  data-driven styles.

Verification: typecheck, tests, production build, CSS coverage, contrast, keyboard pass,
reduced-motion pass, full screenshot matrix. The user's app stays reachable throughout.

Done when: `legacy.css` is gone; both Appearance scales and all colour settings persist and
update computed tokens; every view owns its CSS; shared controls use the agreed roles; no
unintended screenshot differences; tests and build pass; remaining literals and `!important`
uses are documented exceptions.

## Execution recommendation

- **Steps 1 to 7, 9, and 14**: Sol 5.6 high, or Fable 5 high on the Anthropic side. These
  carry runtime token ownership, the new interface scale, cascade order, stacking contexts,
  and accessibility judgement.
- **Steps 8, 10, 11, 12, 13**: Terra, or Sonnet high, one view per task, once the token and
  file contracts from steps 3 to 7 are stable.
- **Likely long**: step 1's matrix (18 viewports plus states), step 6, step 9, step 12, step 13.
- **Safe handoff points**: after step 2, after step 4, after step 6, after each completed view,
  before step 14.
- Step 2 is now a behaviour change (new setting), so it should not be delegated to a
  lower-effort model.

## Related

- `docs/plans/todo/ui-polish-batch-PLAN-REVISED.md` §5 introduced the motion tokens and
  deferred migrating existing transitions; step 14 completes it.
- On completion, move the PLAN, REVISED, and FINAL files for this slug to
  `docs/plans/archive/`.

## Execution notes (2026-09-05, Claude Fable 5.1)

Executed in one session against `63e6192`; all work is in the working tree, uncommitted.

- Steps 1 to 14 completed. `src/styles.css` is gone; `src/styles/` holds tokens, base, primitives,
  chrome, one file per view, and `motion.css` last. `legacy.css` was created and emptied.
- Every view was moved with a computed-style snapshot taken before and diffed after (20 properties
  per element, 300 to 2,500 elements per view). All six views diffed clean apart from live-data
  false positives. One deliberate cascade change was accepted: the Claude pill in the Overview
  recent list now takes the Anthropic provider token instead of a raw hex override, matching the
  Sessions table.
- Appearance: data scale and its stepper share one range, 90 to 180 (the user capped the
  stepper at 180 after execution; it was 250 during the run); an
  "Interface text size" stepper (90 to 130) writes `--type-scale-ui`, which every `--text-*`
  token multiplies. Both survive reload; verified at 250 (pre-cap) and 130.
- Type floor: 273 declarations at 10.5px or below now use `--text-2xs`; 77 exact sizes use
  their `--text-*` token; the remaining 11.5/12.5/13.5px odd sizes were snapped to the nearest
  token. No text under 11px remains.
- Colour: trends use `--color-up/--color-down`; every former `--orange` consumer is
  `--color-warn`; `--red` consumers are `--color-danger`; effort levels, model families, the
  chart palette, token-type colours, and the Data composition bar read `--color-series-*` and
  `--color-effort-*`. Exact-string colour assertions in tests were updated.
- Radius: 143 literals mapped to `--radius-chip/control/card/panel/pill`; `--radius` aliases
  `--radius-panel`. Shadows map to `--shadow-panel/floating/modal`; the panel value is unchanged
  because no profiling was done.
- Motion: all transition durations use `--duration-*` tokens (snapped to the nearest token,
  never more than 50ms from the literal); easing curves were left as written.
- Deviations and leftovers, by design: 68 `!important` flags remain; 32 raw hex literals remain
  (`#000` on detail backgrounds, `#fff`, near-black surface tints, scene and boot colours);
  z-index tokens deferred pending a stacking inventory; the 80px panel shadow unchanged.
- Verification: `bun run typecheck`, `bun test` (468 pass), `bun run build` all green. Screenshot
  matrices for each step are in `_temp/design-<step>/` from `scripts/capture-design-matrix.ts`.
