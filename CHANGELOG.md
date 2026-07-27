# Changelog

All notable changes to AI Usage Observatory are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-07-26

### Added

- Rebuild the Sources view around provider-specific allowance intelligence,
  including graded capture profiles, quota signals, efficiency measures, usage
  outliers, and session facets.
- Add a deterministic, tab-free Data screenshot capture and release archiving
  command.

### Changed

- Refresh the README Data screenshot and preserve its reviewed v1.5.0 copy in
  the changelog.

### Fixed

- Balance the subscription-allowance explanation text without changing other
  section descriptions.

### Screenshots

<a href="docs/screenshots/releases/v1.5.0/6.data-intelligence.png">
  <img src="docs/screenshots/releases/v1.5.0/6.data-intelligence.png" width="100%" alt="Data view with provider-specific allowance intelligence">
</a>

## [1.4.0] - 2026-07-25

### Added

- Surface Anthropic usage credits, prepaid balance, and credit provenance from
  quota-service across the Overview and Sources views (usage-credit spend,
  prepaid balance, and a grouped Fable transition credit; money formatted per
  each object's currency).
- Add a Claude Web credit import workflow: a localhost-proxied modal, launchable
  from the Overview card and Sources, that updates the imported credit snapshot
  and refreshes the dashboard on success. It never handles browser credentials,
  and a rejected import leaves prior data intact.
- Expand the Sources quota card into three evidence groups — live provider API,
  imported Claude Web credits (with the 403 boundary and support links), and
  local quota history — each with bounded, scrollable raw evidence.
- Track imported-credit freshness (aging at 24h, stale at 7d) independently of
  live provider freshness.

### Removed

- Remove the unused Personal Budget card and its month/target computations from
  the Sources view. The stored monthlyBudget setting is retained so the panel
  can be reinstated later without data loss.

## [1.3.0] - 2026-07-25

### Added

- Add a Tesseract core scene effect (Appearance, on by default, toggleable)
  that replaces the telescope icon with a 4D hypercube at the sphere's center,
  contorting through its 4D rotations as the scene is dragged or auto-rotates.
- Restyle the sidebar collapse toggle as a border tab and add a version label.

### Fixed

- Stop the navigation icon from flex-shrinking, which collapsed the active
  item's icon to zero width in the collapsed sidebar (its dot indicator
  consumed the remaining row space) and undersized the others.
- Center the local-status dot and keep the Path rules icon full size and
  centered in the collapsed sidebar instead of shrinking and left-biasing them.
- Keep the active navigation item's icon and label legible with dark accent
  colors by lifting the active color toward the foreground instead of using
  the raw accent, which turned dark on the dark sidebar.
- Use live ccusage pricing instead of the bundled offline table, and surface
  unpriced models with a global banner, per-model indicators, and a degraded
  source-health status so cost gaps are visible rather than silently zero. This
  fixes the missing Opus 5 API-equivalent cost, which the offline table lacked
  and previously counted as zero.
- Separate latest-session row actions on the Overview.
- Stop sidebar icons shifting on collapse by fading labels instead of snapping.

## [1.2.0] - 2026-07-21

### Added

- Add a Show cache control to include or exclude cache reads and writes from
  applicable usage totals, charts, and model breakdowns.

### Changed

- Group Explorer token composition into direct-token and cache-traffic sections.
- Improve the README, including a linked screenshot gallery marked as v1.0.0
  screens.
- Rename the project-detail “Records” label to “Runs.”

## [1.1.0] - 2026-07-21

### Added

- Show recorded quota-reset usage details and provider quota events on activity
  timelines.
- Add a reviewed repository release workflow for Codex and Claude Code with
  explicit approval gates.

### Changed

- Rename the Limits & sources view to Sources while preserving legacy links.
- Add provider token totals beneath activity dates, clarify project chart
  labels and layout, and segment project token bars by provider.

### Fixed

- Keep quota-event labels legible when multiple markers share a timestamp.

## [1.0.0] - 2026-07-20

### Added

- Add Overview, Explorer, Sessions, Projects, Models, and data-provenance views
  for local AI coding usage.
- Ingest daily, weekly, monthly, session, project-instance, and five-hour-block
  analytics from pinned `ccusage@20.0.17` data.
- Show token composition, API-equivalent cost, model mix, provider activity,
  project attribution, and session drilldowns.
- Add linked date, provider, and derived-path filters with retroactive glob and
  regular-expression path rules.
- Index Claude Code and Codex session metadata for project paths without storing
  prompt or response content.
- Support manual session tags and notes.
- Integrate optional, read-only provider allowance data from `quota-service`,
  including allowance windows, reset credits, and source health.
- Add configurable appearance controls, reduced-motion support, and an
  interactive Observatory scene.

### Changed

- Optimize dashboard refreshes and session-detail loading while retaining the
  last successful data snapshot when a refresh fails.

### Fixed

- Correct path- and date-filtered totals, session extraction, navigation and
  modal behavior, project controls, and accessibility focus states.

[Unreleased]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/anobjectn/ai-usage-observatory/releases/tag/v1.0.0
