---
applyTo: "**/*.md"
description: "Documentation vault (`docs/`)"
---

# Documentation vault (`docs/`)

The project's decisions and memory live in the **vault** — versioned and
navigable — not in any external memory file. This repo is the source of truth.

> **Writes to `docs/` are restricted.** See the prohibitions in `AGENTS.md`:
> propose vault changes and wait for explicit confirmation; never write directly.

## Structure — hybrid domain + type

- `docs/00-overview/` — root map of content (`index.md`), `architecture.md`,
  `system-context.md`, `glossary.md`
- `docs/domains/<service>/{specs,decisions,runbooks,testing}/` — one folder per
  service: `users`, `orders`, `tracking`, `events-pipeline`
- `docs/infrastructure/{specs,decisions,runbooks}/`
- `docs/shared/{decisions,patterns,conventions,observability}/` — **all global
  ADRs live in `shared/decisions/`**
- Global note types at the root: `docs/{lessons,retros,ideas,plans,templates}/`

## Note conventions

- **Cross-cutting rules are defined once in `shared/` and referenced by
  `[[wikilink]]`** — never duplicated into service specs.
- Every note has YAML frontmatter: `title`, `type`, `area`, `status`, `created`,
  `updated`, and `related` where applicable.
  - `type` ∈ `spec`, `adr`, `runbook`, `convention`, `pattern`, `lesson`,
    `retro`, `plan`, `reference`
  - `area` ∈ `users`, `orders`, `tracking`, `events-pipeline`, `infra`, `shared`
  - `status` ∈ `draft`, `active`, `accepted`, `superseded`
- Tags are folder-style: `area/<x>`, `type/<x>`, `status/<x>` (plus
  `severity/<x>` for lessons and `phase/<n>` for phases).
- Filenames: evergreen notes `kebab-case.md`; ADRs `ADR-NNNN-title-kebab.md`
  with continuous global numbering; dated notes `YYYY-MM-DD-short-title.md`.
- Every note ends with a `## Related` section listing its outgoing wikilinks.

## Propagation — a spec is not done when it is written

Design documents under `docs/superpowers/{specs,plans}/` are where decisions are
**made**; the organized vault (`docs/domains/`, `docs/shared/`,
`docs/infrastructure/`, `docs/00-overview/`) is where they **live**.

A spec or plan is done only when its decisions have propagated into the category
folders they belong to. **Before proposing the PR that closes an issue or
milestone**, update or create the target notes, link them bidirectionally, and
bump each target's `updated:`.

Every **new** spec or plan under `docs/superpowers/` declares a `propagates-to:`
frontmatter key listing its target notes, or opts out with
`propagates-to: none — <reason>` (a bare `none` fails validation).

## Validation

`node scripts/validate-vault.mjs` checks frontmatter (required keys **and** valid
`type`/`area`/`status` values), broken wikilinks, and the propagation gate. Run
it after editing vault notes. Notes predating 2026-07-28 are exempt and are
reported as a "Propagation debt" count — that line is the gate working, not
failing.

Two things the validator does **not** catch, so check them by hand:

- **Intra-note anchor links** (`[text](#heading)`). GitHub-style slugs lowercase
  the text, strip punctuation, and hyphenate spaces; an em-dash yields a double
  hyphen. `## Commit messages — Conventional Commits v1.0.0` becomes
  `#commit-messages--conventional-commits-v100`, not `#commit-messages`.
- **Wikilink anchors** (`[[note#Some Heading]]`). Only the note is resolved, so a
  wrong heading passes silently. Re-check these after renaming any heading.