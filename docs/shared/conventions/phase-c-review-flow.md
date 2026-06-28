---
title: Phase C Review Flow Convention
type: convention
area: shared
status: active
created: 2026-06-28
updated: 2026-06-28
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-06-26-implementation-workflow-design]]"
  - "[[milestone-plan]]"
  - "[[linear-references]]"
---

# Phase C Review Flow Convention

This convention refines how Phase C (Implementation) from the [[2026-06-26-implementation-workflow-design]] Phases A–D flow is executed and reviewed. It governs the cadence of issue implementation and PR review so the parent agent chains work efficiently while the user retains review control over every merge.

## Rule

The following rules apply to every Phase C execution in this project:

1. **Chain issues without per-merge prompts.** The parent works issues one after another — `linear-pm` → In Progress; `github-ops` → task branch; `<svc>-impl` → implement; `github-ops` → commit + PR task→feature. The parent does NOT ask for merge confirmation between each issue, and does NOT merge the task→feature PRs itself during the chain — they remain open.
2. **Batch PRs for review.** At each stop point, the parent presents the user ONE consolidated list of open PRs to review and merge — never one-by-one prompts per PR.
3. **Dependency gates are stop points.** If issue B is blocked by issue A, B must build on A's merged work. The parent therefore implements all independent issues first, opens those PRs, then STOPS at the first blocked issue and presents the accumulated batch for the user to review and merge. After the user merges that batch, the parent continues with the previously-blocked issues. A milestone may have several stop points — one per dependency gate.
4. **The user merges (or explicitly authorizes the merge of) every PR.** The parent never auto-merges. One merge approval authorizes only that PR or batch — it does not establish standing auto-merge permission for subsequent PRs.
5. **Milestone close stays user-merged.** The final feature→main PR is always reviewed and merged by the user (no auto-merge), per the branch-flow rule in the repo's `CLAUDE.md`.

> [!important] Dependency correctness
> A blocked issue must never be implemented on top of unmerged work. If issue B depends on issue A, the parent must wait for the user to merge A's PR before branching and implementing B. Violating this produces a PR chain that cannot be squash-merged cleanly.

## Rationale

This convention reconciles two competing goals:

- **Efficient chaining** — prompting for a merge confirmation after every individual issue is slow, noisy, and interrupts the parent's flow unnecessarily.
- **User review control + dependency correctness** — a blocked issue must not be built on unmerged work, and the user must remain the sole merge authority.

The solution is batching: the parent chains all independent work into a single run, collects the resulting open PRs, and surfaces them to the user in one review moment. Dependency gates create natural stop points where the batch-and-present cycle repeats. This extends, rather than replaces, the Phases A–D flow defined in [[2026-06-26-implementation-workflow-design]].

The [[milestone-plan]] convention defines the task-order and dependency graph that the parent reads to determine which issues are independent (can be chained) and which are blocked (trigger a stop point). The two conventions are complementary: `milestone-plan` defines the structure; this convention defines the execution cadence.

## Related

- [[2026-06-26-implementation-workflow-design]] — the Phases A–D flow this convention refines.
- [[milestone-plan]] — milestone plan convention (task order + dependency graph that defines the gates).
- [[linear-references]] — Linear reference rules for tagging and linking issues.
