# Changelog

All notable changes to AI Usage Observatory are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/anobjectn/ai-usage-observatory/releases/tag/v1.0.0
