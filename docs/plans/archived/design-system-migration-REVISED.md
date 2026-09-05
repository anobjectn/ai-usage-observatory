# Design system migration — REVISED

Slug: design-system-migration · Date: 2026-09-05
Reviewer: GPT-5.6 Sol (high) via Codex CLI `codex exec --sandbox read-only`
Based on: design-system-migration-PLAN.md

> Reviewer output saved verbatim below.

# Design system migration, revised plan

## Verified baseline

Counts are from the current working tree reviewed on 2026-09-05.

| Area | Confirmed state |
| --- | --- |
| Stylesheet | `src/styles.css` is 1,087 lines and 197,875 bytes. It contains 1,908 opening braces, including rules, media blocks, and keyframes. |
| Long lines | 22 lines exceed 1,500 characters. The longest is 8,359 characters. |
| Type | 331 `font:` declarations, 285 with pixel sizes. 158 `font-size:` declarations, 123 hard-coded in pixels. Combined, 408 of 489 declarations are hard pixel sizes, about 83%, not 87%. |
| Type sizes | 33 distinct pixel sizes. Most common are 10px ×122, 9px ×101, 12px ×41, 8px ×36, and 11px ×27. |
| Type roles | `var(--font-label)` appears 315 times, `var(--serif-font)` 6 times, and uppercase transformation 78 times. There are 21 distinct `em` letter-spacing values, not 10. |
| Data scale | The four `--data-text-*` tokens have 67 uses. `--data-text-scale` itself has no CSS consumer. JavaScript writes the scalar and all four derived pixel values. |
| Colour | `var(--accent)` appears 235 times and `color-mix()` 135 times. CSS contains 33 distinct raw hex values. `#07100f` appears 14 times, including its token definition. |
| Colour tables | `App.tsx` has the six-colour palette and runtime defaults. `token-types.tsx` duplicates four palette colours. `combo.ts` also has an omitted six-colour fallback palette, plus effort and family maps. `scene.tsx` has 9 distinct scene-specific hex values. |
| Shape | 182 `border-radius` declarations use 17 distinct pixel values plus `50%`. `var(--radius)` appears 3 times. There are 57 `box-shadow` declarations, with 4 uses of `var(--shadow)`, and 6 backdrop filters. |
| Layout | There are 19 distinct numeric z-index values. The file has 41 width-responsive media blocks covering 14 semantic query expressions, plus 2 reduced-motion blocks. |
| Motion | 39 transition declarations exist. 13 use duration or easing tokens and 26 do not. The claimed two 1,000ms animations do not exist. The only 1s match is the loading spin. |
| Structure | `model-quick-links` has no source counterpart and is confirmed dead. `App.tsx` has 36 inline style objects, many carrying data-dependent dimensions, positions, or colours that should remain dynamic. |
| Runtime theme | Appearance effects write 9 CSS properties: accent, three providers, the data scalar, and four derived data sizes. Renaming these tokens without an atomic JavaScript update would break saved settings. |
| Tests | `App.test.ts`, `effort-ui.test.ts`, and `quick-overview.test.ts` assert server-rendered HTML. `App.test.ts` contains exact class-string assertions. `combo.test.ts` and `effort-ui.test.ts` also assert exact CSS variable strings. |
| View transitions | No View Transition API or `view-transition-*` CSS exists. Reduced motion is handled in two CSS blocks, `App.tsx`, and `scene.tsx`. |

The Models table is a useful pilot, but it is not fully token-based. Its data-cell sizes use `--data-text-*`; headings, marks, controls, dimensions, and surrounding cards still contain literals.

The claim that the 80px shadow is the largest paint cost is unverified. Do not use performance as justification without profiling.

## Decisions required before visual changes

1. Keep "Data text size" data-only. Do not add `--type-scale-ui` under the existing setting. The control advertises 90–250%, while saved values above 150% are rejected on reload. Recommended contract: 90–250%, with reflow fixed where necessary.

2. Decide whether a custom accent should recolour effort, trends, and model families. Recommended contract: accent controls interaction and focus; status, effort, and series colours remain stable. Until approved, preserve the current coupling.

3. Approve the 11px readable-text floor and new elevation values as visual changes. Adding unused tokens is a no-change step. Replacing 9px or 10px text with an 11px token is not.

4. Keep the observatory and instrument-panel character. Monospace fits data, identifiers, and instrument readouts. Do not formalize every tracked uppercase caption as one universal `.label`; explanatory text and ordinary control labels should use sentence-case sans text.

5. Use a staged stylesheet split. Do not add cascade layers, custom-media tooling, or generic React components solely for this migration.

