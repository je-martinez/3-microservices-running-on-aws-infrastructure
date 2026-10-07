# CLAUDE.md — diagrams/

Remotion package `@3mrai/diagrams`: every animated flow, architecture and milestone-dependency diagram in the vault is rendered from here. Convention and decision: [[diagrams]]. The agent that works here is `diagram-impl`.

## Stack

- `remotion` and every `@remotion/*` package pinned to the same exact version (`4.0.533`, no caret). Bump them together or not at all.
- React 19, TypeScript 6, zod 4 (schemas), Vitest 4 (tests). `@nxavis/aws-icons` pinned exact.
- pnpm only: `pnpm --filter @3mrai/diagrams <script>`, `pnpm dlx`. Never `npm`/`npx`. Run `nvm use` first.
- Layout: `src/catalog.ts` (aggregates `src/data/<group>.catalog.ts`, one entry per diagram), `src/schema.ts` (zod), `src/data/{architecture,system-context,flows,milestones}/*.ts`, `src/primitives/`, `src/theme/`, `src/scripts/{drift,check-drift,render}.ts`, `test/`.

## The three primitives — pick by what the diagram says

| Primitive | Use for | Do not use for |
|---|---|---|
| `ArchitectureMap` | static topology: which resources exist and how they connect | ordered interaction |
| `FlowSequence` | one ordered interaction among at most 7 actors | topology, plans |
| `DependencyGraph` | milestone plans (phases and task dependencies); PNG only | anything animated |

## Detail level

- At most ~12 nodes per diagram; architecture maps may reach 18 when grouped by zone (schema cap: 5 zones, 18 nodes).
- At most 10 steps per flow, 7 actors. One-line caption per step, at most 90 characters (schema `max()` enforces label and caption lengths).
- Show service and resource names only. Never endpoints, request fields or payloads.
- Content is read from real sources, never invented.

## Read the source before drawing

- Architecture and system context: `infra/modules/**`, `infra/environments/{local,preprod}/**`, `docker-compose*.yml`.
- Flows: the handlers plus `services/<svc>/openapi.yaml`.
- Milestone graphs: the milestone-plan note and its dependency diagram.

## Adding or changing an entry

1. Add the data file under `src/data/<kind>/` and its entry in `src/data/<group>.catalog.ts` (never directly in `src/catalog.ts`), with `source` set to the data file's repo-relative path (e.g. `diagrams/src/data/flows/users-signup-otp.ts`). The catalog test requires it to exist and be tracked.
2. Every entry declares `watches`: globs of the handlers/modules the diagram depicts, not whole service trees. `test/catalog.test.ts` fails when a glob matches nothing, and `make diagrams-check` relies on them. A typo silently disables drift detection, so keep them tight and real. `source`, `src/primitives/**`, `src/theme/**`, `src/schema.ts` and `src/timing.ts` are implicit watches; test files never count as drift.
3. `id`, `output` and the output **basename** must be unique across the catalog (Obsidian resolves an embed by basename). `output` has no extension; the renderer adds `.gif` and `.png`.
4. Edges and steps reference declared node/actor ids; the schema rejects unknown ones.
5. AWS icons: only `src/theme/aws-icons.ts` imports `@nxavis/aws-icons`. Everything else asks the adapter for a service. Swapping the icon source touches that one file.

## Authoring rules

Full text: [[diagrams]]. In short:

- Cross-zone edge labels: at most 10 characters.
- Order zones so edges join adjacent zones; avoid edges leaving a crowded zone's left sub-column.
- `DependencyGraph` draws arrows over the task boxes, and a skip-phase arrow blocked by a task detours through a row gap: order tasks within each phase to minimise crossings, faithful to the milestone note.
- A single long word next to an AWS icon wraps mid-word; prefer short names.
- A self-step on the right-most actor clips its label; move the step or reorder the actors.
- At most ~12 nodes; `ArchitectureMap` at most 18 including `system-context`. Never drop real services to fit.
- GIF budget: changed pixels per frame drive the size. Never fade or animate the whole canvas; architecture maps reveal each edge in `ARCH_STEP` = 12 frames.

## Output location

Render into a `diagrams/` folder beside the vault section that owns the diagram (for example `docs/domains/<svc>/specs/diagrams/<name>`), set as `output` without extension. Outputs are a GIF plus a last-frame PNG; milestone `DependencyGraph` entries are PNG only (`animated: false`). About 12 fps, at most ~1200 px wide, target at most ~2 MB per GIF. No MP4, no web player.

## Verify loop (every diagram, every time)

1. `pnpm --filter @3mrai/diagrams test`
2. `make diagrams-render ID=<id>` (comma-separate several: `ID=a,b`; no `ID` renders all). `make diagrams-studio` opens Remotion Studio for live preview.
3. Read the rendered PNG and check contrast, clipping and overlapping labels. Tests cannot see an overflowing label.
4. `make diagrams-check` (reports `STALE?` for diagrams whose watched sources changed without a re-render).
5. Report each GIF's size; flag any over the 2 MB budget.

## Write boundary

- Write only `diagrams/**` and `docs/**/diagrams/*.{gif,png}`.
- Never edit a `.md` note under `docs/`; report embed needs in the handoff so `obsidian-vault` adds them.
- Never run git writes and never touch Linear. Leave work in the working tree.
- Code comments follow [[code-comments]]; run `python3 scripts/validate-comments.py <files>` on what you touch.
