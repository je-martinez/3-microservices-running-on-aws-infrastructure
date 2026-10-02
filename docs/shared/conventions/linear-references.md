---
title: Linear references in the vault
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-10-02
tags: [type/convention, area/shared, status/active]
related: ["[[2026-06-26-3mrai-docs-vault-design]]", "[[git-workflow]]"]
---

# Linear references in the vault

## Linear issues are optional

**Creating a Linear issue is optional.** We do not create one per ticket: not every change, fix, or task gets an issue. Small fixes, follow-ups, docs/vault work, and audit findings routinely ship with no issue at all.

When there is no issue:

- The vault note simply carries **no `issue/*` tag and no Linear link**. The rules below apply only when an issue exists.
- The branch is named `<type>/<slug>` with **no issue ID** (see [[git-workflow]] → Branch flow).
- Commit `Refs:` / `Closes:` footers and the PR's Linear link are **omitted**.

Creating an issue is a **deliberate choice** — milestone work, or something worth tracking and prioritizing later. It is never a precondition for starting work, and an agent must **not** create one by default.

## Scope

When a vault note relates to work tracked in Linear, the note **references** Linear rather than mirroring it. Linear stays the single home of issue/milestone detail (description, state, comments); the vault note carries only lightweight references.

## Why

Minimal footprint, no sync machinery, no drift. The vault links to the source of truth instead of copying it, so notes stay evergreen and there is nothing to keep in sync.

## Rules

1. **Frontmatter tags** (folder-style, matching the existing `area/` // `type/` // `status/` scheme):
   - Issue: `issue/<ID>` — e.g. `issue/JEM-42` (the Linear issue identifier verbatim).
   - Milestone: `milestone/<slug>` — e.g. `milestone/infrastructure` (kebab-case slug of the milestone name).
   - A note may carry several `issue/*` tags if it relates to multiple issues. These tags make notes queryable via Obsidian Bases and visible in the graph.
2. **Inline links** in the note body, where they add context, written as normal markdown links to the Linear issue URL — e.g. "Implemented in [JEM-42](https://linear.app/je-martinez/issue/JEM-42)." Put them in prose where the reference is meaningful, not as a dumped list.
3. **Detail is fetched, never copied.** The vault does NOT store the issue's description, state, or comments. When that detail is needed, request it from Linear on demand (via the `linear-pm` agent). This keeps notes evergreen and avoids stale duplication.
4. **No mirror notes.** We do NOT create one note per issue or per milestone. Issues and milestones live in Linear; the vault only points at them from the technical notes that concern them.

## Example

```yaml
---
title: Aurora Postgres Terraform module
type: spec
area: infra
status: active
tags: [type/spec, area/infra, status/active, issue/JEM-42, milestone/infrastructure]
---
```

In the body: "The module follows our Terraform conventions and was delivered in [JEM-42](https://linear.app/je-martinez/issue/JEM-42)."

## Related

- [[2026-06-26-3mrai-docs-vault-design]] — vault design that defines the tag/frontmatter scheme this convention extends.
- [[git-workflow]] — branch naming and commit/PR footers, including the no-issue variants.
- The `linear-pm` agent — the READ path: fetch issue/milestone detail from Linear on demand instead of copying it here.
- The `obsidian-vault` agent — the WRITE path: the sole writer that adds these reference tags and inline links to vault notes.
