# CLAUDE.md — diagrams/

Every architecture, flow and milestone-dependency diagram in the vault is a hand-authored `diagram-design` HTML source here, rendered to a PNG beside the note that owns it. Convention: [[diagrams]]. Decision: ADR-0024 (diagram-design diagrams). The agent that works here is `diagram-impl`.

## What lives here

- `catalog.yaml` — one entry per diagram: `id`, `title`, `src` (`diagrams/src/<group>/<id>.html`), `output` (vault path, no extension; the PNG is `<output>.png`), `watches` (globs whose change may make it stale).
- `icons.yaml` — the only icons a diagram may use, in three pinned sections: logical key → path inside `aws-icons@3.2.0` (`icons`), `devicon@2.16.0` (`devicon`), or a GitHub repo pinned to a tag or SHA (`vendor`), all on jsDelivr.
- `src/{architecture,system-context,flows,milestones}/<id>.html` — the sources.
- `diagrams3mrai/` — Python toolchain: `catalog.py`, `drift.py`, `gate.py`, `render.py`. `tests/` — pytest.

## Prerequisites

- The `diagram-design` plugin installed for your agent (verified with v2.6.6). Claude Code: `.claude/settings.json` enables `diagram-design@diagram-design` and declares its marketplace (`cathrynlavery/diagram-design`), so `/plugin` offers it on a fresh clone; Codex ships its own manifest. The gate uses the newest version installed under `~/.claude/plugins/cache/diagram-design/diagram-design/` and prints it; set `DIAGRAM_DESIGN_SELF_CHECK=<path>` if yours lives elsewhere.
- `make diagrams-setup` once per clone: installs this package, PyYAML, Playwright and Chromium into the repo `.venv`. Every `diagrams-*` target needs it (`diagrams-check` warns and skips without it; the others fail with the fix). No apply target needs it.
- The repo-root `.diagram-design` marker pins the skill's default style (`profile: default`). Never customise the style guide for this repo.

## Authoring contract

- Load the `diagram-design:diagram-design` skill and the type reference it routes to: `type-architecture` (architecture, system context), `type-flowchart` / `type-sequence` / `type-process` (flows), `type-dependency` (milestone graphs).
- Start from the skill's `assets/template.html`; a flow starts from `assets/template-motion.html` with `data-motion-mode="step"` and the controller copied **verbatim**.
- Follow the skill: 4px grid, the six connector rules (§6), arrows before boxes, legend as a bottom strip, accessible SVG with `<id>-title` / `<id>-desc` IDs, Geist / Geist Mono / Instrument Serif.
- `viewBox` at most **2000** wide. Primary flow left → right: browser/client on the left, then API Gateway, ALB, ECS, data, events.
- Show service and resource names only. Never endpoints, request fields or payloads. Content is read from real sources, never invented.

## Icons

- Icons come only from `icons.yaml`, which has three pinned sections: `icons` (`aws-icons@3.2.0`, AWS services), `devicon` (`devicon@2.16.0`, technology logos) and `vendor` (a brand logo, SVG or PNG, via `https://cdn.jsdelivr.net/gh/`, pinned to a release tag or full commit SHA, never a branch). The source is the vendor's own repo, or the selfh.st collection (`selfhst/icons`, the set dashboardicons.com serves) when the vendor's repo has no usable mark — OpenObserve's is from selfh.st.
- Draw an icon as `<image href="<prefix><path>" width="40" height="40"/>` with its name below, where `<prefix>` is `https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/`, `https://cdn.jsdelivr.net/npm/devicon@2.16.0/icons/` or `https://cdn.jsdelivr.net/gh/`, and `<path>` is a value of the matching section. A non-square logo keeps the default `preserveAspectRatio` (centred, undistorted).
- A Docker Compose container uses the `docker` whale (`devicon`).
- Need a new icon or logo? Find it in its package (`https://data.jsdelivr.com/v1/packages/npm/aws-icons@3.2.0`, `.../devicon@2.16.0`) or the vendor's repo / `selfhst/icons` at a release tag or commit SHA (check the mark against the vendor's site), add a key to the matching section, and check it answers HTTP 200. Never change a pinned version, and never pin a vendor logo to a branch.
- Other non-AWS things (browser, users) use the `client`, `users`, `server` or `internet` icons, or a plain skill node box.

## Budget and coverage

- Default ≤9 nodes and ≤12 arrows. Architecture and system-context views use `faithful` detail: ≤24 nodes, grouped in zones above 9. At most 3 zones per diagram. Milestone graphs use the same ceiling.
- Every runtime AWS service gets a node; no service is drawn twice. Over 24 nodes, split into views (request path / events) instead of dropping one.
- Zones replace AWS group frames (see Approved pilot conventions for which boundaries become zones); Floci stands in for the cloud in local-dev views.
- Solid connector = synchronous call; dashed = async (queues, topics, EventBridge, webhooks).

## Flows

- Numbered step badges live inside the SVG, so the static PNG carries the whole meaning.
- `step` mode drives the interactive HTML: ≤8 motion steps, ≤12 marked items. Merge adjacent steps rather than exceed it.

