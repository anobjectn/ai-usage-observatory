# Report contract

## Research checklist

Capture the following primary sources when available:

- npm package page and registry metadata: `https://www.npmjs.com/package/ccusage`
- upstream repository: `https://github.com/ccusage/ccusage`
- releases: `https://github.com/ccusage/ccusage/releases`
- tags and the exact pinned-to-latest comparison URL
- upstream changelog or release notes, if present
- commits after the latest release for unreleased work
- issues or pull requests directly relevant to commands, output shapes, supported agents, pricing, offline behavior, or regressions used by the Observatory

Inspect local dependency declarations, lock resolution, the installed CLI version, adapter commands and flags, Zod contracts, normalized collector output, session identity assumptions, tests, docs, and user-facing attribution.

## Complexity rubric

- `none`: no released upgrade is available and no work is required.
- `low`: pin/lockfile update plus routine verification; no known contract or behavior changes.
- `medium`: localized adapter/schema/test changes or a small migration with clear compatibility behavior.
- `high`: breaking JSON or identity changes, cross-cutting data-model/UI changes, privacy-boundary changes, or uncertain migration behavior.
- `unknown`: evidence is insufficient. State what would resolve the uncertainty.

Rate optional opportunities independently from upgrade complexity. A useful new feature may be high effort without making the version upgrade itself high risk.

## Evidence JSON

Write UTF-8 JSON with this shape. Fields marked optional may be omitted; arrays may be empty.

```json
{
  "metadata": {
    "title": "ccusage upstream audit",
    "generated_at": "2026-07-19T15:00:00-04:00",
    "repository": "AI Usage Observatory",
    "upstream_repository": "ccusage/ccusage"
  },
  "versions": {
    "pinned": "20.0.17",
    "resolved": "20.0.17",
    "installed": "20.0.17",
    "latest_stable": "20.0.17",
    "latest_upstream_commit": "optional short SHA",
    "status": "current",
    "released_versions_behind": 0
  },
  "assessment": {
    "complexity": "none",
    "recommendation": "No dependency upgrade is needed.",
    "summary": "The project matches the latest stable release; review the unreleased items below."
  },
  "sources": [
    {"label": "ccusage releases", "url": "https://github.com/ccusage/ccusage/releases", "note": "Release history"}
  ],
  "released_changes": [
    {
      "title": "Example released change",
      "version": "20.1.0",
      "date": "2026-08-01",
      "category": "JSON contract",
      "summary": "Observed upstream change.",
      "impact": "Inferred effect on the Observatory.",
      "complexity": "medium",
      "required_work": ["Update the affected schema", "Add a regression fixture"],
      "affected_files": ["server/schema.ts"],
      "evidence": [{"label": "Release", "url": "https://github.com/ccusage/ccusage/releases/tag/v20.1.0"}]
    }
  ],
  "unreleased_changes": [],
  "opportunities": [
    {
      "title": "Feature name",
      "value": "User or maintenance benefit.",
      "fit": "How it fits the normalized local-only architecture.",
      "effort": "low",
      "recommendation": "adopt",
      "required_work": [],
      "evidence": []
    }
  ],
  "issues": [
    {"title": "Relevant issue", "number": 123, "state": "open", "relevance": "Why it matters", "url": "https://github.com/ccusage/ccusage/issues/123"}
  ],
  "local_surface": [
    {"path": "server/ccusage.ts", "role": "CLI invocation boundary", "risk": "high", "notes": "Flags and JSON shapes are compatibility-sensitive."}
  ],
  "validation": [
    {"check": "bun test", "status": "passed", "notes": "Existing suite passed."}
  ],
  "limitations": []
}
```

Allowed `versions.status` values: `current`, `behind`, `ahead`, `diverged`, `unknown`.

Allowed complexity, effort, and risk values: `none`, `low`, `medium`, `high`, `unknown`.

Allowed opportunity recommendations: `adopt`, `prototype`, `watch`, `skip`.

Allowed validation statuses: `passed`, `failed`, `not-run`, `blocked`.

Do not put raw session data, prompts, responses, access tokens, or lengthy command output in this file.
