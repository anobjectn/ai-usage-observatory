# Design system migration — PLAN

Slug: design-system-migration · Date: 2026-09-05
Author: Claude Fable 5.1 (medium)

> Persisted from the design-system audit written earlier today. Sections 1–2 are findings; sections 3–5 are the plan under review.


**Status:** Audit only; input to a future design-update plan
**Date:** 2026-09-05
**Baseline:** `main` @ `7e4f877` plus the Models table change in the working tree
**Scope:** `src/styles.css` (1,062 lines, 1,908 rule blocks), colour tables in `src/*.ts(x)`, and the
Appearance settings that write tokens at runtime. Counts below come from grepping the stylesheet;
they are exact for the file at this baseline and will drift.

## Summary

The app has a real token layer, but it covers only part of the surface. Colour is mostly
tokenised. Type, spacing, radius, shadow, and z-index are not. About 87% of type sizes are hard
pixel values, so the Appearance text-scale setting reaches roughly one declaration in eight. A
design update that wants to change "all captions" or "all card radii" today is a grep across
one 190 KB file with 22 lines longer than 1,500 characters.

The recommendation is a token-first migration: add the missing scales with no visual change,
then move the ten or so implicit primitives onto them, then walk the views. Each step is
verifiable with per-view screenshots and leaves the app shippable.

## 1. What the token layer holds today

Defined in `:root` (`src/styles.css:1-47`):

| Group | Tokens | Notes |
| --- | --- | --- |
| Type families | `--sans-font`, `--serif-font`, `--mono-font`; roles `--font-body`, `--font-heading`, `--font-label`; `--font-weight-medium` | Heading and body share Avenir Next. Serif is used 6 times (Data view scores). |
| Colour | `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--line`, `--line-bright`, `--text`, `--muted`, `--dim`, `--accent`, `--anthropic-color`, `--openai-color`, `--warp-color`, `--aqua`, `--orange`, `--violet`, `--red` | Accent and provider colours are rewritten at runtime by the Appearance modal. |
| Shape | `--radius` (16px), `--shadow` | Used 3 and 4 times respectively. |
| Data type scale | `--data-text-scale` and derived `--data-text-primary/secondary/compact/strong` | Set from the Appearance text-scale stepper; 57 usages. |
| Motion | `--ease-standard/decelerate/accelerate/sidebar`, `--duration-speedy/base/slow/sidebar`, `--link-underline-offset` | Added by the UI polish plan (§5). 23 transitions use them; 28 still hard-code. |

Missing entirely: spacing scale, radius scale, shadow scale, z-index layers, breakpoints
documented as tokens, status/trend colours, and a general (non-data) type scale.

## 2. How tokens are applied

### Type

| Measure | Count |
| --- | --- |
| `font:` shorthand declarations | 338 |
| ...with a hard px size | 285 |
| ...using a `--data-text-*` token | 35 |
| `font-size:` declarations | 160 |
| ...hard px | 125 |
| ...token | 33 |
| Distinct px sizes in use | 35 (4, 5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.25, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 18, 19, 22, 24, 25, 27, 28, 31, 34, 36, 38, 44, 52, 70) |
| Most common sizes | 10px ×121, 9px ×90, 8px ×29, 11px ×19, 12px ×43 |
| `var(--font-label)` (mono) usages | 319 |
| `text-transform: uppercase` | 78 |
| Distinct `letter-spacing` values | 10 (.02, .04, .05, .06, .07, .08, .1, .12, .15em and negatives) |

Reading: there is no type scale. Sizes are chosen per rule, and the two most common sizes are
below the 11px floor the visual audit recommended. The mono face is the de facto UI face for
labels, captions, chips, table headers, and help text, which is why the app reads dense. The
`.overline` primitive is defined at 10px, then redefined at 9px in two scoped places.

### Colour

| Measure | Count |
| --- | --- |
| `var(--accent)` | 235 |
| `var(--dim)` / `var(--muted)` / `var(--text)` | 210 / 105 / 105 |
| `var(--line)` / `var(--line-bright)` | 194 / 76 |
| `var(--surface)` / `-2` / `-3` | 53 / 16 / 31 |
| `color-mix(...)` | 131 |
| Raw hex values in CSS | 33 distinct; `#07100f` ×15 (equals `--bg`), `#000` ×11, `#0a1311` ×5, `#101a18` ×4 |
| `rgba(7,16,15,α)` variants | 8 alphas of the background colour |
| `rgba(0,0,0,α)` variants | 12 alphas |

