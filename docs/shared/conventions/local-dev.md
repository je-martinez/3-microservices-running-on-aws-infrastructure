---
title: Local Development
type: convention
area: shared
status: active
created: 2026-07-03
updated: 2026-08-27
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev-floci]]"
  - "[[git-workflow]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[2026-07-03-local-dev-tooling-design]]"
  - "[[2026-07-03-local-dev-tooling]]"
  - "[[package-manager]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
---

# Local Development

How to run the stack locally and exercise service endpoints. Full step-by-step bootstrap
flow: [[local-dev-floci]].

## Makefile

The root `Makefile` orchestrates local dev across two layers — docker-compose
(Floci + services) and Terraform applied against Floci. Run `make help` for the
list. Key targets:

- **Compose:** `make up` / `make down` / `make logs` (`make logs S=users` to scope) /
  `make build` / `make ps`.
- **Infra (Terraform against Floci):** `make infra-init` / `make infra-plan` /
  `make infra-up` / `make infra-down` / `make infra-output`. These target
  **`infra/environments/local`** (the `Makefile`'s `TF_LOCAL_DIR`) — the consolidated local
  environment composing the real Terraform modules (see [[ADR-0017-floci-local]]); the earlier
  `spike-floci` stack has been deleted.
- **Database:** `make migrate` — applies Prisma migrations (`migrate deploy`) against Floci's
  Postgres (Users). `make migrate-tracking` — applies golang-migrate migrations against Floci's
  MySQL (Tracking); idempotent, and stamps rather than replays against a database Alembic
  already built (`migrate force 1`), never a plain `up`, on the shared local database.
- **Orchestration:** `make bootstrap` (compose up floci → wait for Floci → apply infra →
  regenerate `.env` → migrate → build/start `users`/`orders`/`tracking` → nginx alias), split
  into a not-safely-repeatable `make bootstrap-provision` and a resumable, idempotent
  `make bootstrap-converge`; `make doctor` for a read-only diagnosis of the stack's actual
  state; `make post-infra` for the phase-2 DB app-user apply; and `make clean` for teardown.
  Full detail: [[local-dev-floci]].
- **Observability:** `make observability-up` / `make observability-down` — opt-in OpenObserve
  + OTel collector stack. OpenObserve is now the single backend for **both** logs and traces
  (Jaeger was removed 2026-08-21 — see [[ADR-0019-distributed-tracing-opentelemetry]] Amendment).
  Full runbook: [[openobserve-runbook]].

> [!warning] `make clean` no longer prompts — "clean means clean"
> `clean` used to ask before removing `./data`, **defaulting to keeping it**, which made a
> from-scratch teardown non-deterministic: containers went away while the state claiming they
> existed stayed behind, and the next apply silently skipped recreating resources it believed
> were still `available`. It now runs unconditionally and unattended:
>
> 1. `docker compose --profile observability --profile preview down -v --remove-orphans` — both
>    profiles named explicitly (`down` skips services behind a profile it wasn't told about, so
>    an unscoped `down` previously left `openobserve`/`otel-collector`(/`jaeger`, before its
>    2026-08-21 removal) running, still holding their volumes and the network).
> 2. Removes any volume still **labelled** `com.docker.compose.project=3mrai` that the current
>    compose file no longer declares — `down -v` only removes volumes the file currently lists,
>    so a volume created under an earlier compose revision (e.g. an old `otelcol-storage`
>    checkpoint volume) can silently outlive every clean otherwise.
> 3. Removes **Floci's own containers** (ECS tasks etc., launched through the mounted Docker
>    socket) by the `floci-` name prefix, and the `3mrai_3mrai-network` network. These carry no
>    `com.docker.compose.project` label, so plain `down`/`--remove-orphans` never sees them —
>    without this step a stale nginx ECS task could survive a full clean and hold the network
>    open, so the next bootstrap built on a network it did not create.
>
> See the `clean:` target in the root `Makefile` for the full reasoning behind each step.

> [!warning] `make observability-up` starts OpenObserve + the collector, seeds the traces schema, and imports the dashboards
> The target starts two services: `openobserve` and `otel-collector`. Both logs and traces route
> to OpenObserve now — Jaeger was removed 2026-08-21 (see
> [[ADR-0019-distributed-tracing-opentelemetry]] Amendment). It then polls OpenObserve's
> `/healthz` (the container declares no compose healthcheck, so `up -d` returns before it accepts
> HTTP), runs `make observability-traces-schema` (seeds the `gen_ai_*` fields the trace waterfall
> requires — see [[openobserve-runbook#Traces]]), and runs `make observability-dashboards`
> automatically. Both import steps matter because their state lives in the `openobserve-data`
> volume — the one `make clean` now deletes (above) — and nothing recreated them before this:
> every from-scratch rebuild left OpenObserve healthy but with zero dashboards and a broken trace
> waterfall, recoverable only by remembering undocumented manual commands. Full detail:
> [[openobserve-runbook]].

## Testing endpoints with `.http` files

Endpoints are exercised with the VS Code **REST Client** extension
(`humao.rest-client`). Install it, open a service's `.http` file, and click
**"Send Request"** above a request.

**Convention: one `.http` per service, added as the service is built.** The file
lives next to the service code and is named after it:

- `services/users/users.http` — exists today.
- `services/orders/orders.http`, `services/tracking-go/tracking-go.http`, … — add each when
  that service gains real endpoints. Follow the same shape (a file-level `@baseUrl`,
  `###`-separated requests, and named requests like `# @name register` so later
  requests can reference captured response fields, e.g.
  `{{register.response.body.$.id}}`).

For a service to be reachable from the host, its container port must be **published**
in `docker-compose.yml` (`ports: - "3000:3000"` for users). Add the same mapping when
a new service needs local testing.

## Related

- [[ADR-0017-floci-local]]
- [[local-dev-floci]]
- [[git-workflow]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[2026-07-03-local-dev-tooling-design]] — the design spec that introduced the Makefile + `.http` convention.
- [[2026-07-03-local-dev-tooling]] — the implementation plan for that design.
- [[package-manager]] — pnpm as the repo's only Node package manager.
- [[openobserve-runbook]] — full detail on `make observability-up`/`-down` (traces-schema seed,
  dashboard auto-import) referenced above.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the tracing-backend decision; its 2026-08-21
  Amendment records Jaeger's removal and OpenObserve becoming the single backend for logs and
  traces.
