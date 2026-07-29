---
title: Local Development
type: convention
area: shared
status: active
created: 2026-07-03
updated: 2026-07-28
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
  Postgres.
- **Orchestration:** `make bootstrap` (compose up floci → wait for Floci → apply infra →
  regenerate `.env` → migrate → build/start `users` → `bootstrap.sh`) and `make clean` (tear
  down, prompts before removing `./data`).
- **Observability:** `make observability-up` / `make observability-down` — opt-in OpenObserve
  + OTel collector stack.

## Testing endpoints with `.http` files

Endpoints are exercised with the VS Code **REST Client** extension
(`humao.rest-client`). Install it, open a service's `.http` file, and click
**"Send Request"** above a request.

**Convention: one `.http` per service, added as the service is built.** The file
lives next to the service code and is named after it:

- `services/users/users.http` — exists today.
- `services/orders/orders.http`, `services/tracking/tracking.http`, … — add each when
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