Colour is the best-covered axis, but the semantic split is weak. `--accent` carries five jobs:
interactive state, links, eyebrow text, up-trend arrows, and the Medium effort level. `--orange`
is the default Anthropic colour, the down-trend colour, the High effort level, and the warning
state. There are no `--up`, `--down`, `--warn`, `--danger` tokens; the visual audit's "colour
roles collide" finding is a direct consequence.

Colour tables also live in TypeScript:

| File | What | Form |
| --- | --- | --- |
| `src/App.tsx:255` | `palette` (6 series colours), `defaultAccent`, `defaultProviderColors`, `defaultFavoriteAccents` | hex |
| `src/components/token-types.tsx:15` | token-type colours | hex, duplicating four `palette` entries |
| `src/combo.ts:60` | `fixedEffortColors` (var refs), `fixedFamilyColors` (var refs plus one hex) | mixed |
| `src/scene.tsx` | starfield and orrery shading | 9 hex |

Anything that changes the palette has to change it in three places, and the token-type colours
cannot follow a user's accent because they are hex.

### Shape, elevation, spacing

| Measure | Count |
| --- | --- |
| Distinct `border-radius` literals | 20 (10px ×22, 9px ×20, 11px ×13, 7px ×12, 8px ×11, 4px ×11, 6px ×10, 999px ×9, 2px ×8, 12px ×8, 99px ×6, 5px ×6, ...) |
| `var(--radius)` | 3 |
| `box-shadow` declarations | 45; `var(--shadow)` 4; the default is `0 24px 80px rgba(0,0,0,.28)` |
| `backdrop-filter` | 5 |
| Distinct `gap` values | 20 (1px to 28px; 8/10/12/6/7/5 most common) |
| Distinct `padding` combinations | 20+ |

No radius, spacing, or elevation scale exists. Adjacent controls use 9px, 10px, and 11px radii
by accident of authoring date. The 80px-blur shadow on every panel is the single most expensive
paint cost in the app and is not switchable.

### Layout and layers

| Measure | Count |
| --- | --- |
| Distinct media queries | 15 breakpoints: 400, 480, 520, 620 (×14), 720 (×4, one with a stray space), 760, 900 (×8), 1100, 1180, 1240, 1520 plus min-width pairs |
| Distinct `z-index` values | 19 (0, 1, 2, 3, 4, 15, 19, 20, 25, 30, 31, 40, 45, 50, 55, 75, 80, 90, 95) |
| `!important` | 69 |

Two breakpoints are real (620 and 900); the rest are per-component patches. Nineteen z-index
values means stacking bugs are solved by picking a bigger number.

### File structure and conventions

- One file, ordered by the date each feature landed, with 47 section comments. Related rules
  for one component are often 300 lines apart (Models table rules were at lines 202, 451, 531,
  537, 553-560, 765-775, 1029-1031, and 1061 before this change).
- 22 lines exceed 1,500 characters; the longest is 8,359. Diffs on these lines are unreadable.
- Three state conventions coexist: `.active`, `.is-open`, and `--open`.
- Three naming conventions coexist: BEM (`.agent-filter__menu-head`), element chains
  (`.model-sessions a b`), and bare utilities (`.num`, `.sr-only`).
- Dead rules exist (`.model-quick-links` has no JSX counterpart). A coverage pass would find more.
- 36 inline `style={{}}` in `App.tsx`; most carry data colours, which is fine, a few carry
  layout, which should move to CSS.

### What the Appearance setting can and cannot reach

`AppearanceModal` writes `--accent`, the three provider colours, and `--data-text-scale`. The
scale reaches the four `--data-text-*` tokens only. Every caption, eyebrow, chip, table header,
axis label, and tooltip is fixed at its authored px size, so the "Text size" control changes
the numbers in tables and leaves the labels around them small.

## 3. Recommended token structure

Add these with no visual change first. Every value below is the current de facto value or its
nearest scale neighbour, so the migration step that swaps literals for tokens is a no-op
visually and a screenshot diff can prove it.

