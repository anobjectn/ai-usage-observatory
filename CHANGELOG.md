# Changelog

All notable changes to AI Usage Observatory are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Show recorded quota-reset usage details and provider quota events on activity
  timelines.

### Changed

- Rename the Limits & sources view to Sources while preserving legacy links.
- Add provider token totals beneath activity dates and clarify project chart
  labels and layout.

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

[Unreleased]: https://github.com/anobjectn/ai-usage-observatory/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/anobjectn/ai-usage-observatory/releases/tag/v1.0.0
