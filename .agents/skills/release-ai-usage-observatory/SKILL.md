---
name: release-ai-usage-observatory
description: Plan, recommend, review, and publish AI Usage Observatory releases. Use whenever the user asks to make, start, prepare, approve, revise, or publish a project release; asks for the next version recommendation; provides a version to release; or mentions the project release skill. Trigger for requests such as "Let's make a new release now", "What should the next version be?", "Release 1.1.0", or "use our release skill".
---

# Release AI Usage Observatory

Read [the project release process](../../../docs/RELEASING.md) completely before
taking release-related action. Treat it as the authoritative workflow.

Do not require the user to cite the runbook or repeat its instructions. Apply its
preparation phase, review gate, execution procedure, routing rules, and stop
conditions automatically.

Every release must update `CHANGELOG.md` and the README project-at-a-glance
badge group. During preparation, draft the exact dated changelog section, set
the Version badge to the approved target, and verify every other badge against
its local source of truth. Include both exact changes in the review bundle and
release mutations. Do not omit either file, even when the non-version badges
remain accurate. Apply them only after approval.

Treat a new release request or version number as preparation, not approval.
Execute only after the user explicitly approves the complete review bundle and
exact version.