Stop before the view walk if decisions 1 through 3 remain unresolved.

## Revised migration plan

### 1. Freeze the baseline and visual matrix

Files: `docs/plans/todo/design-system-migration-PLAN.md`, new `scripts/capture-design-system-screenshot.ts` if repeatable capture is required.

- Record the commit and rerun the counts above.
- Check ports 5173 and 4318 before starting anything. Reuse the running app.
- Capture all six views at 1440, 1024, and 390 CSS pixels.
- Capture sidebar states, expanded table rows, chart tooltips, filter/date popovers, quick overview, Appearance, a non-default accent, provider colours, and data scale at 90, 125, 150, and 250%.
- Force reduced motion or disable scene effects so canvas animation does not invalidate comparisons.
- Treat dynamic quotas, timestamps, and charts as masked regions unless the data snapshot is fixed.

Verification: `bun run typecheck`, `bun test`, `bun run build`, followed by the capture matrix.

Stop when: any baseline check already fails, or dynamic content prevents a trustworthy comparison. Record the failure before changing CSS.

### 2. Repair and document the Appearance contract

Files: `src/App.tsx`, `src/App.test.ts`, `src/styles.css`.

- Extract a pure data-scale normalization helper and test 90, 150, 250, invalid, and missing values.
- Make persistence accept the same maximum as the control. Recommended maximum: 250.
- Keep `--accent`, `--anthropic-color`, `--openai-color`, `--warp-color`, and the four `--data-text-*` properties as runtime-owned names.
- Keep the four JavaScript-derived pixel writes unless browser support for arithmetic custom properties is explicitly established.
- Document that `--data-text-scale` is metadata, not the source of the derived CSS values.
- Do not introduce a second data-scale token.

Verification: targeted `App.test.ts`, full checks, then change the scale to 250%, reload, and confirm the value and all four computed tokens survive. Repeat for custom accent and provider colours.

Stop when: 250% clips essential text or controls. Decide whether to fix reflow or reduce the advertised limit. Do not leave the UI and persistence limits different.

### 3. Add unused foundation tokens

Files: `src/styles.css`.

Add tokens without changing consumers:

- Type sizes, weights, line heights, and limited tracking roles.
- A 4px spacing scale.
- Radius roles for controls, cards, panels, and pills.
- Panel, floating, and modal shadow roles.
- Stable status, effort, and six series colours.
- Preserve existing background, surface, text, accent, and provider names.
- Defer z-index tokens until the stacking-context audit.

Do not define one custom property containing an entire `font` shorthand. Define family, size, weight, line-height, and tracking separately, then compose them in role selectors.

Verification: compare computed styles and the baseline screenshots. Hard-coded-value counts should be unchanged because the tokens are still unused.

Stop when: adding declarations changes any computed style or runtime-set token.

### 4. Separate semantic colours from runtime accent

Files: `src/styles.css`, `src/App.tsx`, `src/combo.ts`, `src/components/token-types.tsx`, `src/combo.test.ts`, `src/effort-ui.test.ts`.

- Add independent tokens for positive, negative, warning, danger, info, each effort level, and series 1–6.
- Point trends, warnings, availability states, and effort maps to their roles.
- Replace the `App.tsx` palette and `tokenTypeColors` values with CSS-variable references.
- Move `combo.ts` fallback and fixed maps to semantic or series references.
- Keep literal runtime defaults in `App.tsx`; the favicon and canvas scene require resolved hex values.
- Keep scene shading local to `scene.tsx`. CSS variable strings cannot be passed into its hex mixers.
- Replace chart-neutral literals only after confirming Recharts resolves CSS variables in SVG presentation attributes.
- Add an `--on-accent` policy before placing arbitrary user accents behind text.

Verification: targeted combo, effort, token-type, chart, and rendered-HTML tests. Inspect all chart series, legends, trends, warning states, and custom accent/provider settings.

Stop when: an SVG or canvas receives an unresolved CSS variable, colour becomes the only state cue, or custom accent contrast fails. Resolve the colour at the rendering boundary instead of duplicating a new palette.

### 5. Consolidate shared CSS patterns in the monolith

Files: `src/styles.css`, `src/App.tsx`, `src/views/chrome.tsx`, `src/views/data/effort.tsx`, relevant files under `src/components/`.

Migrate one pattern at a time:

1. Type roles: rare eyebrow, table heading, field label, caption, body, data value, panel title, page title.
2. Panels and panel headings.
3. Segmented controls and searches.
4. Method chips, effort badges, split pills, and agent pills.
5. Sort headers and detail toggles.
6. Text links, ghost buttons, primary buttons, and empty states.
7. Table styles currently applied through bare `table`, `th`, and `td` selectors.

