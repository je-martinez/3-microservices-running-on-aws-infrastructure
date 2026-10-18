---
title: "ADR-0024: diagram-design skill as the vault diagram tool"
type: adr
area: shared
status: accepted
id: ADR-0024
created: 2026-10-13
updated: 2026-10-18
deciders: [Jose E. Martinez]
supersedes: "ADR-0023-remotion-diagrams"
superseded-by: null
tags:
  - type/adr
  - area/shared
  - status/accepted
related:
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagrams]]"
  - "[[diagram-legibility]]"
  - "[[git-workflow]]"
  - "[[scripting-language]]"
  - "[[2026-10-13-diagram-design-migration-design]]"
  - "[[2026-10-13-diagram-design-migration]]"
---

# ADR-0024: diagram-design skill as the vault diagram tool

## Context

[[ADR-0023-remotion-diagrams]] rendered every vault diagram from data with Remotion and an ELK layout engine, in a TypeScript/pnpm package (`diagrams/`, Remotion 4.0.533, zod schema, 29 catalog entries). On 2026-10-13 the user decided to replace that package with the `diagram-design` Claude Code plugin skill. The skill produces hand-authored, self-contained HTML with inline SVG on a 4px grid, with no layout engine, and ships its own checkers (`self_check.py`, `verify-geometry.py`, `verify-motion.py`). Design: [[2026-10-13-diagram-design-migration-design]].

## Decision

1. **Style.** The skill's default style wins over the AWS reference-architecture look. A committed repo-root `.diagram-design` marker containing `profile: default` pins it, so no session hits the skill's first-run brand gate.
2. **Icons.** Three pinned jsDelivr sections, allow-listed in `diagrams/icons.yaml` (logical key to CDN path): `icons` (official AWS Architecture Icons, `aws-icons@3.2.0`, MIT), `devicon` (technology logos, `devicon@2.16.0`, MIT) and `vendor` (a brand logo served from a GitHub repo through jsDelivr, `https://cdn.jsdelivr.net/gh/<org>/<repo>@<ref>/<path>`, SVG or PNG; the repo is the vendor's own, or the selfh.st icon collection `selfhst/icons` when the vendor's repo has no usable mark). The first two versions never change; a `vendor` ref is a release tag or a full 40-char commit SHA, never a branch. Keys are unique across sections. Why more than AWS: Docker publishes no official icon CDN (its brand kit is a ZIP), and Devicon is coloured like the AWS icons whereas Simple Icons are monochrome and an `<image>` cannot be recoloured (2026-10-14); first use is the Docker whale for Compose containers. Why `vendor`: Stripe, Geoapify and OpenObserve publish no icon CDN, so a pinned GitHub repo is the closest stable source (Stripe `stripe-ios@26.14.0`, Geoapify `route-planner-sdk` at a commit SHA because it has no releases and no SVG, OpenObserve `selfhst/icons@7e8bfc5…` `svg/openobserve.svg`, the multicolour ring with a pulse line, because the `mini_logo.svg` in the openobserve repo was not the right mark; user decision 2026-10-14). Those three nodes use their logo; other external SaaS keep the `internet` icon. This is an **accepted deviation** from the skill's "no external images" rule; the gate filters only these pinned URL shapes out of `self_check`'s remote-reference errors and any other remote URL still fails.
3. **AWS group frames dropped.** Cloud/Region/VPC/AZ/subnet frames are replaced by at most 3 skill zones per diagram, drawn around the boundaries edges point at.
4. **Flows.** Step-mode HTML (interactive, browser-only) plus a static PNG of the complete frame with numbered step badges inside the SVG. No GIF.
5. **Branch.** The migration landed on `feature/remotion-diagrams`, replacing Remotion before PR #130 merges.
6. **Tooling.** A slim Python `diagrams/` package (`diagrams3mrai`): `catalog.yaml`, `drift.py`, `gate.py`, `render.py` (Playwright). Python by default per [[scripting-language]].

**Gate.** `make diagrams-gate` runs the plugin's `self_check`, `verify-geometry` and, for a flow with a motion root, `verify-motion`, plus the icon allowlist, the 2000 px width cap and catalog / source / PNG parity.

**Plugin.** `diagram-design` is declared in `.claude/settings.json` (`enabledPlugins` and `extraKnownMarketplaces`) and the setting does not pin a version. The gate uses the newest installed version under `~/.claude/plugins/cache/diagram-design/diagram-design/` and prints it (`diagrams-gate: diagram-design <version>`); `DIAGRAM_DESIGN_SELF_CHECK` overrides the path. The migration was verified with v2.6.6.

Rules and procedure live in [[diagrams]]; the legibility lessons in [[diagram-legibility]].

## Consequences

**Positive:**

- No layout engine to maintain; the skill's checkers catch geometry defects mechanically.
- Output is a PNG readable in Obsidian, plus an interactive HTML for flows.
- The drift check and keep-current rule are unchanged.

**Negative / risks:**

- **No GIF.** A flow's order is carried by numbered badges and a caption list in the PNG, and by `step` mode in the browser only.
- **PNG needs Playwright and Chromium**, installed by `make diagrams-setup`; kept off the apply path so Terraform never needs a browser. Every `diagrams-*` target needs that setup: without it `diagrams-check` prints "skipped" and exits 0 (its never-fails contract), while `diagrams-gate`, `diagrams-render` and `diagrams-studio` fail with "run make diagrams-setup".
- **CDN dependency at render time.** The icons load from jsDelivr, so an offline or failed icon fetch fails the render: `render.py` fails when any request fails or answers 400 or above and never writes a PNG with missing icons (`DIAGRAMS_OFFLINE=1` skips only the reachability check).
- **Hand-authored.** An agent writes each diagram's HTML; there is no layout engine, so legibility relies on the gate and on reading the PNG.
- **Density.** Dense views reach about 20 nodes at `faithful` detail (up to 24), kept legible with tags and a legend rather than nested frames.
- **Plugin drift.** The gate takes the newest installed version, which is unpinned and verified with v2.6.6; a plugin update may change checker behaviour.

## Alternatives considered

- **TS/pnpm package minus Remotion.** Rejected: new scripts are Python first ([[scripting-language]]).
- **HTML colocated in `docs/**/diagrams` with `<meta>` watches.** Rejected: it mixes sources into the vault owned by `obsidian-vault`, and Obsidian does not index `.html`.
- **SVG with inlined icons and fonts, to avoid a browser.** Rejected: the skill's output is HTML, and inlining 300-odd icons and fonts bloats every source.

## Related

- [[ADR-0023-remotion-diagrams]] — superseded by this decision.
- [[diagrams]]
- [[diagram-legibility]]
- [[git-workflow]]
- [[scripting-language]]
- [[2026-10-13-diagram-design-migration-design]]
- [[2026-10-13-diagram-design-migration]]