## Approved pilot conventions

The four pilots are the reference implementation; open the one of the same kind before drawing:
`src/architecture/architecture-dev-floci-events.html`, `src/flows/orders-checkout-stripe.html`, `src/system-context/system-context-l1.html`, `src/milestones/milestone-users-service-deps.html`.

- **Title stays out of the PNG.** The render captures only the `<svg>`; eyebrow, h1 and subtitle live in the HTML page, and the owning note supplies the heading.
- **Architecture zones are the boundaries edges point at** (e.g. `Docker Compose · services`, `Floci — local AWS :4566`, `Realtime`). VPC, subnets and the ECS cluster are not zones: tag the node (`VPC`, `COMPOSE`) and name the VPC CIDR, subnets and cluster in the legend. A node may sit outside every zone.
- **Coverage beats the budget.** A view keeps every runtime AWS service even past 9 nodes (≤24, `faithful`); a flow keeps every service it touches.
- **Flows** use the flowchart type laid out left → right: numbered badges on the connectors, a numbered caption list inside the SVG below the drawing, accent on the step's current badge only under `[data-frame="step"]` so the static PNG stays neutral. One focal node (the service that owns the flow) and at most one accent connector.
- **Milestone graphs** keep every task: phases merge into ≤3 zones whose labels name the original phases, ranks run left → right, a `N IN` chip counts blockers, `GATE` marks a hard gate.
- **A group edges point at may be a zone even if it is a cluster** (e.g. `ECS cluster` when ALB, ECR and config arrows target it). An edge from a group that is not drawn as a zone leaves the zone holding its members, and the legend names the rest (e.g. "every task logs to CloudWatch").
- **An arrow points from the caller.** A pull receiver points at the polled service (e.g. the OTel collector polling CloudWatch, labelled `POLLS`; ECS pulling images, `PULLS IMAGES`; ECS reading task config, `READS CONFIG`). Exception: a queue → consumer edge points at the consumer, dashed, labelled by what it carries (`TRIGGERS`, `NOTIFY`) — the common AWS reading of a queue.
- **No routes in labels, even when carrying content over 1:1:** `/v1 via web` becomes `API VIA WEB`. Labels ≤14 characters, uppercase.
- **Stripe, Geoapify and OpenObserve use their `vendor` logo**; other external SaaS without one uses the `internet` icon. Optional integrations take the skill's dashed Optional treatment.
- **Trim the viewBox** to the content so the PNG has no empty band at the top.

## Read the source before drawing

- Architecture and system context: `infra/modules/**`, `infra/environments/{local,preprod}/**`, `docker-compose*.yml`.
- Flows: the handlers plus `services/<svc>/openapi.yaml`.
- Milestone graphs: the milestone-plan note and its dependency diagram.

## Commands

| Command | What it does |
|---|---|
| `make diagrams-gate [ID=a,b]` | Skill self_check (filtered to allow-listed icons), verify-geometry (label masks clipped by a later node) and, for a flow with a motion root, verify-motion, icon allowlist, width cap; without `ID`, also catalog ↔ sources ↔ PNG parity. Fails. |
| `make diagrams-render [ID=a,b]` | Gate, then PNG to `<output>.png` (static frame, opaque paper, viewBox × 2). Warns over 2 MB. |
| `make diagrams-check` | Lists diagrams whose `watches`, `src` or shared render inputs changed vs `DIAGRAMS_BASE` (default `main`) without a re-render. Never fails. |
| `make diagrams-studio ID=<id>` | Opens the interactive HTML in the browser. |
| `cd diagrams && ../.venv/bin/python -m pytest` | Toolchain tests. |

`DIAGRAMS_OFFLINE=1` skips the icon reachability check.

## Adding or changing an entry

1. Add the entry to `catalog.yaml`: unique `id` and output basename (Obsidian resolves an embed by basename), `src` matching `diagrams/src/<group>/<id>.html`.
2. `watches` are tight globs of the handlers/modules the diagram depicts, not whole service trees. Implicit watches: the entry's `src`, `diagrams3mrai/render.py`, `icons.yaml`, `pyproject.toml`, `.diagram-design`. Test files never count as drift.
3. Author the HTML, `make diagrams-render ID=<id>`, read the PNG, iterate.

## Never

- GIFs, MP4s or any other output than `<output>.png`.
- An icon URL that is not a pinned prefix (`aws-icons@3.2.0`, `devicon@2.16.0`, or `cdn.jsdelivr.net/gh/` for `vendor`) + a value of its `icons.yaml` section.
- Edits to `.md` notes under `docs/` (report embed needs for `obsidian-vault`), git writes, Linear.

## Write boundary

- Scratch work (generators, templates) goes in a subdirectory named after your diagram id; parallel agents share the session scratchpad.

- Write only `diagrams/**` and `docs/**/diagrams/*.png`.
- Code comments follow [[code-comments]]; run `python3 scripts/validate-comments.py <files>` on what you touch.
