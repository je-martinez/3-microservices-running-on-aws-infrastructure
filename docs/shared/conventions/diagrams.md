---
title: Diagrams Convention
type: convention
area: shared
status: active
created: 2026-10-06
updated: 2026-10-12
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[git-workflow]]"
  - "[[milestone-plan]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[2026-10-07-aws-style-diagrams-design]]"
  - "[[2026-10-06-remotion-diagrams]]"
  - "[[package-manager]]"
  - "[[scripting-language]]"
---

# Diagrams Convention

Every animated flow, architecture map and milestone-dependency graph in the vault is rendered by Remotion from data, in the AWS reference-architecture style. Decision: [[ADR-0023-remotion-diagrams]] (see its style revision). Design: [[2026-10-07-aws-style-diagrams-design]]. The agent guide for the package is `diagrams/CLAUDE.md`.

## Tool and package

- Package `@3mrai/diagrams` in `diagrams/` (pnpm workspace; see [[package-manager]]). `remotion` and every `@remotion/*` package share one exact version.
- Make targets: `make diagrams-studio` (live preview), `make diagrams-render [ID=a,b]` (all when `ID` is omitted), `make diagrams-check`, `make diagrams-icons` (re-fetches the official group and generic icons).
- Scripts under `diagrams/src/scripts/*.ts` are TypeScript because they live in the Node ecosystem, the exception [[scripting-language]] allows. The icon fetcher is Python.

## One primitive: `AwsDiagram`

- Every diagram is one `AwsDiagramData` (`primitive: "aws"`): `groups[]` (`id`, `kind`, `label`, `parent?`), `nodes[]` (`id`, `label`, `sublabel?`, `icon`, `group?`), `edges[]` (`id`, `from`, `to`, `label?`, `async?`), optional `steps[]` (`edges`, `caption`) and `direction` (`RIGHT` default, or `DOWN`). The old `ArchitectureMap`, `FlowSequence` and `DependencyGraph` primitives are gone.
- **ELK does the layout** (layered, orthogonal routing, compound groups). Authors declare structure, never coordinates: if a layout looks wrong, fix the data (grouping, direction, fewer edges), never add positions.
- Group endpoints: an edge `from`/`to` may name a group id instead of a node; it is drawn to the group's frame.
- Edges: solid is a synchronous call, dashed (`async: true`) is a queue, topic, EventBridge rule or webhook. Declare each connection once; labels are short.
- Steps: each lists the edges it traverses, in order; a repeated connection reuses its edge and shows two badges. At most 10 steps, captions at most 90 characters. Numbered badges read 1 to n along the drawing, so order nodes so the path runs left to right.

### Group kinds

| Kind | Use for |
|---|---|
| `aws-cloud` | pre-prod: everything AWS-hosted; parent of the rest |
| `local-floci` | local dev: the Floci emulator stands in for the cloud |
| `region` / `az` | only when Terraform or the point of the diagram is regional or per-AZ |
| `ecs-cluster` | an ECS cluster: an ECS-orange frame with the ECS icon, holding the tasks it runs |
| `vpc` | resources Terraform places in the VPC (ECS tasks, databases, caches); optional `lanes` split it into 2 or 3 Availability Zone columns |
| `private-subnet` / `public-subnet` | inside the `vpc`, where Terraform places them |
| `corporate` | what runs outside AWS: browser and users, Stripe, Geoapify, external OpenObserve |
| `account` | an AWS account boundary, only when accounts matter |
| `generic` | a plain dashed grouping with no AWS meaning |
| `phase` | a milestone phase; tasks are `task` nodes, edges are dependencies |

`lanes` on a `vpc` are background columns (AZ label plus subnet sublabel) that are not part of the layout: the contents span them. Draw infrastructure as deployed: cluster, then tasks, ALB and AZ lanes. An ECS service runs one task (`desired_count` 1) and is drawn once with the official `ecs-task` icon, never duplicated per AZ; ECS places the task. The `ecs-task`, `ecs-service` and `alb` icons are the official resource icons fetched by `make diagrams-icons`.

Serverless or regional services (SQS, SNS, Cognito, S3, SES, Lambda, API Gateway, DynamoDB) sit inside the cloud group but outside the `vpc`, unless Terraform puts them in it. A flow states its environment in the subtitle; local dev unless the flow is pre-prod-specific.

