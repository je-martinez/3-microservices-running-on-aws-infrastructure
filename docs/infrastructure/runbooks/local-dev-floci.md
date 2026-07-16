---
title: Local Dev — Floci
type: runbook
area: infra
status: active
created: 2026-07-12
updated: 2026-07-15
integration-status: verified
verified-on: 2026-07-15
verified-by: Jose E. Martinez
tags: [type/runbook, area/infra, status/active]
related:
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[local-dev]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[terraform-modules]]"
  - "[[local-dev-ministack]]"
  - "[[2026-07-15-orders-gateway-integration-design]]"
---

# Local Dev — Floci

## When to run this

Run this runbook when setting up or resetting a local development environment. It covers
bringing up **Floci** (the local AWS emulator — see [[ADR-0017-floci-local]]), applying the
`infra/environments/local` Terraform stack against it, running Prisma migrations, and
starting the Users service. This runbook **supersedes** [[local-dev-ministack]], which
described a Ministack-based flow no longer used by this repo.

## Prerequisites

- Docker Desktop (or OrbStack) running.
- `nvm use` to activate the pinned Node version (see `.nvmrc`, currently 24.18.0).
- No AWS credentials needed — Floci accepts dummy credentials (`test`/`test`); the root
  `Makefile` exports these defaults for you.

## The single supported entry point: `make bootstrap`

`make bootstrap` brings the whole local chain up from scratch, **in dependency order**. Do
not run the individual steps out of order — the Users service validates `COGNITO_*` env vars
with Zod at boot, and those ids only exist after the Terraform apply.

```bash
make bootstrap
```

This runs, in order:

1. **`docker compose up -d floci`** — starts Floci (the local AWS emulator: SQS, Lambda, ECS,
   RDS, S3, DocumentDB, Cognito, API Gateway, …) and waits (polling, up to 30s) until it
   responds on `http://localhost:4566`.
2. **`infra-init`** — `terraform init` against `infra/environments/local`.
3. **`infra-up`** — `terraform apply -auto-approve` against Floci, followed by `env-file`
   (regenerates the AUTO-GENERATED block of `./.env` from the fresh Terraform outputs — see
   below).
4. **`migrate`** — applies Prisma migrations (`migrate deploy`, never `migrate dev`) against
   Floci's Postgres, run as the cluster superuser so DDL succeeds even though the app DB user
   deliberately has no elevated privileges (see [[soft-delete]] / ADR-0004).
5. **`docker compose up -d --build users`** — builds and starts the Users service container.
6. **`bootstrap.sh`** (`infra/environments/local/bootstrap.sh`) — creates the least-privilege
   application DB user (no `DELETE` grant — see [[soft-delete]]) and sets up the
   `nginx-stable` Docker alias used by the reverse-proxy path (see [[ADR-0016-local-apigw-nginx-ecs]]).

The order matters precisely because of step 3→4→5: infra must exist before `.env` has real
Cognito ids, `.env` must be correct before the Users container starts (it fails Zod validation
otherwise), and migrations must run before the service can use the database.

## Other Make targets

### Docker Compose layer

| Target | Purpose |
|---|---|
| `make up` | Start the stack (Floci + services) in the background |
| `make down` | Stop the stack |
| `make logs` | Tail logs for all services (`make logs S=users` to scope to one) |
| `make build` | Build service images |
| `make ps` | Show container status |

### Terraform layer (against Floci)

| Target | Purpose |
|---|---|
| `make infra-init` | `terraform init` (`infra/environments/local`) |
| `make infra-plan` | `terraform plan` |
| `make infra-up` | `terraform apply -auto-approve`, then refreshes `./.env` via `env-file` |
| `make infra-down` | `terraform destroy -auto-approve` |
| `make infra-output` | Show Terraform outputs (Cognito ids, API Gateway id, DB endpoint, …) |

### Database

| Target | Purpose |
|---|---|
| `make migrate` | Apply Prisma migrations (users) against Floci's Postgres — idempotent (`migrate deploy`) |

### Orchestration

