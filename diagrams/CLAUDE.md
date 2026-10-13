# CLAUDE.md — diagrams/

Remotion package `@3mrai/diagrams`: every animated flow, architecture and milestone-dependency diagram in the vault is rendered from here. Convention and decision: [[diagrams]]. The agent that works here is `diagram-impl`.

## Stack

- `remotion` and every `@remotion/*` package pinned to the same exact version (`4.0.533`, no caret). Bump them together or not at all.
- React 19, TypeScript 6, zod 4 (schemas), Vitest 4 (tests). `@nxavis/aws-icons` pinned exact.
- pnpm only: `pnpm --filter @3mrai/diagrams <script>`, `pnpm dlx`. Never `npm`/`npx`. Run `nvm use` first.
- Layout: `src/catalog.ts` (aggregates `src/data/<group>.catalog.ts`, one entry per diagram), `src/aws/` (schema, ELK layout, timing, renderer), `src/data/{architecture,system-context,flows,milestones}/*.ts`, `src/theme/`, `src/scripts/{drift,check-drift,render}.ts`, `test/`.

## The AwsDiagram model — the only way to author a diagram

Every diagram is one `AwsDiagramData` (`primitive: "aws"`, schema in `src/aws/schema.ts`) drawn in the AWS reference-architecture style. The pre-AWS primitives (`ArchitectureMap`, `FlowSequence`, `DependencyGraph`) are removed.

- `groups[]` `{ id, kind, label, parent?, lanes? }` nest into containers; `nodes[]` `{ id, label, sublabel?, icon, group? }`; `edges[]` `{ id, from, to, label?, async? }`; `steps[]` `{ edges: [edgeId...], caption }`; `direction` is `RIGHT` (default) or `DOWN`.
- **ELK does the layout.** Never hand-position anything, never reorder nodes to dodge a crossing: declare groups, nodes and edges, pick `direction`, render.
- **Icons:** a service node uses an `AwsService` value (e.g. `sqs`, `lambda`); a non-AWS thing (browser, users, Stripe, OpenObserve, Geoapify) uses a `GenericIcon` (`users`, `client`, `internet`, `server`, `office-building`, `firewall`, `data-table`); a deployed ECS task, ECS service or Application Load Balancer uses the resource icons `ecs-task`, `ecs-service`, `alb`; a milestone task uses `task`. An ECS task node takes the sublabel `Fargate · 1 task`. Only `src/theme/aws-icons.ts` imports icon packages; the official group and generic SVGs live in `public/aws-icons/` and `make diagrams-icons` re-fetches them.
- **Edges:** solid = synchronous call; `async: true` = dashed, for queues, topics, EventBridge and webhooks. Each connection is declared once; edge labels are short (schema cap 24).
- **Steps:** each step lists the edges it traverses, in order; a repeated connection reuses its edge (two badges). At most 10 steps, caption at most 90 characters. A diagram with no steps is PNG only (no GIF).

### Group kind — pick by where the thing really runs

| Kind | Use for |
|---|---|
| `aws-cloud` | pre-prod: everything AWS-hosted. Parent of the rest |
| `local-floci` | local dev: the Floci emulator stands in for the cloud |
| `region` / `az` | only when the Terraform or the point of the diagram is regional or per-AZ |
| `vpc` | resources Terraform places in the VPC (ECS tasks, databases, caches). For Availability Zones give it `lanes` (2–3, `{ label: "us-east-1a", sublabel?: "Public subnet 10.1.1.0/24" }`): dashed AZ columns behind its contents, outside the layout |
| `ecs-cluster` | an ECS cluster inside the `vpc`; its `ecs-task` nodes are the services running on it |
| `private-subnet` / `public-subnet` | inside the `vpc`, where Terraform places them (public: load balancer) |
| `corporate` | what runs outside AWS: browser and users, Stripe, Geoapify, OpenObserve outside AWS (or no group) |
| `account` | an AWS account boundary, only when accounts matter |
| `generic` | a plain dashed grouping with no AWS meaning |
| `phase` | a milestone phase; its tasks are `task` nodes, edges are dependencies |

Serverless or regional services (SQS, SNS, Cognito, S3, SES, Lambda, API Gateway, DynamoDB) sit inside the cloud group but outside the `vpc`, unless Terraform puts them in it. A flow states its environment in the subtitle; local dev unless the flow is pre-prod-specific.

