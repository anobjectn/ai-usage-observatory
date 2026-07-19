---
name: audit-ccusage-upstream
description: Compare the AI Usage Observatory's pinned ccusage dependency and integration with current ccusage releases and upstream development, assess upgrade distance, compatibility risk, migration work, and useful new features, then generate an evidence-linked dark HTML report. Use for ccusage upgrade audits, dependency freshness checks, release-impact reviews, or requests to identify upstream ccusage capabilities the Observatory could adopt.
---

# Audit ccusage Upstream

Produce a decision-ready audit without changing the dependency or application code. Treat an already-current pin as a valid result and still check unreleased upstream changes and feature opportunities.

## Workflow

1. Read [references/report-contract.md](references/report-contract.md) completely.
2. Resolve the repository root and inspect the working tree. Preserve unrelated user changes.
3. Determine the pinned version from `package.json` and the resolved version from the lockfile and local binary. Record disagreements; do not silently choose one.
4. Inspect the local integration surface. At minimum, review:
   - `server/ccusage.ts`
   - `server/schema.ts`
   - `server/collector.ts`
   - related tests, types, documentation, and UI references found with `rg`
5. Research current upstream state from primary sources. Check npm package metadata plus the ccusage repository, releases/tags, changelog or release notes, comparison view, relevant commits, and relevant open/closed issues. Include direct URLs in the evidence.
6. Separate findings into:
   - released changes between the pin and latest stable release;
   - unreleased changes on the upstream default branch;
   - upgrade work required by the Observatory;
   - optional upstream features the Observatory could use.
7. Compare behavior, not only version numbers. Inspect CLI help and JSON output contracts for every command and flag used by `server/ccusage.ts`. When safe and available, run the pinned and candidate versions with `--json --offline`, retain only structural observations, and do not copy prompts or response content into the report.
8. Assess each change using the contract's complexity rubric. Cite a source or local file for every material claim. Label inferences as inferences.
9. Run the project's existing tests and type checks when they help verify compatibility. Do not install, upgrade, or edit dependencies unless the user separately requests implementation.
10. Create `reports/ccusage-audits/YYYY-MM-DD/evidence.json` following the contract, then render `index.html`:

```bash
python3 .agents/skills/audit-ccusage-upstream/scripts/render_report.py \
  reports/ccusage-audits/YYYY-MM-DD/evidence.json \
  reports/ccusage-audits/YYYY-MM-DD/index.html
```

11. Open or inspect the rendered report enough to verify layout, links, escaping, and content. If browser tooling is unavailable, run the renderer's validation and inspect the generated HTML directly.
12. Return the report path and a concise headline: current/behind, overall complexity, and recommended next action.

## Evidence Rules

- Prefer npm and the upstream GitHub repository over aggregators or search snippets.
- Use absolute, direct links to releases, commits, comparisons, issues, documentation, and package metadata.
- Record retrieval time because upstream state changes.
- Distinguish observed facts, local code observations, and inferred impact.
- Never claim a feature is adoptable until its output or API fits the Observatory's local-only and normalized-data boundaries.
- Surface missing access, absent changelogs, ambiguous tags, failed commands, and other limitations in the report.

## Output Quality

- Keep the HTML self-contained: inline CSS, no remote fonts, scripts, trackers, or assets.
- Use the renderer instead of hand-authoring report markup.
- Make recommendations specific: upgrade now, wait, prototype separately, or no action.
- Link affected local files in the report using repository-relative paths; link upstream evidence with HTTPS URLs.
- Do not create upgrade commits or modify production code as part of the audit.