| Target | Purpose |
|---|---|
| `make bootstrap` | Bring the whole local chain up from scratch, in dependency order (see above) |
| `make clean` | Tear down infra + compose; **prompts** before removing `./data` (Floci's persisted state) |

### Observability (opt-in)

| Target | Purpose |
|---|---|
| `make observability-up` | Start OpenObserve + the OTel collector (~512MB–1.5GB RAM) — UI at `http://localhost:5080` |
| `make observability-down` | Stop the observability stack, leaving the rest running |

Run `make help` at any time for the authoritative, current list.

## `./.env` — the AUTO-GENERATED block

`make env-file` (invoked automatically by `infra-up`, and therefore by `bootstrap`) rewrites
**only** a labeled AUTO-GENERATED block inside `./.env` — every other line (manually-added
vars, e.g. `APIDOG_ACCESS_TOKEN`) is preserved untouched. The block currently contains:

- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`
- `API_GATEWAY_URL` (LocalStack-style: `http://localhost:4566/restapis/<api-id>/$default/_user_request_`)
- `USERS_DATABASE_URL` (a **host-reachable** Postgres URL, distinct from the in-container
  `DATABASE_WRITER_URL` which uses `floci:7001`)

These values must be rewritten from live Terraform outputs on every apply — **never
hand-edited** — because Floci mints a new user-pool/client id (and API id, and DB proxy
address) on every `apply`.

## Endpoints and ports

- Floci: `http://localhost:4566` (host) / `http://floci:4566` (in-network).
- Postgres: reached at **`floci:7001`** (Floci's RDS proxy port) — never by container IP,
  which Floci reassigns on every recreation. Writer and reader endpoints are the **same**
  locally; Floci does not emulate an Aurora read replica.
- Users service: direct at **`http://localhost:3000`**, health check at **`GET /v1/health`**.
- Orders service: direct at **`http://localhost:3001`** (host `3001` → container `8080`),
  health check at **`GET /v1/health`**.
- Local emulator state persists under **`./data/floci`** (git-ignored,
  `FLOCI_STORAGE_MODE=persistent` — see [[floci-storage-modes-and-tmp-corruption]]).

### Health through the API Gateway

As of the Orders↔gateway integration (see
[[2026-07-15-orders-gateway-integration-design]] and
[[ADR-0016-local-apigw-nginx-ecs]]), the gateway no longer exposes a bare `/v1/health` —
each service has its own per-service health path, which the nginx front door rewrites to
that service's internal, unprefixed `/v1/health`:

- `GET {API_GATEWAY_URL}/v1/users/health` → routed to `users:3000` → `{"status":"ok"}`
- `GET {API_GATEWAY_URL}/v1/orders/health` → routed to `orders:8080` → `{"status":"ok"}`

(`API_GATEWAY_URL` is the AUTO-GENERATED `.env` value described above.)

nginx routes by path prefix — `/v1/orders/*` goes to `orders:8080`, everything else goes to
`users:3000` — injecting the `x-user-id` header (the Cognito `sub`, decoded via njs) on every
location. Orders is now reachable through the front door, not only on its direct `:3001` port.

## Known limitation — second `apply` fails

A **second** `terraform apply` against the same Floci state fails (Floci's `UpdateTags`
implementation for API Gateway v2 / RDS resources is broken — see
[[floci-rds-apigw-limits]]). Do **not** attempt to re-apply on top of an existing stack. To
pick up infra changes:

```bash
make clean       # tear down (prompts before removing ./data)
make bootstrap    # rebuild from scratch
```

## Verification

- `curl http://localhost:3000/v1/health` returns HTTP 200 (Users, direct).
- `curl http://localhost:3001/v1/health` returns HTTP 200 (Orders, direct).
- `curl "$API_GATEWAY_URL/v1/users/health"` and `curl "$API_GATEWAY_URL/v1/orders/health"`
  both return `{"status":"ok"}` through the gateway → nginx front door.
- `make ps` shows `floci` and `users` as `Up`.
- `make infra-output` prints Cognito/API Gateway/DB outputs without error.
- `docker compose logs -f users` shows no Zod env-validation errors at boot.

## Related

- [[ADR-0017-floci-local]] — the decision to adopt Floci over Ministack, and its known quirks.
- [[ADR-0016-local-apigw-nginx-ecs]] — the local API Gateway → nginx → service reverse-proxy topology this bootstrap chain stands up.
- [[local-dev]] — the broader local-dev convention (`.http` files, Makefile overview).
- [[awscli-fallback-for-floci]] — how the Cognito app client and Pre-Token trigger are wired around Floci/provider gaps during `infra-up`.
- [[cognito-pre-token-lambda]] — the Lambda deployed as part of this stack's Cognito module.
- [[terraform-modules]] — the real module inventory composed by `infra/environments/local`.
- [[local-dev-ministack]] — the superseded Ministack runbook this note replaces.
- [[2026-07-15-orders-gateway-integration-design]] — the design behind routing Orders through
  the local API Gateway → nginx front door and the per-service health endpoints above.