Use sentence case and sans text for help and ordinary controls. Reserve tracked mono text for data-oriented labels. Keep data text on `--data-text-*`.

Do not mass-rename `.active`, `.is-open`, and `--open`. For new work, use `is-*` for transient state and `--variant` for static variants.

Verification: run the related rendered-HTML tests after every JSX class change. Compare default, hover, focus-visible, disabled, open, loading, and empty states.

Stop when: a shared rule needs several `!important` overrides or unrelated component exceptions. Split it into explicit variants instead.

### 6. Split the stylesheet through a temporary legacy file

Files: `src/main.tsx`, `src/styles.css`, new files under `src/styles/`.

Target structure:

```text
src/styles/
  index.css
  tokens.css
  base.css
  primitives.css
  chrome.css
  motion.css
  legacy.css
  views/
    models.css
    sessions.css
    explorer.css
    projects.css
    data.css
    overview.css
```

- Import only `styles/index.css` from `main.tsx`.
- Move tokens, base rules, and consolidated patterns first.
- Put untouched rules in `legacy.css`, imported after migrated structural files.
- Preserve selector text and order during each move.
- Format moved rules conventionally, with one declaration per line.
- Do not combine the split with dead-rule deletion or specificity cleanup.
- Do not introduce cascade layers during this migration.

Verification: build, inspect emitted CSS order, compare computed styles for representative elements, and run the full visual matrix.

Stop when: import order changes a computed declaration. Restore the original order before continuing.

### 7. Migrate chrome, overlays, and responsive ownership

Files: `src/styles/chrome.css`, `src/styles/tokens.css`, `src/styles/legacy.css`, `src/App.tsx`, `src/views/chrome.tsx`.

- Move shell, sidebar, topbar, filters, modals, Appearance, quick overview, footer, and global overlays.
- Inventory stacking contexts before replacing z-index literals.
- Tokenize global layers by actual role. Leave component-local values such as 0–4 local.
- Test the current 15–95 overlay range before attempting to compress it.
- Keep responsive queries beside the component they affect.
- Consolidate duplicate query blocks only when selectors retain the same cascade order.
- Document breakpoint purposes. CSS variables cannot replace media-query thresholds.
- Preserve both CSS reduced-motion behaviors and both JavaScript media-query hooks.

Verification: sidebar and scrim at mobile widths, sticky topbar, filter menu, date popover, modal, action popover, chart popover, toast, and model-session card. Check focus trapping and keyboard focus visibility.

Stop when: an overlay crosses a modal or sticky boundary incorrectly, or a consolidated media query changes precedence.

### 8. Migrate Models as the pilot view

Files: `src/App.tsx`, `src/styles/views/models.css`, `src/styles/legacy.css`, `src/App.test.ts`, model and effort tests.

- Move every Models-owned rule, including responsive and expanded-row rules.
- Keep existing data cells on runtime data-size tokens.
- Tokenize headings, controls, spacing, radii, and local elevation.
- Keep calculated viewport widths and data-driven inline colours or dimensions inline.
- Remove Models rules from `legacy.css`.

Verification: sort every column, expand rows, use sticky columns, open the session card, and test 390/1024/1440 widths at all supported data scales.

Stop when: sticky columns overlap, expanded content clips, or 250% loses a data value.

### 9. Migrate Sessions

Files: `src/App.tsx`, `src/components/effort/index.tsx`, `src/components/page-jump.tsx`, `src/styles/views/sessions.css`, `src/App.test.ts`, session and effort tests.

- Migrate table, pagination, expanded detail columns, transcript sections, quota context, action menus, and provider/model badges.
- Preserve dynamic custom properties for widths, fills, and placement.
- Keep fixed chrome dimensions separate from scalable data text.
- Remove Sessions rules from `legacy.css`.

Verification: sorting, paging, jump menu, row expansion, collapsed detail columns, source actions, loading and error states, keyboard use, and all viewport/data-scale combinations.

Stop when: table navigation, rendered HTML contracts, popover placement, or column scrolling regresses.

### 10. Migrate Explorer

Files: `src/App.tsx`, `src/combo.ts`, `src/components/chart-pins.tsx`, `src/styles/views/explorer.css`, combo, effort, and chart-pin tests.

- Migrate composition panels, charts, legends, tooltips, filter-empty states, and effort views.
- Keep chart geometry values separate from typography tokens.
- Verify semantic series colours in Recharts before removing literal fallbacks.
- Remove Explorer rules from `legacy.css`.

