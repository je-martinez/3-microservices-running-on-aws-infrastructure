---
applyTo: "**"
description: "GOLDEN RULE — the vault is the source of truth, never a private memory file"
---

# GOLDEN RULE — the vault is the source of truth, never a private memory file

When the user establishes a **convention**, a **decision**, or a **durable
lesson**, it goes into the **vault** first:

- `docs/shared/conventions/` — how we do a thing
- `docs/shared/decisions/` — an ADR, why we chose it
- `docs/lessons/` — a gotcha that cost real debugging time

Writing it **only** to an assistant memory store is **wrong**, and is the exact
failure mode this rule exists to prevent.

## Why

The vault is versioned, reviewable in a pull request, readable by every human and
every agent on the project, and it survives independently of any one assistant's
memory. A private memory file is:

- **invisible to the team** — nobody can see what you recorded
- **unreviewable** — it never appears in a diff
- **silently divergent** — it drifts from the repo with nothing to catch it

**A rule the user had to state twice, because the first capture was invisible to
them, is a rule that was not captured.**

This applies to *whatever* memory feature you happen to have — a rules file, a
memory tool, a saved-context store, a scratch note only you can read. If the
record lives somewhere the user cannot review in a PR, it does not count as
recorded.

## Order of operations

1. **Vault note first** — with `## Related` wikilinks, and the validator green.
2. *Then*, optionally, a short memory pointer if it genuinely helps recall
   mid-session.

**Never memory instead of the vault. Never memory before it.**

## What counts as durable

Not just the big architectural calls. Also: the package-manager choice, a naming
convention, a gotcha that cost debugging time, a workflow correction.

The test: **"would a teammate need to know this next month?"** If yes, it belongs
in `docs/`.

## Rules files vs. project knowledge

Agent instruction files (this one, `AGENTS.md`, and the per-directory rules) are
for **rules that govern agent behaviour**. The vault is for **project
knowledge**. A convention usually deserves both: the note in `docs/`, and a
one-line pointer in the instructions when it changes how work is done.

## Writing to the vault

**You do not write to `docs/` directly.** See the prohibition in `AGENTS.md`:
propose the note and wait for explicit user confirmation. The golden rule tells
you *where the knowledge must end up* — it does not grant you write access to
get it there.