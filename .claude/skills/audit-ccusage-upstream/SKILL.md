---
name: audit-ccusage-upstream
description: Compare the AI Usage Observatory's pinned ccusage dependency and integration with current ccusage releases and upstream development, assess upgrade distance, compatibility risk, migration work, and useful new features, then generate an evidence-linked dark HTML report. Use for ccusage upgrade audits, dependency freshness checks, release-impact reviews, requests to identify upstream ccusage capabilities the Observatory could adopt, or when the ccusage source-health entry says to run the audit-ccusage-upstream skill.
---

# Audit ccusage Upstream

Read [the audit workflow](../../../.agents/skills/audit-ccusage-upstream/SKILL.md)
and [its report contract](../../../.agents/skills/audit-ccusage-upstream/references/report-contract.md)
completely before taking any audit action. Treat them as the authoritative
workflow. The scripts they name live in
`.agents/skills/audit-ccusage-upstream/scripts/`; run them from the repository
root with the paths exactly as written there.

This file only makes the skill visible to Claude Code. Do not copy workflow
steps into it; change the workflow in `.agents/skills/` so Codex-compatible
agents and Claude Code always follow the same process.
