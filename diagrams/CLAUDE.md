# CLAUDE.md — diagrams/

Every architecture, flow and milestone-dependency diagram in the vault is a hand-authored `diagram-design` HTML source here, rendered to a PNG beside the note that owns it. Convention: [[diagrams]]. Decision: ADR-0024 (diagram-design diagrams). The agent that works here is `diagram-impl`.

## What lives here

- `catalog.yaml` — one entry per diagram: `id`, `title`, `src` (`diagrams/src/<group>/<id>.html`), `output` (vault path, no extension; the PNG is `<output>.png`), `watches` (globs whose change may make it stale).
- `icons.yaml` — the only AWS icons a diagram may use: logical key → path inside `aws-icons@3.2.0` on jsDelivr.
- `src/{architecture,system-context,flows,milestones}/<id>.html` — the sources.
- `diagrams3mrai/` — Python toolchain: `catalog.py`, `drift.py`, `gate.py`, `render.py`. `tests/` — pytest.

## Prerequisites

- The `diagram-design` plugin **v2.6.6** installed for your agent (Claude Code: `/plugin`; Codex ships its own manifest). The gate runs its `scripts/self_check.py` from `~/.claude/plugins/cache/diagram-design/diagram-design/2.6.6/`; set `DIAGRAM_DESIGN_SELF_CHECK=<path>` if yours lives elsewhere.
- `make diagrams-setup` once per clone: installs this package, PyYAML, Playwright and Chromium into the repo `.venv`. No apply target needs it.
- The repo-root `.diagram-design` marker pins the skill's default style (`profile: default`). Never customise the style guide for this repo.

## Authoring contract

- Load the `diagram-design:diagram-design` skill and the type reference it routes to: `type-architecture` (architecture, system context), `type-flowchart` / `type-sequence` / `type-process` (flows), `type-dependency` (milestone graphs).
- Start from the skill's `assets/template.html`; a flow starts from `assets/template-motion.html` with `data-motion-mode="step"` and the controller copied **verbatim**.
- Follow the skill: 4px grid, the six connector rules (§6), arrows before boxes, legend as a bottom strip, accessible SVG with `<id>-title` / `<id>-desc` IDs, Geist / Geist Mono / Instrument Serif.
- `viewBox` at most **2000** wide. Primary flow left → right: browser/client on the left, then API Gateway, ALB, ECS, data, events.
- Show service and resource names only. Never endpoints, request fields or payloads. Content is read from real sources, never invented.

## Icons

- Draw an AWS node as `<image href="https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/<path>" width="40" height="40"/>` with its name below, where `<path>` is a value of `icons.yaml`.
- Need a new icon? Find it in the package (`https://data.jsdelivr.com/v1/packages/npm/aws-icons@3.2.0`), add a key to `icons.yaml`, and check it answers HTTP 200. Never change the version.
- Non-AWS things (browser, users, Stripe, Geoapify, OpenObserve) use the `client`, `users`, `server` or `internet` icons, or a plain skill node box.

## Budget and coverage

- Default ≤9 nodes and ≤12 arrows. Architecture and system-context views use `faithful` detail: ≤24 nodes, grouped in zones above 9. At most 3 zones per diagram.
- Every runtime AWS service gets a node; no service is drawn twice. Over 24 nodes, split into views (request path / events) instead of dropping one.
- Zones replace AWS group frames: e.g. one `VPC` zone whose label names its AZs and subnets; Floci stands in for the cloud in local-dev views.
- Solid connector = synchronous call; dashed = async (queues, topics, EventBridge, webhooks).

## Flows

- Numbered step badges live inside the SVG, so the static PNG carries the whole meaning.
- `step` mode drives the interactive HTML: ≤8 motion steps, ≤12 marked items. Merge adjacent steps rather than exceed it.

## Read the source before drawing

- Architecture and system context: `infra/modules/**`, `infra/environments/{local,preprod}/**`, `docker-compose*.yml`.
- Flows: the handlers plus `services/<svc>/openapi.yaml`.
- Milestone graphs: the milestone-plan note and its dependency diagram.

## Commands

| Command | What it does |
|---|---|
| `make diagrams-gate [ID=a,b]` | Skill self_check (filtered to allow-listed icons), icon allowlist, width cap, catalog ↔ sources parity. Fails. |
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
- An icon URL that is not `aws-icons@3.2.0` + a value of `icons.yaml`.
- Edits to `.md` notes under `docs/` (report embed needs for `obsidian-vault`), git writes, Linear.

## Write boundary

- Write only `diagrams/**` and `docs/**/diagrams/*.png`.
- Code comments follow [[code-comments]]; run `python3 scripts/validate-comments.py <files>` on what you touch.
