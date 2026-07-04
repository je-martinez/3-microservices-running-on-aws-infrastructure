---
title: Local Development
type: convention
area: shared
status: active
created: 2026-07-03
updated: 2026-07-03
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev-ministack]]"
  - "[[git-workflow]]"
---

# Local Development

How to run the stack locally and exercise service endpoints.

## Makefile

The root `Makefile` orchestrates local dev across two layers — docker-compose
(Floci + services) and Terraform applied against Floci. Run `make help` for the
list. Key targets:

- **Compose:** `make up` / `make down` / `make logs` (`make logs S=users` to scope) /
  `make build` / `make ps`.
- **Infra (Terraform against Floci):** `make infra-init` / `make infra-plan` /
  `make infra-up` / `make infra-down` / `make infra-output`. These target
  `infra/environments/local/spike-floci` — the current Floci spike (see
  [[ADR-0017-floci-local]]); repoint when a consolidated `local` environment exists.
- **Orchestration:** `make bootstrap` (compose up → wait for Floci → apply infra) and
  `make clean` (tear down, prompts before removing `./data`).

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
- [[local-dev-ministack]]
- [[git-workflow]]
