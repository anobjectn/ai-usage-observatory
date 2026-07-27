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

During preparation, inspect the README's project-at-a-glance badge group. Verify
each badge against its local source of truth, including the target version. If
the group is missing or inaccurate, include a proposed README update in the
review bundle and release mutations. Do not create or edit badges until the user
approves the complete bundle and exact version.

Treat a new release request or version number as preparation, not approval.
Execute only after the user explicitly approves the complete review bundle and
exact version.
