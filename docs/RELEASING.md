# Release process

This project uses Semantic Versioning, a Keep a Changelog-style `CHANGELOG.md`,
annotated Git tags, and GitHub Releases. The version in `package.json` must
match the latest release tag. There is no package-registry publication step and
no automated release workflow.

## Invocation and approval model

Repository-local `release-ai-usage-observatory` skills expose this process to
Codex-compatible agents from `.agents/skills/` and Claude Code from
`.claude/skills/`. A user may start it with natural language such as:

- "Let's make a new release now."
- "What version should the next release be?"
- "Release 1.1.0."
- "Let's make a new release using our release skill."

Codex can also invoke `$release-ai-usage-observatory`; Claude Code can invoke
`/release-ai-usage-observatory`.

The initial request starts a read-only preparation phase. The agent recommends
or validates the version, drafts the changelog and GitHub Release notes, lists
the included changes and planned mutations, then pauses for review. It must not
edit release files, commit, tag, push, or publish during preparation.

The review bundle must contain:

- the recommended or requested version and its rationale;
- the included commit range and categorized change summary;
- the exact proposed changelog section;
- the exact proposed GitHub Release notes;
- breaking changes, migrations, and upgrade notes, explicitly saying when there
  are none;
- the verification commands and release mutations that execution will perform.

Execution begins only after the user explicitly approves this complete bundle
and its exact version. If any detail changes, the agent must present the revised
bundle and obtain approval again.

## Agent guardrails

An agent performing a release must:

- Recommend a Semantic Version when none is supplied: major for breaking
  changes, minor for backward-compatible features, and patch for fixes only.
- Never execute until the user explicitly approves the exact target version and
  complete review bundle.
- Release only from `main`, with a clean working tree that matches
  `origin/main`.
- Use `git-identity-routing` before the release commit.
- Use `github-account-routing` before any GitHub CLI or API action.
- Stop if identity routing is unmapped or mismatched, the branch has diverged,
  the target tag already exists locally or remotely, verification fails, or
  release scope is unclear.
- Never move or reuse a published tag. Correct a released defect with a new
  patch release.

The named routing skills may not exist in every agent client. Regardless of
client, enforce their project mappings:

- Origin host `github.com`: commit as
  `Luis Ortiz <2839770+anobjectn@users.noreply.github.com>` and use GitHub CLI
  account `anobjectn`.
- Origin host `github.com-troyweb`: commit as
  `Luis Ortiz <luis.ortiz@troyweb.com>` and use GitHub CLI account
  `anobjectw`.

Read the origin rather than inferring from repository or organization names.
Stop and ask if the origin host is absent or unmapped. Verify `git config
user.name` and `git config user.email` immediately before committing. Before
GitHub CLI writes, verify `gh auth status --hostname github.com` and switch to
the mapped account only if needed.

## 1. Confirm the target

Fetch tags and inspect the current release:

```bash
git fetch origin --tags
git tag --sort=-version:refname | head -1
git show --no-patch --format='%H %s' HEAD
git status --short --branch
git rev-list --left-right --count main...origin/main
```

Confirm all of the following before editing:

- The user explicitly approved the exact target version and review bundle.
- `package.json` matches the latest `v<version>` tag.
- `main...origin/main` reports `0 0`.
- The working tree is clean.
- Neither `git tag --list 'v<target>'` nor
  `git ls-remote --tags origin 'refs/tags/v<target>'` returns a tag.

For example, the minor release after `v1.0.0` is `1.1.0`, tagged `v1.1.0`.

## 2. Update the changelog and draft the release notes

Review every first-parent commit since the latest release:

```bash
git log --first-parent --reverse --format='%h %s' v<current>..HEAD
git diff --stat v<current>..HEAD
```

Update `CHANGELOG.md` from both the Unreleased entries and the complete commit
review. Add a dated `## [<target>] - YYYY-MM-DD` section, retain an empty
`## [Unreleased]` section at the top, and update the comparison links at the
bottom. Group entries under Added, Changed, Fixed, Removed, Deprecated, or
Security as applicable, omitting empty groups.

Use the approved changelog section as the basis for concise GitHub release notes
with these headings when applicable:

- Highlights
- Fixes
- Upgrade notes

Describe user-visible outcomes, not a raw commit list. Mention breaking changes,
migrations, or new configuration requirements explicitly. Omit empty sections.
Show the draft to the user and obtain approval before committing, tagging,
pushing, or publishing.

## 3. Prepare and verify

Change the `version` field in `package.json` to the approved target and finalize
the approved `CHANGELOG.md` entry. `bun.lock` does not currently store the root
package version, so do not modify it solely for a release.

Run the complete verification suite:

```bash
bun run typecheck
bun test
bun run build
git diff --check
```

If any command fails, stop and report the failure. Do not tag or publish a
partially verified release.

Review the final release diff and confirm it contains only the intended version
and changelog changes:

```bash
git diff -- package.json CHANGELOG.md
git status --short
```

## 4. Commit and tag

After applying `git-identity-routing`, stage the version change and create the
release commit using Conventional Commit format:

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): prepare v<target>"
```

Confirm the commit identity and contents, then create an annotated tag:

```bash
git show --no-patch --format=fuller HEAD
git show --stat --oneline HEAD
git tag -a "v<target>" -m "v<target>"
git show --no-patch "v<target>"
```

## 5. Push and publish

Push the release commit first, then its tag:

```bash
git push origin main
git push origin "v<target>"
```

After applying `github-account-routing`, publish the approved notes as a
non-draft GitHub Release for the existing tag. Prefer a notes file so shell
quoting cannot alter the content:

```bash
gh release create "v<target>" --verify-tag --title "v<target>" --notes-file /absolute/path/to/approved-release-notes.md
```

Do not use automatically generated notes unless the user explicitly chooses
them instead of the reviewed notes.

## 6. Verify the published release

Verify all release surfaces before reporting completion:

```bash
git status --short --branch
git ls-remote --tags origin "refs/tags/v<target>"
gh release view "v<target>"
```

Report the release commit, tag, GitHub Release URL, verification results, and
any intentionally omitted steps.

## Starting a release

No procedural prompt is required. Ask for a release naturally, optionally with
an exact version. The repository skills supply the same process in Codex and
Claude Code and always pause at the review gate before execution.