## Icons

- Service nodes use an `AwsService` value from the `@nxavis/aws-icons` package (pinned exactly). Group and generic icons (users, client, internet, server, and so on) are the official AWS Architecture Icons SVGs, committed under `diagrams/public/aws-icons/` and re-fetched by `make diagrams-icons`. Milestone tasks use the `task` icon.
- Only `diagrams/src/theme/aws-icons.ts` imports icon packages; everything else asks the adapter, so replacing an icon source touches one file.
- Non-AWS things with no official icon (Stripe, OpenObserve, Geoapify) use a generic icon plus their name; third-party brand logos are out of scope.

## Outputs and location

- Rendered by Remotion and **never hand-edited**. A diagram **with steps** produces a GIF (24 fps, scaled to at most 1200 px wide, at most about 2 MB) plus a last-frame PNG at full size, with the numbered step list below the drawing. A diagram **without steps** (architecture maps, milestone graphs) is **PNG only**: embed `![[<basename>.png]]`, never `.gif`.
- Committed in a `diagrams/` subfolder beside the vault section that owns the diagram (for example `docs/domains/orders/specs/diagrams/`, `docs/plans/diagrams/`). Embed by **output basename** (Obsidian resolves by basename). For most diagrams the basename equals the id; for milestone graphs it differs (id `milestone-<slug>-deps`, embed `![[<slug>-deps.png]]`).
- The architecture maps are wide (at most 2000 px: pre-prod 2000x1080, L2 1560x900, dev 1360x1000); the note embedding one tells the reader to open the image full size.
- Milestone graphs lay out `DOWN` (phases stacked top to bottom).
- The blank band under the caption in a mid-animation still is expected: it is the reserved caption area, not a rendering fault. No MP4, no web player.

## Catalog and `watches`

- `diagrams/src/catalog.ts` is the source of truth, aggregating `diagrams/src/data/<group>.catalog.ts`. Each entry holds `id`, `title`, `primitive`, `data`, `output` (vault path without extension), `watches` and a required `source` (the path of the data module that defines the diagram).
- `watches` are globs of the real files the diagram depicts (Terraform modules, handlers, `openapi.yaml`). A glob that matches nothing fails the catalog test; keep them tight and real, because a typo silently disables drift detection.
- Every entry uses the one primitive, `AwsDiagram`; its `source` module path is unique and tracked. `id`, `output` and the output basename are unique across the catalog.

## Detail level

- Service and resource names only, never endpoints, request fields or payloads. Content is read from real code and Terraform, never invented.
- About 12 nodes per diagram at most (schema caps: 30 nodes, 16 groups, 40 edges). Never drop real services to fit: group them instead.
- **Coverage rule.** Architecture maps and the L2 container view draw **every runtime AWS service the environment deploys** as its own node: one node per service, with its instances in the sublabel (for example "CloudWatch — Logs + Metrics", "WS Lambdas — 4 functions"), and its real connections. Only implicit pieces are omitted: IAM roles and policies, security groups, route tables, target groups, listeners and individual parameters. Never fold a service into another node's sublabel (Cognito into API Gateway, DynamoDB into the WebSocket API). Deploy-time resources (Terraform state S3 bucket, DynamoDB lock and execution-log tables) appear in the `terraform-two-phase-apply` flow, not on runtime maps. See [[diagram-legibility]].
- At most 10 steps per diagram, one-line captions of at most 90 characters.
- A flow usually has 3 to 7 actors; put the user or browser at the left edge.

## Layout lessons