Verification: empty and populated filters, hover and pinned tooltips, legends, chart axes, all effort combinations, custom accent, and reduced motion.

Stop when: chart labels clip, pinned tooltips move layers, or CSS-variable colours fail in SVG.

### 11. Migrate Projects

Files: `src/App.tsx`, `src/styles/views/projects.css`, `src/project-grouping.test.ts`, `src/model-slope.test.ts`, `src/chart-pins.test.ts`.

- Migrate project ranking, expanded details, session lists, slope charts, automation chips, and responsive rules.
- Preserve data-driven chart positioning inline.
- Remove Projects rules from `legacy.css`.

Verification: sorting, project expansion, session links, charts, narrow layouts, and data scaling.

Stop when: chart geometry, row hierarchy, or expanded-detail ordering changes.

### 12. Migrate Data

Files: `src/App.tsx`, `src/views/data/*.tsx`, `src/components/token-types.tsx`, `src/styles/views/data.css`, token, quota, and effort tests.

- Migrate the Data landing view and all analysis panels.
- Keep serif use only where it remains an intentional score treatment.
- Apply one table and one caption system across the data modules.
- Test token-type colours and provider colours after centralization.
- Remove Data rules from `legacy.css`.

Verification: every Data subsection, token tables, profiles, effort analysis, outliers, Warp ledger, missing-data states, and all viewport/data-scale combinations.

Stop when: a dense table cannot reflow at the supported scale or a panel loses its information hierarchy.

### 13. Migrate Overview last

Files: `src/App.tsx`, `src/scene.tsx`, `src/views/chrome.tsx`, `src/styles/views/overview.css`, `src/quick-overview.test.ts`, `src/scene.test.ts`, `src/App.test.ts`.

- Migrate hero, metric cards, quota panels, recent sessions, quick overview, and scene-adjacent layout.
- Keep the scene palette and canvas arithmetic independent from CSS-variable strings.
- Review whether repeated uppercase mono labels help navigation or merely add noise.
- Remove Overview rules from `legacy.css`.

Verification: live quota states, unavailable and stale states, hero scene, quick overview modes, collapsed sidebar, mobile layout, reduced motion, and custom appearance settings.

Stop when: animation suppression fails, quota meaning relies only on colour, or the hero and cards lose clear hierarchy.

### 14. Finish motion, elevation, and cleanup

Files: `src/styles/motion.css`, all migrated CSS files, `src/styles/legacy.css`, tests affected by intentional class changes.

- Replace the 26 untokenized transition declarations while preserving their current duration and easing first.
- Consolidate reduced-motion CSS into `motion.css`, imported last. Preserve the page-jump text fallback.
- Keep `App.tsx` smooth-scroll guards and both JavaScript reduced-motion listeners.
- Do not add View Transition API code in this migration.
- Review long Appearance dismissal animation separately. Do not shorten the loading spin by count-based search.
- Profile before claiming shadow performance. Apply panel, floating, and modal shadows according to hierarchy, not one shadow everywhere.
- Run CSS coverage through every recorded state.
- Delete `model-quick-links` and other selectors only when repository search and state-complete coverage agree.
- Delete `legacy.css` only when empty.
- Do not target zero inline styles or zero `!important`; remove only proven static layout styles and obsolete overrides.
- Record justified literal exceptions for chart geometry, canvas colours, icon dimensions, and data-driven styles.

Verification: full typecheck, tests, production build, CSS coverage, contrast checks, keyboard pass, reduced-motion pass, and the full screenshot matrix. Confirm the existing local app remains reachable without restarting a user-owned process.

Stop when complete:

- `legacy.css` is gone.
- Runtime Appearance settings persist and update computed tokens.
- Every view owns its CSS.
- Shared controls use the agreed type, spacing, radius, colour, and elevation roles.
- No unintended screenshot differences remain.
- All tests and the production build pass.
- Remaining raw values and `!important` uses are documented exceptions.

## Execution recommendation

Use Sol 5.6 high for steps 1–7, Sessions, motion, and final review. These phases require careful reasoning about runtime token ownership, cascade order, stacking contexts, and accessibility.

Terra is sufficient for isolated Models, Explorer, Projects, Data, and Overview migrations once the token and file contracts are stable. Run one view per task.

Likely long phases are the staged stylesheet split, Sessions, Data, Overview, and the 18-viewport visual matrix. Safe handoff points are after step 2, after semantic colours, after the initial split, after each completed view, and before final motion and cleanup.