---
title: "Remotion Diagrams — Animated Flow and Architecture Diagrams Design"
type: spec
area: shared
status: draft
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/spec
  - area/shared
  - status/draft
propagates-to:
  - "[[git-workflow]]"
  - "[[milestone-plan]]"
  - "[[architecture]]"
  - "[[system-context]]"
  - "[[index]]"
  - "[[mcp-servers]]"
  - "[[scripting-language]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[diagrams]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[users-service-design]]"
  - "[[ADR-0020-self-owned-password-reset]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[aws-resources]]"
  - "[[openobserve-runbook]]"
  - "[[browser-rum]]"
  - "[[x-cache-response-header]]"
  - "[[preprod]]"
  - "[[two-phase-terraform-apply]]"
  - "[[users-service-milestone]]"
  - "[[services-infra-scaffold-milestone]]"
  - "[[documentation-vault-milestone]]"
related:
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[skill-propagation]]"
  - "[[doc-propagation]]"
---

# Remotion Diagrams — Animated Flow and Architecture Diagrams

## Goal

Replace draw.io with [Remotion](https://www.remotion.dev) for vault diagrams. Produce animated diagrams, exportable to GIF, of the system's current flows and AWS architecture. They are deliberately **not exhaustive**: enough to convey the flow and the steps traversed.

Three additions come with the tool swap:

- a dedicated implementer agent (`diagram-impl`);
- a convention to keep diagrams current when flows or AWS resources (local Floci, pre-prod) change;
- a PR convention to attach diagrams when they summarize a new or affected flow.

## Decisions (agreed with the user)

1. **Re-create the existing diagrams.** The 6 existing `.drawio.svg` files (architecture, system-context L1/L2, and 3 milestone dependency graphs: users-service, services-infra-scaffold, documentation-vault) are re-created in Remotion and the `.drawio.svg` files are deleted.
2. **Outputs.** Animated GIF plus a static PNG (last frame), committed next to the note in a `diagrams/` subfolder of the vault section and embedded with `![[<id>.gif]]`. "Interactive" means Remotion Studio locally (`make diagrams-studio`). No MP4, no web player.
3. **Catalog.** An initial set plus a backfill of the flows the system already has (decisions 6 and 7).
   - Architecture in two variants via props: `dev-floci` and `preprod` (ECS on Floci).
   - System-context L1 and L2.
   - Flows: `users-signup-otp` (Cognito CUSTOM_AUTH, email), `users-password-reset`, `orders-checkout-stripe` (cart, order, PaymentIntent, Stripe webhook, event, events pipeline), `tracking-notification` (carrier webhook, SNS, notification, WebSocket toast), `observability-telemetry` (OTel logs/traces/metrics to OpenObserve).
   - Milestone dependency graphs x3.
   - Backfill flows: see [Backfill catalog](#backfill-catalog).
4. **Approach A: data-driven with shared primitives.** Rejected: B, a bespoke component per diagram (drift and inconsistent style); C, a textual DSL parsed into Remotion (a parser is YAGNI).
5. **Drift detection.** A catalog with `watches` globs plus `make diagrams-check`, which warns and does not block.
6. **AWS icons are in scope.** Source: the npm package `@nxavis/aws-icons`, isolated behind a single adapter (see [AWS icons](#aws-icons)).
7. **Backfill is in scope.** The catalog is extended with 14 additional flows covering auth, shopping, events/realtime and observability/ops (see [Backfill catalog](#backfill-catalog)).

## Package `diagrams/`

A new pnpm workspace package, `@3mrai/diagrams`.

```text
diagrams/
  package.json            remotion, @remotion/cli, react, zod
  remotion.config.ts
  src/
    Root.tsx              registers one <Composition> per catalog entry
    catalog.ts            source of truth (see below)
    theme/                tokens: colour per node kind, typography
    primitives/
      ArchitectureMap.tsx zones + nodes + edges lighting up in order
      FlowSequence.tsx    actor lanes, numbered steps, one-line caption per step
      DependencyGraph.tsx phase columns for milestone plans (static PNG suffices)
      shared/             Node, Edge, Zone, StepCaption, Legend
    theme/
      aws-icons.ts        the ONLY file that imports @nxavis/aws-icons
    data/
      architecture/       dev-floci.ts, preprod.ts
      system-context/     l1.ts, l2.ts
      flows/              users-signup-otp.ts, users-password-reset.ts,
                          orders-checkout-stripe.ts, tracking-notification.ts,
                          observability-telemetry.ts, plus the backfill
                          flows listed under "Backfill catalog"
      milestones/         users-service.ts, services-infra-scaffold.ts,
                          documentation-vault.ts
    scripts/
      render.ts           GIF + last-frame PNG for one or all entries
      check-drift.ts      git diff vs main intersected with watches
```

- **`catalog.ts`** holds, per entry: `{ id, title, primitive, data, output, watches }`. `output` is the vault path (for example `docs/00-overview/diagrams/architecture-dev`); `watches` is a list of globs (for example `["infra/modules/**", "docker-compose.yml"]`).
- **Node kinds** in the theme: compute, data, messaging, edge, external.
- **`render.ts`** renders the GIF and last-frame PNG to the catalog `output`.
- **`check-drift.ts`** lists the diagrams possibly affected by the diff against `main`.
- **Validation.** Data props are validated with zod schemas, which also enables prop editing in Studio.
- **Scripting language.** The scripts are TS/JS because they live in the Node ecosystem, the exception [[scripting-language]] already allows.
- **Make targets:** `diagrams-studio`, `diagrams-render [ID=...]`, `diagrams-check`.
- **Browser.** Remotion needs Chrome Headless Shell, fetched on first render (`remotion browser ensure`). No Docker.
- **Defaults.** GIF around 12 fps, at most about 1200px wide, target at most about 2 MB per GIF. AWS services use official AWS icons through the adapter; non-AWS nodes are labelled boxes coloured by node kind.
- **Catalog size.** 26 diagrams (12 initial + 14 backfill). That is why `diagrams-render` renders by ID (`ID=...`) rather than all at once by default, and why the 2 MB budget applies per diagram: the committed binaries add up.

## AWS icons

**Source.** The npm package [`@nxavis/aws-icons`](https://www.npmjs.com/package/@nxavis/aws-icons): MIT, React components of the official AWS Architecture Icons, 307 icons, tree-shakable, single dependency `clsx`. Evaluated 2026-10-06: it covers every service the system uses (API Gateway, Aurora/RDS, Cognito, DocumentDB, DynamoDB, ElastiCache, EventBridge, SQS, SNS, SES, S3, ECR, ECS, Fargate, ELB, Lambda, CloudWatch, Secrets Manager, Systems Manager, IAM, VPC).

**Risk.** The package is young (v0.0.5, about 370 downloads per month, a single maintainer).

**Mitigations.**

- **Pin the exact version** (no caret). Install with `pnpm --filter @3mrai/diagrams add -E @nxavis/aws-icons` (pnpm, per [[package-manager]]).
- **Diagrams never import the package directly.** A single adapter, `diagrams/src/theme/aws-icons.ts`, maps our node kinds and services to icon components. Replacing the source (for example vendoring the official asset zip) touches one file.

**Non-AWS nodes** (browser, Stripe, OpenObserve, Floci, the external geocoder) keep labelled boxes.

## Backfill catalog

Data files for these live under `src/data/flows/`. Each entry carries `watches` globs pointing at its source (examples in parentheses).

**Auth and identity**

- `auth-passwordless-otp-signin`: Cognito custom-auth OTP Lambda, SNS/SQS, events-pipeline, SES, verify (`infra/modules/cognito/**`).
- `auth-password-signin-refresh`: sign-in, pre-token Lambda adds `app_user_id`, API Gateway JWT authorizer, refresh endpoint.
- `users-cognito-identity-webhook`: Cognito to Users identity sync.
- `users-account-deletion-cascade`: Users, Orders, Tracking soft-delete, account last, 502 on a failed step.

**Shopping**

- `orders-catalogue-cart`: catalogue with S3 images, cart, Money.
- `response-cache`: Valkey/ElastiCache read-through plus invalidation on write.
- `checkout-address-geocoding-proxy`: same-origin nginx proxy; the key never reaches the browser.

**Events and realtime**

- `tracking-outbox-relay`: outbox table, poller, SNS (`services/tracking-go/internal/outbox/**`).
- `events-pipeline-fanout-dlq`: SNS, SQS, single Lambda CQRS dispatch, SES/notification, quarantine and DLQ (`functions/events-pipeline/src/**`).
- `websocket-lifecycle`: authorizer, connect/disconnect/default, DynamoDB connections (`functions/realtime-events/**`).

**Observability and ops**

- `business-metrics`: services to CloudWatch, EventBridge `rate(1 minute)` tick, OTel collector to OpenObserve dashboards.
- `browser-rum`: web to OpenObserve RUM.
- `preprod-deploy`: `build_push`, ECR, ECS/ALB, integrations, Stripe listener (`infra/environments/preprod/**`).
- `terraform-two-phase-apply`: infra apply, then DB app users as post-effects.

**Output locations** follow the convention: a `diagrams/` subfolder beside the owning vault section. Domain flows go under `docs/domains/<svc>/…/diagrams`; cross-cutting flows under `docs/shared/…` or `docs/infrastructure/…`. The owning notes that embed these diagrams are **propagation targets**, to be routed via `obsidian-vault` during implementation (and added to `propagates-to:` then); `diagram-impl` only writes the renders.

## Agent `diagram-impl` and Remotion skills

**Skills.** Installed with `pnpm dlx skills add remotion-dev/skills` (a translation of the vendor's `npx` command, per [[package-manager]]) into `.ai/skills/`, so `make ai-sync` propagates them, and recorded in `skills-lock.json`. They are generic skills, propagated to all providers per [[skill-propagation]]. The agent preloads `remotion-best-practices`, `remotion-markup`, `remotion-render`, `remotion-studio` and `remotion-docs`.

**Agent definition.** `.claude/agents/diagram-impl.md` is a domain implementer like `web-impl` and `e2e-impl`:

- Writes only in `diagrams/` plus rendered artifacts `docs/**/diagrams/*.gif|png`. This is the single exception to `obsidian-vault` being the sole writer of `docs/`, and it is limited to binary renders.
- Never edits `.md` notes. Embedding needs are reported in its handoff for the parent to route to `obsidian-vault`.
- Never runs git or touches Linear.
- Is a thin agent that defers to a new `diagrams/CLAUDE.md` (stack, primitives, detail level, size budget).

**Source of truth for content.** It reads real code and Terraform before drawing, with no invented connections: `infra/modules/**` and `docker-compose*.yml` for architecture; handlers and each service's `openapi.yaml` for flows.

**Detail level.** At most about 12 nodes per diagram, at most about 10 steps per flow, one-line caption per step. Service and resource names only, never endpoints, fields or payloads.

**Mandatory verification.** Render and visually inspect the PNG (contrast, nothing clipped) before reporting; run `diagrams-check`; report the GIF size.

**When it is used.** When `diagrams-check` or the pre-PR audit flags an affected diagram, or when a new diagram is requested.

## Conventions

**New convention `diagrams` and ADR-0023.** The ADR, "Remotion as the vault diagram tool" (`ADR-0023-remotion-diagrams`), supersedes [[ADR-0015-drawio-diagrams]]. ADR-0015 is kept, with status superseded and `superseded-by` set. The convention rules:

- GIF and PNG are generated by Remotion, never hand-edited.
- `diagrams/` is a subfolder beside the vault section that uses it.
- **Keep-current rule.** A change that alters a diagrammed flow (steps, actors, services) or adds/removes an AWS resource (local Floci or pre-prod) updates the data file and re-renders in the same PR. `diagrams-check` flags it (non-blocking). The pre-PR gap audit runs it, and each warning is either resolved (re-render) or dismissed with a one-line justification in the PR.
- A new significant flow gets a new catalog entry with `watches`.
- Detail level and legibility rules: the draw.io lesson is rewritten as general diagram rules.

**PR convention in [[git-workflow]].** When a PR introduces a new flow or alters an existing diagrammed one, the PR body includes a `## Diagrams` section embedding the GIF (GitHub raw URL on the branch) plus one line on what changed. Mandatory when `diagrams-check` flagged something, optional otherwise.

**Hooks into existing conventions.**

- The `spec-implementation-audit` skill gains a step that runs `diagrams-check` (the code to docs direction).
- The deps diagram in [[milestone-plan]] becomes a `DependencyGraph` catalog entry.
- Root `CLAUDE.md` gets a one-line pointer in Working rules and `diagram-impl` in the subagent list, then `make ai-sync`.

## draw.io retirement

**Remove:**

- The 6 `.drawio.svg` files (after re-creation).
- `scripts/drawio-to-svg.mjs`.
- The `drawio` MCP server in `.mcp.json` and its projections (`.cursor/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `opencode.json`, `.ai/settings.json`), regenerated via `make ai-sync`, not by hand.
- Its permission in `.claude/settings.local.json`.

**Update notes:** [[architecture]], [[system-context]], [[index]], [[milestone-plan]], the 4 milestone plans (stripe-payments, documentation-vault, users-service, services-infra-scaffold), the [[mcp-servers]] runbook (pencil only), [[scripting-language]], and the comment in `scripts/validate-vault.mjs`.

**Rename** the lesson `drawio-diagram-legibility` to `diagram-legibility` (the content is still valid, generalized).

**Kept as historical record:** [[ADR-0015-drawio-diagrams]] (superseded), `docs/00-overview/sources/first-prompt-es.md` (source material), and the closed superpowers specs `2026-06-27-milestone-plan-convention-design` and `2026-07-19-scripts-to-python-migration-design`. The `.claude/worktrees/stripe-metadata` worktree is out of scope.

## Verification

- Typecheck and lint of the package; a unit test for `check-drift` (diff to expected diagrams) and one validating every catalog entry against its zod schema.
- Full `diagrams-render`; visual inspection of every PNG; each GIF at most about 2 MB.
- `validate-vault` green (embeds resolve), `make ai-sync-check` green, and `grep -ri drawio` empty outside the kept items.

## Out of scope

MP4 output, an embedded web player, and a blocking CI gate.

## Related

- [[ADR-0015-drawio-diagrams]]
- [[diagram-legibility]]
- [[milestone-plan]]
- [[git-workflow]]
- [[architecture]]
- [[system-context]]
- [[index]]
- [[mcp-servers]]
- [[scripting-language]]
- [[skill-propagation]]
- [[package-manager]]
- [[doc-propagation]]
