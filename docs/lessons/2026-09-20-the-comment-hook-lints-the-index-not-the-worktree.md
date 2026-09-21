---
title: "The comment hook lints the git index; make lint-comments lints the working tree"
type: lesson
area: shared
status: active
created: 2026-09-20
updated: 2026-09-20
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/low
related:
  - "[[code-comments]]"
  - "[[git-workflow]]"
  - "[[browser-rum]]"
---

# The comment hook lints the git index; make lint-comments lints the working tree

## Finding

An agent reported `make lint-comments` clean. The very next `git commit` was rejected by the
pre-commit hook with three comment violations in a file — specific line numbers, real
violations. Re-running `make lint-comments` afterward still said clean. Both results were
telling the truth about different inputs.

## Mechanism

`make lint-comments` runs `validate-comments.py --all --root .`, which reads files from the
**working tree** by path. `.githooks/pre-commit` instead iterates the **staged** paths and runs
`git show ":$path"` into a temp directory, linting the **index**'s content. The two diverge
whenever a file is staged at one moment and edited again afterward without re-staging — the
index then holds an older snapshot than the working tree, and each tool is answering a question
about a different snapshot.

## Why it matters in both directions

The harmless direction is the one observed here: a stale index blocks a commit whose working
tree is actually clean. The dangerous direction is the inverse — a file trimmed down in the
index but left violating in the working tree would **pass** the hook and land the violation in
the repo, because the hook never looks at what is actually on disk. Whichever direction it goes,
"`lint-comments` is clean" is not by itself a statement about what the hook will do on the next
commit.

## How to apply

- Treat the two as answering different questions: `make lint-comments` answers "is the working
  tree clean", the hook answers "is what I'm about to commit clean." They only agree when the
  index and the working tree agree.
- Before committing, either `git add` the final state first so index and tree match, or re-run
  the check against what is actually staged (`git diff --cached` scope) rather than the tree.
- When a hook and a make target disagree about the same file, suspect the index before
  suspecting either tool — re-stage rather than hunting a phantom bug in the linter.

## Worth noting for agents specifically

Dispatched implementers in this repo never run git and never stage anything (see
[[git-workflow]]), so a stale index in that workflow can only come from the **main session**'s
own earlier `git add` — as it did here, left behind by an earlier rejected commit attempt. An
implementer honestly reporting "`lint-comments` clean" can still be followed by a blocked commit
from a stale index the implementer never touched, and that is not a contradiction to chase.

## Related

- [[code-comments]] — the tags/budget rules both `validate-comments.py` and the hook enforce.
- [[git-workflow]] — why implementers never stage; the main session is the only place a stale
  index can originate from.
- [[browser-rum]] — the work this lesson came out of.