## Detail level

- At most ~12 nodes per diagram; schema caps are 24 nodes, 16 groups, 30 edges. Never drop real services to fit: group them instead.
- At most 10 steps. One-line caption per step, at most 90 characters (the schema enforces label, sublabel and caption lengths).
- Show service and resource names only. Never endpoints, request fields or payloads.
- Content is read from real sources, never invented.

## Read the source before drawing

- Architecture and system context: `infra/modules/**`, `infra/environments/{local,preprod}/**`, `docker-compose*.yml`.
- Flows: the handlers plus `services/<svc>/openapi.yaml`.
- Milestone graphs: the milestone-plan note and its dependency diagram.

## Adding or changing an entry

1. Add the data file under `src/data/<kind>/` and its entry in `src/data/<group>.catalog.ts` (never directly in `src/catalog.ts`), with `source` set to the data file's repo-relative path (e.g. `diagrams/src/data/flows/users-signup-otp.ts`). The catalog test requires it to exist and be tracked.
2. Every entry declares `watches`: globs of the handlers/modules the diagram depicts, not whole service trees. `test/catalog.test.ts` fails when a glob matches nothing, and `make diagrams-check` relies on them. A typo silently disables drift detection, so keep them tight and real. Implicit watches (shared render code every diagram depends on): the entry's `source`, `src/aws/**`, `src/theme/**`, `public/aws-icons/**`, `src/schema.ts`, `src/Root.tsx`, `src/scripts/render.ts` and `diagrams/package.json`. Test files never count as drift.
3. `id`, `output` and the output **basename** must be unique across the catalog (Obsidian resolves an embed by basename). `output` has no extension; the renderer adds `.gif` and `.png`.
4. Edges reference declared node or group ids (never a group and its own content) and steps reference declared edge ids; the schema rejects unknown and duplicate ids.
5. AWS icons: only `src/theme/aws-icons.ts` imports icon packages (`@nxavis/aws-icons` for services, the committed official SVGs for groups and generic icons). Everything else asks the adapter.

## Authoring rules

Full text: [[diagrams]]. In short:

- Declare structure, not coordinates: groups, nodes, edges, `direction`. If a layout looks wrong, fix the data (grouping, direction, fewer edges), never add positions.
- When several nodes of a group share a connection, draw ONE edge from (or to) the group: `from`/`to` accept a group id, and the edge meets the group's frame. Never repeat the same connection per member.
- Draw each ECS task once inside its `ecs-cluster`, never one copy per AZ lane: ECS places the tasks across the zones, and the lanes only show that the VPC spans them.
- Keep names short; a single long word next to an icon wraps mid-word.
- Never animate the whole canvas. GIF budget: changed pixels per frame drive the size; the renderer only lights the active step's edges, so keep steps few and focused.

## Output location

Render into a `diagrams/` folder beside the vault section that owns the diagram (for example `docs/domains/<svc>/specs/diagrams/<name>`), set as `output` without extension. Outputs are a GIF plus a last-frame PNG (with the numbered step list below the drawing); a diagram without steps is PNG only and has no `.gif`. 24 fps, GIF scaled to at most 1200 px wide (PNG at full size), target at most ~2 MB per GIF. No MP4, no web player.

## Verify loop (every diagram, every time)

1. `pnpm --filter @3mrai/diagrams test`
2. `make diagrams-render ID=<id>` (comma-separate several: `ID=a,b`; no `ID` renders all). `make diagrams-studio` opens Remotion Studio for live preview.
3. Read the rendered PNG, and for a diagram with steps also a mid-animation still, and compare with the AWS reference look: nested group containers with their icons, service icons with names below, thin orthogonal connectors (dashed for async), numbered badges matching the step list, nothing clipped or overlapping. Tests cannot see an overflowing label.
4. `make diagrams-check` (reports `STALE?` for diagrams whose watched sources changed without a re-render).
5. Report each GIF's size; flag any over the 2 MB budget.

## Write boundary

- Write only `diagrams/**` and `docs/**/diagrams/*.{gif,png}`.
- Never edit a `.md` note under `docs/`; report embed needs in the handoff so `obsidian-vault` adds them.
- Never run git writes and never touch Linear. Leave work in the working tree.
- Code comments follow [[code-comments]]; run `python3 scripts/validate-comments.py <files>` on what you touch.
