---
title: Doc Propagation
type: convention
area: shared
status: active
created: 2026-07-28
updated: 2026-07-28
tags:
  - type/convention
  - area/shared
  - status/active
  - issue/JE-83
related:
  - "[[2026-06-26-3mrai-docs-vault-design]]"
  - "[[scripting-language]]"
  - "[[env-files]]"
  - "[[logging-context]]"
---

# Doc Propagation

## Rule

`docs/superpowers/{specs,plans}/` is where decisions are **made** — that is where
`brainstorming` and `writing-plans` write their output. The organized vault
(`docs/00-overview/`, `docs/domains/`, `docs/infrastructure/`, `docs/shared/`) is where
decisions **live** — CLAUDE.md declares it the source of truth for technical content. A spec
or plan is not done the moment it is written; it is done once its decisions have propagated
into the category folder(s) they belong in.

Concretely: **every new spec or plan under `docs/superpowers/` must declare a
`propagates-to:` frontmatter key** naming the vault note(s) it feeds, or explicitly opt out
with a reason. This is enforced by a validator gate — see [The gate](#the-gate) — not just
convention text, because convention text alone did not work; see the evidence below.

Introduced in [JE-83](https://linear.app/je-martinez/issue/JE-83), Developer Experience
milestone.

## Why this rule exists (the evidence)

Before this rule, propagation had no mechanism forcing it to happen, and it didn't:

- `docs/domains` has only 4 real spec files (one `<svc>-service-design.md` per service) plus
  2 `testing/index.md` notes. Every other category folder is empty.
- **20 folders are `.gitkeep`-only**: every `domains/<svc>/decisions/` and
  `domains/<svc>/runbooks/` across all four services, plus `domains/tracking/testing`,
  `domains/events-pipeline/testing`, `infrastructure/decisions`, `retros`, `ideas`, and
  `plans/archive`.
- `docs/domains/users/specs/users-service-design.md` and
  `docs/domains/orders/specs/orders-service-design.md` both still read `updated: 2026-07-12`,
  even though the Developer Experience milestone (JE-59…JE-82, through 2026-07-20) made
  decisions affecting both services — logging context, OTel tracing, env-file generation.
  Those decisions were written up in superpowers specs and never landed back in the service
  design notes they changed.
- **11 superpowers specs are referenced from exactly one place** in the organized vault — an
  index link and nothing else. Their content never landed in a category folder; the index
  link is the only trace they exist.
- **14 plans under `docs/superpowers/plans/` have no frontmatter at all** — raw plugin
  output, never normalized (e.g. `2026-07-11-auth-error-mapping.md`,
  `2026-07-11-byidorcognitosub.md`, `2026-07-17-testing-layers-and-e2e-gateway.md`).
- The root cause the gap stayed invisible for this long: `scripts/validate-vault.mjs` skipped
  `superpowers/` entirely and only ever checked frontmatter keys and broken wikilinks on the
  notes it did look at. Nothing in the vault detected "a decision was made but never
  propagated" — a spec could be written, referenced once from an index, and then silently
  never update the service spec, ADR, or convention it actually concerned.

## Routing table

When a spec or plan makes a decision, route it by kind:

| Decision kind | Destination |
|---|---|
| Service behaviour, API surface, or data model | `docs/domains/<svc>/specs/<svc>-service-design.md` |
| A decision local to one service (not cross-cutting) | `docs/domains/<svc>/decisions/` |
| Cross-service or global architectural decision | `docs/shared/decisions/ADR-NNNN-*.md` (continuous global numbering) |
| Reusable cross-cutting rule | `docs/shared/conventions/` |
| Reusable implementation shape | `docs/shared/patterns/` |
| Operational procedure | `docs/domains/<svc>/runbooks/` or `docs/infrastructure/runbooks/` |
| Test strategy for a service | `docs/domains/<svc>/testing/` |
| Infra resources, modules, networking | `docs/infrastructure/specs/` |
| Something learned the hard way (a failure + its root cause) | `docs/lessons/` |
| Milestone retrospective | `docs/retros/` |

`<svc>` is one of `users`, `orders`, `tracking`, `events-pipeline`.

## The mechanics — how to propagate

1. **Identify the target category** from the routing table above. A spec commonly propagates
   to more than one target (e.g. a service-design update *and* a new convention).
2. **Update or CREATE the target note.** If the target already exists, edit it — don't leave
   the decision only in the superpowers note. If it doesn't exist yet (e.g. the first
   decision, ADR, or runbook for a service), create it following this vault's frontmatter and
   naming rules.
3. **Link bidirectionally.** The target note links back to the spec/plan in its own
   `## Related` section; the spec/plan lists the target under `propagates-to:`. Neither
   direction is optional — a one-way link is how the 11-specs-referenced-once problem
   happened.
4. **Bump the target's `updated:` field** to the date of the propagating change. A target
   whose `updated:` predates a milestone that changed it (as happened to both service-design
   notes above) is a sign propagation was skipped.
5. **Never duplicate a cross-cutting rule into a service spec.** If the decision is a rule
   that applies across services (soft-delete, env files, logging context, scripting
   language…), it is defined **once** in `docs/shared/conventions/` or
   `docs/shared/patterns/` and the service spec links to it with `[[wikilink]]` — this is the
   existing CLAUDE.md rule, and propagation must not create new duplication while fixing the
   silent-drop problem.

## The gate

`scripts/validate-vault.mjs` enforces propagation on every note under `docs/superpowers/`:

- A note with frontmatter `created:` on or after `2026-07-28` (`PROPAGATION_EPOCH`) **must**
  declare `propagates-to:`.
- `propagates-to:` is a YAML block sequence of targets, each a wikilink or vault-relative
  path:

  ```yaml
  propagates-to:
    - "[[users-service-design]]"
    - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  ```

  Every declared target must **resolve** to a real note — an unresolvable target fails
  validation exactly like a broken wikilink does elsewhere in the vault.
- **Opt-out requires a reason.** `propagates-to: none — <reason>` is valid (e.g. a spike
  whose outcome was "do not adopt", so nothing propagates because there is nothing to keep).
  A bare `none` with no reason **fails** — silent opt-out is exactly what this gate exists to
  stop.
- **Notes predating the epoch are not *required* to declare propagation** — the gate is
  prospective, so historical notes that stay silent are reported as a "Propagation debt: N/63"
  informational line rather than failing the build.
- **But a pre-epoch note that *does* declare `propagates-to:` is held to the full standard**:
  its targets must resolve, exactly like a new note's. Backfilled declarations are not
  second-class — letting them rot unchecked would recreate the very problem this gate exists
  to catch.
- Run it with `nvm use && node scripts/validate-vault.mjs` — this repo pins Node via
  `.nvmrc`, so `nvm use` must run first (see [[scripting-language]] and the root CLAUDE.md
  Node.js rule).

## When propagation happens

At **issue or milestone close, before proposing the PR** — not "later," and not as a
separate cleanup pass. The Phase C flow already routes vault normalization through the
`obsidian-vault` agent; propagation is part of that same step, not an additional one. A
spec/plan that reaches PR time without its `propagates-to:` targets updated is an incomplete
change, the same way an endpoint without gateway E2E is incomplete per [[testing]].

## The historical debt

The 63 superpowers notes (33 specs + 30 plans) predating this gate were **backfilled under
JE-83**: the 13 plans that had no frontmatter at all were normalized, and the rest were read
and given `propagates-to:` declarations, with their decisions propagated into the category
folders they had been missing — service design notes, `domains/*/decisions/`,
`infrastructure/decisions/`, and lessons.

The validator's debt line reports how much remains (`Propagation debt: N/63`). If it ever
reads `0`, every superpowers note declares where its decisions live. A non-zero count is not
this rule breaking — it is the rule surfacing debt that used to be invisible.

## Related

- [[2026-06-26-3mrai-docs-vault-design]]
- [[scripting-language]]
- [[env-files]]
- [[logging-context]]
