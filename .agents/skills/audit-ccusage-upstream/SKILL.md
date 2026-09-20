---
name: audit-ccusage-upstream
description: Compare the AI Usage Observatory's pinned ccusage dependency and integration with current ccusage releases and upstream development, assess upgrade distance, compatibility risk, migration work, and useful new features, then generate an evidence-linked dark HTML report. Use for ccusage upgrade audits, dependency freshness checks, release-impact reviews, requests to identify upstream ccusage capabilities the Observatory could adopt, or when the ccusage source-health entry says to run the audit-ccusage-upstream skill.
---

# Audit ccusage Upstream

Produce a decision-ready audit without changing the dependency or application code. Treat an already-current pin as a valid result and still check unreleased upstream changes and feature opportunities.

## Workflow

1. Read [references/report-contract.md](references/report-contract.md) completely.
2. Resolve the repository root and inspect the working tree. Preserve unrelated user changes.
3. Determine the pinned version from `package.json` and the resolved version from the lockfile and local binary. Record disagreements; do not silently choose one.
4. Inspect the local integration surface with the checklist in the report contract. It covers the files that call ccusage and the files that re-implement its rules (`server/effort-parse.ts`, `server/codex-replay.ts`, `server/rate-card.ts`, `src/provider.ts`). Find further references with `rg`.
5. Read the newest earlier audit in `reports/ccusage-audits/` and carry its open items forward as the contract describes.
6. Research current upstream state from primary sources. Check npm package metadata plus the ccusage repository, releases/tags, changelog or release notes, comparison view, relevant commits, and relevant open/closed issues. Include direct URLs in the evidence.
7. Separate findings into:
   - released changes between the pin and latest stable release;
   - unreleased changes on the upstream default branch;
   - upgrade work required by the Observatory;
   - optional upstream features the Observatory could use.
8. Compare behavior and numbers, not only version numbers. When a newer stable release exists, run both scripts. Each one takes about 10 to 60 seconds, reads local transcripts read-only, runs the candidate through `bunx` from a temporary directory, and never opens the application database:

```bash
bun run .agents/skills/audit-ccusage-upstream/scripts/compare-versions.ts <latest-stable> reports/ccusage-audits/YYYY-MM-DD/data-impact.json
bun run .agents/skills/audit-ccusage-upstream/scripts/verify-parser-parity.ts reports/ccusage-audits/YYYY-MM-DD/parity-pinned.json
bun run .agents/skills/audit-ccusage-upstream/scripts/verify-parser-parity.ts <latest-stable> reports/ccusage-audits/YYYY-MM-DD/parity-candidate.json
```

   Without a version, the parity script checks the pinned binary. Explain every row of the data impact with an upstream change, and treat a positive parity delta as required upgrade work. When the pin is already current, run the parity check against the pin alone. Also inspect CLI help for any flag that `server/ccusage.ts` uses and that the release notes mention.
9. Assess each change using the contract's complexity rubric. Cite a source or local file for every material claim. Label inferences as inferences.
10. Run the project's existing tests and type checks when they help verify compatibility. They run on fixtures and do not exercise a candidate release; never cite them as evidence that an upgrade is safe. Do not install, upgrade, or edit dependencies unless the user separately requests implementation.
11. Create `reports/ccusage-audits/YYYY-MM-DD/evidence.json` following the contract, with the script output pasted into `data_impact` and `parser_parity` (the candidate run when one exists), then render `index.html`:

```bash
bun run .agents/skills/audit-ccusage-upstream/scripts/render-report.ts \
  reports/ccusage-audits/YYYY-MM-DD/evidence.json \
  reports/ccusage-audits/YYYY-MM-DD/index.html
```

12. Open or inspect the rendered report enough to verify layout, links, escaping, and content. If browser tooling is unavailable, run the renderer's validation and inspect the generated HTML directly.
13. Return the report path and a concise headline: current/behind, overall complexity, the largest data-impact row, the parity result, and the recommended next action.

## When the user then asks for the upgrade

The audit itself changes nothing. If the user asks to apply the upgrade afterward:

- Update the pin with `bun add --exact ccusage@<version>` and update the two version mentions in `README.md`.
- Port every mirrored rule that parity flagged, bump `PARSER_VERSION` in `server/effort-parse.ts`, and re-run the parity script until Codex is exact.
- The user's `bun run dev` uses `bun --watch`, so it re-indexes with unfinished parser code as soon as `PARSER_VERSION` changes. Bump the version one more time when the code is final, so the index rebuilds with the finished rules.
- After the rebuild, confirm `reconciliationDeltaTokens` is 0 on `/api/effort` for a range that the data impact restated.

## Shell notes

- The user's shell is zsh, which does not word-split an unquoted variable. Pass ccusage flags as separate words or as an array (`A=(daily --json); ccusage "${A[@]}"`), never as one string.
- Run `gh` from inside the repository so the account-routing hook can read the origin.

## Evidence Rules

- Prefer npm and the upstream GitHub repository over aggregators or search snippets.
- Use absolute, direct links to releases, commits, comparisons, issues, documentation, and package metadata.
- Record retrieval time because upstream state changes.
- Distinguish observed facts, local code observations, and inferred impact.
- Report numbers from the two scripts, never from memory of an earlier audit; upstream restates history.
- Never claim a feature is adoptable until its output or API fits the Observatory's local-only and normalized-data boundaries.
- Surface missing access, absent changelogs, ambiguous tags, failed commands, and other limitations in the report.

## Output Quality

- Keep the HTML self-contained: inline CSS, no remote fonts, scripts, trackers, or assets.
- Use the renderer instead of hand-authoring report markup.
- Make recommendations specific: upgrade now, wait, prototype separately, or no action.
- Link affected local files in the report using repository-relative paths; link upstream evidence with HTTPS URLs.
- Do not create upgrade commits or modify production code as part of the audit.
