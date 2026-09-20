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

`gh issue list` can return nothing for this repository. When it does, query the search API and record the query in `limitations` if it also returns nothing:

```bash
gh api -X GET search/issues -f q='repo:ccusage/ccusage is:issue is:open codex OR claude OR pricing OR json' -f per_page=20 \
  -q '.items[] | "#\(.number) \(.created_at[0:10]) \(.title)"'
```

## Local surface checklist

Review every file below and give each one a `local_surface` row. The first group calls ccusage. The second group re-implements ccusage behavior, so a release can break it while the JSON contract and the test suite stay unchanged.

| File | What depends on ccusage |
| --- | --- |
| `server/ccusage.ts` | Commands, flags, exit codes, `--version` output, the tokens-without-cost rule in `findUnpricedModels` |
| `server/schema.ts` | Zod shape of the unified and blocks reports |
| `server/collector.ts` | Session identity (`agent:period`), `metadata.lastActivity`, source-health text |
| `server/ccusage-upstream.ts` | The in-app staleness signal that sends the user to this skill |
| `server/effort-parse.ts` | Mirrors Claude and Codex usage rules: duplicate events, cumulative-total suppression, fork replay |
| `server/codex-replay.ts` | Mirrors the Codex parent-prefix and rewritten-burst rules; reads `forked_from_id` and `parent_thread_id` |
| `server/rate-card.ts` | Mirrors the ccusage model-name lookup order; splits a ccusage cost, so a pricing-rule change can fail the split validation |
| `server/path-indexer.ts` | Native session keys that must equal the session keys ccusage reports |
| `src/provider.ts` | `providerFromAgent` maps agent labels; a new label maps to unknown until it is added |

Search the release notes for every adapter the machine has data for (`claude`, `codex`, and any agent label in `data_impact.agents_added`). For each dedupe, replay, session-scoping, or pricing fix, name the local file above that mirrors the old behavior, or state that none does.

## Data impact

`scripts/compare-versions.ts <candidate>` produces the `data_impact` object. Copy it into the evidence file unchanged. Read it as follows:

- `contract`: a removed key or a failing `candidate_zod` makes the upgrade `medium` or `high`. An added key is an opportunity, not a requirement.
- `by_agent`, `by_model`, `by_month`: rows appear only when cost moves by $0.01 or more, or tokens move at all. For every row, find the upstream change that explains it and cite it in a `released_changes` entry. Put a delta you cannot explain in `limitations`. An agent whose token total is unchanged while its models move means upstream changed model attribution, not counting.
- `sessions.removed` above 0 breaks annotations and path joins that key on the session; rate it `high` until explained.
- `agents_added` with provider `unknown` needs a `src/provider.ts` decision.
- `unpriced_models.candidate` must not grow.

A release that restates history is not a defect. State the direction and size in `assessment.summary`, because the user will see past months change.

## Parser parity

`scripts/verify-parser-parity.ts [candidate]` produces the `parser_parity` object. It runs the real effort parser over every local transcript against a throwaway database and compares month totals with ccusage.

- A positive delta means the parser counts tokens that ccusage does not. `server/effort-api.ts` suppresses those effort days, so the upgrade ships a regression unless the parser is ported in the same change. Rate the upgrade at least `medium` and list the parser port in `required_work`.
- A negative delta means the parser misses tokens. The app shows them as unattributed; record the size, and treat growth against the previous audit as a finding.
- Codex was exact against 20.0.23 on 2026-09-20. Claude was 0.06% to 0.12% under for the two most recent months.
- Run it against the pinned version first. A delta that exists before the upgrade is not caused by the upgrade.

## Previous audit

Read the newest earlier `reports/ccusage-audits/*/evidence.json`. Carry forward every `watch` or `prototype` opportunity and every limitation, and state for each one whether it is resolved, unchanged, or dropped. Compare `parser_parity` and `data_impact.totals` with the earlier values when both exist.

## Complexity rubric

- `none`: no released upgrade is available and no work is required.
- `low`: pin/lockfile update plus routine verification; the JSON contract is unchanged and parser parity shows no positive delta. Restated totals alone do not raise the rating.
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
  "data_impact": { "pinned": "20.0.17", "candidate": "20.0.23", "contract": {}, "totals": {}, "by_agent": [], "by_model": [], "by_month": [], "sessions": {}, "agents_added": [], "agents_removed": [], "unpriced_models": {} },
  "parser_parity": { "reference": "20.0.23", "parser_version": 8, "codex": { "exact": true, "months": [] }, "claude": { "exact": false, "months": [] } },
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

`data_impact` and `parser_parity` are optional for the renderer but required by the workflow. Paste the script output; do not hand-write either object. When a script cannot run, omit the object, add a `blocked` validation row, and rate complexity `unknown`.

Do not put raw session data, prompts, responses, access tokens, or lengthy command output in this file. The two script outputs hold totals, model names, and agent labels only.
