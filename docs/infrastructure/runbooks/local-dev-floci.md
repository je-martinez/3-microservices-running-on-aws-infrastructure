---
title: Local Dev — Floci
type: runbook
area: infra
status: active
created: 2026-07-12
updated: 2026-07-31
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
  - "[[rds-aurora-engine-switchable-floci]]"
  - "[[two-phase-terraform-apply]]"
  - "[[terraform-remote-state-backend]]"
  - "[[local-gateway-per-route-integrations]]"
  - "[[nginx-njs-x-user-id-injection]]"
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
   deliberately has no elevated privileges (see [[soft-delete]] / ADR-0004). The same
   superuser-for-migrations, least-privilege-for-runtime split applies to the MySQL cluster's
   Alembic/EF Core migrations — see the note in
   [[two-phase-terraform-apply#Update 2026-07-30 — the MySQL provider no longer hangs]].
5. **`docker compose up -d --build users`** — builds and starts the Users service container.
6. **`bootstrap.sh`** (`infra/environments/local/bootstrap.sh`) — creates the least-privilege
   application DB user (no `DELETE` grant — see [[soft-delete]]) and sets up the
   `nginx-stable` Docker alias used by the reverse-proxy path (see [[ADR-0016-local-apigw-nginx-ecs]]).
   As of 2026-07-30, MySQL app-user creation (`orders_app`, `tracking_app`) has moved to the
   Terraform phase-2 root (`enabled_app_users` now includes `mysql`) — see
   [[two-phase-terraform-apply]] — rather than being created here by bash. Phase 2 has not yet
   been applied, so those users do not exist in the local database yet.

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
| `make bootstrap-provision` | Phase 1 of `bootstrap`: Floci + Terraform apply + env files. **Not** safely re-runnable — see below |
| `make bootstrap-converge` | Phase 2 of `bootstrap`: migrations + services + nginx alias. **Safe to re-run** — resumes a partial `bootstrap` |
| `make doctor` | Read-only diagnosis of the local stack — see below |
| `make post-infra` | Phase 2 Terraform apply: least-privilege DB app-users (see [[two-phase-terraform-apply]]) |
| `make clean` | Tear down infra + compose; **prompts** before removing `./data` (Floci's persisted state) |

#### `bootstrap-provision` / `bootstrap-converge` — the two halves of `bootstrap`

`make bootstrap` is `bootstrap-provision` followed by `bootstrap-converge`. They exist as
separate targets because only the first half is irrepeatable: a **second** phase-1
`terraform apply` against the same Floci state fails on `UpdateTags` (JE-113, see
[[floci-rds-apigw-limits]] below). So a run that dies partway through `bootstrap` is resumed
with `bootstrap-converge` alone, never by re-running `bootstrap-provision`'s apply.

- **`bootstrap-provision`** — `docker compose up -d floci` → wait for Floci → `backend-up` →
  `infra-init` → `infra-up` (Terraform apply, then `env-file`).
- **`bootstrap-converge`** — starts with `env-file` (safe: it reads existing Terraform
  outputs, it does not apply, so it cannot hit JE-113) because `migrate-tracking` reads
  `DATABASE_WRITER_URL` from `.env.local.tracking`, which `env-file` (re)writes. Then:
  `migrate` → start `users` → start `orders` → `migrate-tracking` → start `tracking` →
  `bootstrap.py` (the nginx alias, last — see the resolved limitation below for why). Every
  step here is idempotent, so re-running it costs time and nothing else.

#### `make doctor` — read-only diagnosis

`make doctor` (`infra/scripts/doctor.py`) reports which state the local stack is actually in
— what ran, what did not, and the command to finish it — without changing anything. Every
check is a `SELECT`, a `SHOW`, an HTTP `GET`, or a `docker inspect`; it repairs nothing, it
only prints the fix. This is deliberate: a doctor that repairs is a doctor you can no longer
trust to diagnose, because you can't tell whether it found the system healthy or made it so.

Its standout check is the one nothing else in this repo surfaces: **a database that exists
while its tables do not.** Phase-1 Terraform creates the `tracking` (and `orders`) database;
`make migrate-tracking`, much later in the chain, creates its tables. Everything upstream of
that gap reports healthy — the container starts, `/v1/health` answers 200, `SHOW DATABASES`
lists `tracking` — right up until the first real query fails with `Table 'tracking.tracking'
doesn't exist`. This is exactly the state a bootstrap that died before `migrate-tracking`
leaves behind (JE-112, see the resolved limitation below).

Run it any time the stack's state is unclear — after a partial `bootstrap`, before filing a
bug against a service, or as a sanity check before `make post-infra`.

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

## Related decisions layered on this bootstrap

Several infra decisions extend this runbook's flow without changing the entry point
(`make bootstrap` is still the one supported path):

- [[rds-aurora-engine-switchable-floci]] — why the RDS module targets real Postgres/MySQL
  containers instead of Aurora locally.
- [[two-phase-terraform-apply]] — the second apply phase that creates least-privilege DB
  app-users after phase 1's infra is live.
- [[terraform-remote-state-backend]] — state moved to S3 + DynamoDB, `backend-up` runs first.
- [[local-gateway-per-route-integrations]] — why the local API Gateway needs one integration
  per route.
- [[nginx-njs-x-user-id-injection]] — how local identity (`x-user-id`) is injected.

## Known limitation — second `apply` fails

A **second** `terraform apply` against the same Floci state fails (Floci's `UpdateTags`
implementation for API Gateway v2 / RDS resources is broken — see
[[floci-rds-apigw-limits]]). Do **not** attempt to re-apply on top of an existing stack. To
pick up infra changes:

```bash
make clean       # tear down (prompts before removing ./data)
make bootstrap    # rebuild from scratch
```

## Resolved — `bootstrap.py` health check used to have no retry

Between 2026-07-30 and 2026-07-31 `make bootstrap` reproducibly failed at the `bootstrap.py`
step with the nginx alias already attached correctly:

```
NO: alias attached but /v1/health did not return the expected body (got: '')
   the users container may not be ready yet; re-run after it is up.
make: *** [bootstrap] Error 1
```

This is recorded here — rather than deleted — because the fix is *why*
`bootstrap-provision`/`bootstrap-converge` and `make doctor` exist (see below); the failure
mode explains the tooling.

**Original cause:** the script queried `/v1/health` **once**, after a fixed `time.sleep(1)`,
and the `users` container was usually not yet responding at that point. The alias
attachment — the script's actual job — succeeded; only the follow-up health probe failed,
but it still returned exit 1 and aborted the rest of the `bootstrap` chain. The asymmetry
that gave it away: the same script **did** retry to locate the nginx container
(`find_nginx_container(attempts=20, sleep_s=3)`), but the health check right after it was a
single attempt behind one second of sleep — two waits in the same script, only one of them
robust.

**Why it mattered more than it looked:** `bootstrap.py` sat mid-chain, before `orders`,
`migrate-tracking`, and `tracking`. A failure there didn't just abort the alias step — it
skipped every step after it, which is how a cold bootstrap ended up with Tracking's database
created but its tables missing (JE-112): `orders` never started, `migrate-tracking` never
ran, `tracking` never started, and the run still reported healthy everywhere a shallow check
would look, right up until the first real query.

**Fix, in two parts (commit `cc43ded`, following up on `b43fbd9`'s original record of this as
a known limitation):**

1. **`bootstrap.py` moved to the END of the chain.** The Makefile comment above it used to
   claim the services depended on the alias ("and only then the services") — that was false:
   `grep -rn "nginx-stable" services/ docker-compose.yml` returns nothing. The alias is only
   what the API Gateway routes *through*; no service reads it. Running it mid-chain meant a
   failure there took `orders`, `migrate-tracking`, and `tracking` down with it, none of which
   depend on it. Placed last, its blast radius is itself, and by the time it runs `users` has
   had the whole `orders`/`tracking` build to finish booting — so the health poll now succeeds
   on the first attempt instead of racing a container that started seconds ago.
2. **The health probe became advisory and retries** (`attempts=20, sleep_s=3` — the same
   budget `find_nginx_container` already used). `attach_alias()` already exits non-zero on its
   own if `docker network connect` fails, so by the time the probe runs, Docker has already
   confirmed the alias is attached. The probe only measures whether a *different* container
   (`users`, which has no compose healthcheck) is answering yet — returning exit 1 for that was
   reporting someone else's readiness as this script's own failure.

**Verified in a single pass (2026-07-31):** `make clean` (removing `./data`) followed by
`make bootstrap` completed **in one run**, the alias attaching and verifying on the first
attempt. `make doctor` then reported everything green, and 70/70 e2e tests passed, including
the full user → order → tracking → DELIVERED flow.

Re-running `make bootstrap` from a cold or partial state now works. If a run does die
partway for an unrelated reason, resume with `make bootstrap-converge` (see below) rather
than re-entering `bootstrap-provision`'s Terraform apply, which still cannot be safely
re-applied — see the sibling section above ([[floci-rds-apigw-limits]]).

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
- [[rds-aurora-engine-switchable-floci]]
- [[two-phase-terraform-apply]]
- [[terraform-remote-state-backend]]
- [[local-gateway-per-route-integrations]]
- [[nginx-njs-x-user-id-injection]]