- **Draw shared connections once, from the group frame.** When several members of a group share the same connection (a fan-out to or from the same peer), use a **group endpoint**: an edge `from` or `to` may be a group id, and the edge is drawn to the group frame. Never split a group in two to dodge the fan-out, and never draw one resource twice. A group whose members sit on both sides of another group along the flow may be drawn as two adjacent frames of the same kind, each holding different resources and labelled distinctly (e.g. orders-checkout-stripe's "Floci — data" / "Floci — events"); that is not drawing a resource twice. Shared fan-out still uses a group endpoint.
- **No resource is drawn twice.** One real resource is one node; a second appearance to simplify routing is a data error.
- **`compact: true`** (optional data field, `diagrams/src/aws/schema.ts`, `layout.ts`): declaration order defines the left-to-right flow. An edge to an earlier-declared node is a back edge and adds no column; edge labels take no space between layers (the post-pass places them). Declare in flow order: entry -> compute -> data -> events/externals. The architecture and L2 maps use it, with the entry on the left (Browser -> API Gateway -> ALB -> ECS cluster -> data -> events) and a width of at most 2000 px. Pre-prod has no separate "Event pipeline" group, and Browser -> API Gateway is labelled "/v1 via web" because the web task's nginx proxies /v1 to API Gateway.
- Data order is a layout hint: list groups, nodes and edges in the visual flow order. Never reorder nodes just to dodge a crossing.
- Back edges (right to left) are fine only when short; otherwise move the target next to its source.
- Prefer one edge per node pair with a distinct label over two labelled parallel edges, which read as a bracket.
- Prefer `direction: "RIGHT"` for flows. Keep names short; a single long word next to an icon wraps mid-word.
- The renderer widens the canvas for long titles and captions and keeps badges off labels; do not shorten captions to fit.
- **Catalog quality gate.** `diagrams/test/aws-catalog-quality.test.ts` lays out every catalog entry and fails on layout defects: labels nearer their own route and at least 6px from others, off nodes, headers and other labels and inside the canvas; badges off nodes, headers, labels and other badges, and outside their own self-loop; nodes inside their groups; routes inside the canvas and off non-endpoint nodes; frame ports not level with member icons; resources drawn twice; layout and annotation deterministic; badge and label placement throws "no room for …" (with the diagram id) instead of degrading. Fix the data or the layout; never weaken the test.
- Read the PNG **and** a mid-animation still, and reject the result if any edge circles the canvas or crosses a group it does not enter. Rules and history: [[diagram-legibility]].

## GIF budget

GIF size is driven by **changed pixels per frame**, not by frame count. Frame 0 is the complete diagram with neutral edges; only the active step's edges highlight. Never fade or animate the whole canvas, and keep the canvas size an integer (whole 20 px multiples), otherwise the encoder stores whole frames. Dropping real services to fit the budget is the wrong fix; reduce what changes per frame instead.

## Keep-current rule

A change that alters a diagrammed flow (steps, actors, services) or adds or removes an AWS resource (local Floci or pre-prod) updates the data file and re-renders **in the same PR**. When Terraform adds or removes an AWS resource, the maps gain or lose its node in the same PR. A new significant flow gets a new catalog entry with `watches`.

### `diagrams-check`

`make diagrams-check` lists diagrams whose watched sources changed against `main` (`DIAGRAMS_BASE` overrides the base) and prints `STALE?` for each. It warns and always exits 0, including when the base cannot be resolved. Each entry's implicit watches are its `source` module, `diagrams/src/aws/**`, `diagrams/src/theme/**`, `diagrams/public/aws-icons/**`, `diagrams/src/schema.ts`, `diagrams/src/Root.tsx`, `diagrams/src/scripts/render.ts` and `diagrams/package.json`; test files are ignored. On a task branch (task → feature flow, see [[git-workflow]]) set `DIAGRAMS_BASE=feature/<x>` so the diff is taken against the feature branch. The pre-PR gap audit runs it. Each warning is either **resolved** (re-render and commit the new output) or **dismissed** with a one-line justification in the PR (for example "Terraform tag change only; the flow is unchanged").

## PR rule

The PR body carries a `## Diagrams` section; the exact wording is in [[git-workflow]]. Mandatory when `diagrams-check` flagged something, optional otherwise.

## Write boundary

`diagram-impl` writes only `diagrams/**` and `docs/**/diagrams/*.{gif,png}`. It never edits a `.md` note, never runs git and never touches Linear. Embeds and prose go through `obsidian-vault`, from the embed needs `diagram-impl` reports in its handoff.

## Related

- [[ADR-0023-remotion-diagrams]]
- [[diagram-legibility]]
- [[git-workflow]]
- [[milestone-plan]]
- [[package-manager]]
- [[scripting-language]]
- [[2026-10-07-aws-style-diagrams-design]] — the AWS reference style behind this note
- [[2026-10-06-remotion-diagrams-design]] — design of the Remotion diagram pipeline
- [[2026-10-06-remotion-diagrams]]