```css
/* Colour: semantic names, provider hues, status hues kept apart. */
--color-bg, --color-surface-1, --color-surface-2, --color-surface-3
--color-line, --color-line-strong
--color-text, --color-text-muted, --color-text-dim
--color-accent            /* interactive only: focus, active, links */
--color-anthropic, --color-openai, --color-warp
--color-up, --color-down, --color-warn, --color-danger, --color-info
--color-series-1..6       /* replaces the App.tsx palette and token-types hex */

/* Type: one modular scale, roles on top. */
--type-scale-ui: 1        /* user setting, drives the whole UI */
--type-scale-data: 1.25   /* existing data setting */
--text-2xs: 11px  --text-xs: 12px  --text-sm: 13px  --text-md: 15px
--text-lg: 18px   --text-xl: 22px  --text-2xl: 28px --text-3xl: 36px  --text-4xl: 44px
--label: font for eyebrows and table headers (mono, --text-2xs, tracking .06em)
--caption: sans, --text-xs, --color-text-dim
--data: mono, tabular-nums, --text-sm × --type-scale-data

/* Space: 4px base. */
--space-1: 4px … --space-8: 32px

/* Shape and elevation. */
--radius-1: 4px (chips)  --radius-2: 8px (controls)  --radius-3: 12px (inner cards)
--radius-4: 16px (panels)  --radius-pill: 999px
--shadow-panel: 0 1px 0 rgba(255,255,255,.03) inset, 0 8px 24px rgba(0,0,0,.18)
--shadow-popover: 0 20px 48px rgba(0,0,0,.58)

/* Layers. */
--z-raised: 1  --z-sticky: 10  --z-overlay: 40  --z-popover: 60  --z-modal: 80

/* Breakpoints cannot be vars; document them and use only these. */
/* 620 phone, 900 sidebar collapse, 1180 three-column */
```

Typographic patterns to formalise as classes, replacing the per-rule fonts:

| Role | Today | Target |
| --- | --- | --- |
| Eyebrow / table header | `.overline` 10px mono, redefined at 9px twice; 78 ad hoc uppercase rules | `.label` once; uppercase only here |
| Caption / help | 9-10px mono in 100+ rules | `.caption` sans 12px dim |
| Data value | mixed 9-25px mono | `.data` 13-15px mono tabular, scaled by the data setting |
| Panel title | `h2` 18px | `h2` = `--text-lg` |
| Page title | `h1` 44px / clamp | `h1` = `--text-4xl` |
| Body | 12-14px sans | `--text-sm` / `--text-md` |

## 4. Migration order

1. **Tokens (no visual change).** Add the scales above beside the existing tokens. Replace
   literals whose value already equals a token (`#07100f` → `--color-bg`, 16px radius →
   `--radius-4`, `10px var(--font-label)` → `--label`). Prove with screenshot diff.
2. **Primitives.** `.overline`/`.label`, `.panel` + `.panel-heading`, `.segmented`, `.search`,
   `.method-chip`, `.split-pill`, `.effort-badge`, `.agent-pill`, `.sort-header`,
   `.session-detail-toggle`, `.text-link`, `.ghost-button`, `.primary-button`, `.empty`.
   Give each one rule block, token-driven sizes, and one state convention (`is-*`).
3. **Colour roles.** Introduce `--color-up/down/warn` and re-point trend arrows, warnings, and
   effort levels away from `--accent` and `--orange`. Move `palette`, token-type colours, and
   family colours to read `--color-series-*`.
4. **File split.** `styles/tokens.css`, `base.css`, `primitives.css`, `chrome.css`,
   `views/*.css`, imported from `main.tsx`. One declaration block per line. Delete dead rules.
5. **Views, one at a time.** Models (already token-based after this change), Sessions,
   Explorer, Projects, Data, Overview last. Raise the floor to `--text-2xs` as each is touched.
6. **Elevation and motion.** Swap `--shadow` for `--shadow-panel`, finish the 28 remaining
   hard-coded transitions, shorten the two 1,000ms animations.

## 5. Verification for each step

- `bun run typecheck`, `bun test`, `bun run build`.
- Headless Chrome captures of the six views at 1440, 1024, and 390 wide, compared against the
  previous step. `scripts/capture-data-screenshot.ts` has the invocation to copy.
- A CSS coverage run in DevTools on the six views to catch dead rules after the split.

## Related

- `docs/plans/todo/ui-polish-batch-PLAN-REVISED.md` §5 introduced the motion tokens and
  explicitly deferred migrating existing transitions; step 6 above completes it.
- The Models table (`src/App.tsx` `Models`, `.model-table` rules) is the reference for the
  target pattern: every size in it is a `--data-text-*` token, states use one class
  (`.model-row--open`), and the rules live in one block.
