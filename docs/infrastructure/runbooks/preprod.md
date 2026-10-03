---
title: Pre-production — Floci environment
type: runbook
area: infra
status: active
created: 2026-10-03
updated: 2026-10-03
integration-status: verified
verified-on: 2026-10-03
verified-by: Jose E. Martinez
tags:
  - type/runbook
  - area/infra
  - status/active
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[environment-exclusivity]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
  - "[[local-dev-floci]]"
  - "[[terraform-modules]]"
  - "[[testing]]"
---

# Pre-production — Floci environment

A disposable environment whose only compose image is Floci 2.1.0. `users`, `orders`, `tracking`,
`web`, `otel-collector`, `openobserve` and `mailpit` run as ECS services pulled from Floci's ECR,
configured from SSM and Secrets Manager, behind API Gateway and per-service ALB listeners (no
nginx). Decision: [[ADR-0022-preprod-ecs-on-floci]]. It cannot run beside dev
([[environment-exclusivity]]).

## Start from scratch

```bash
make preprod-up        # about 3m40s from scratch
```

Order: exclusivity guard, live-environment check, Floci up (compose project `3mrai-preprod`, healthcheck
`GET /_floci/health HTTP/1.1`), Terraform apply with `deploy_services=false` (data stores,
Cognito, messaging, ECR, config), build and push every image, `preprod-migrate`, apply with
`deploy_services=true` (ECS services, ALB, gateway), wait for RUNNING tasks, deregister stale ALB
targets, aliases, smoke, then `preprod-observability` (seed + dashboards). It does not run
`preprod-doctor`. It is **not resumable**: on failure run
`make preprod-down && make preprod-up`.

`make preprod-up` refuses when pre-prod is already up: its first apply (`deploy_services=false`)
would destroy and rebuild every service. `preprod_live.py` runs before that apply and fails when the
ECS cluster in local state has any service. Use `make preprod-deploy S=<svc>` or `make preprod-down` first.

## Make targets

| Target | Does |
|---|---|
| `preprod-up` | Everything, from scratch; refuses on a live environment |
| `preprod-deploy S=<svc>` | Build, push with a new immutable tag, `-target` apply for that service, wait, clean stale targets, aliases, smoke. `ENV_ONLY=1` skips the build, applies `module.app_config` (writes the edited SSM and Secrets Manager values from `services.tf`), then forces a new deployment (ECS reads SSM and secrets only at task start) |
| `preprod-heal` | After a Floci or Docker restart: Floci up, start Exited DocumentDB/Valkey containers, remove orphan task containers, wait, clean stale targets, re-apply aliases |
| `preprod-doctor` | ECS services vs containers, ALB target health, stale ALB targets (`preprod_targets.py --check`), aliases (`preprod_aliases.py --check`), phantom DocumentDB/Valkey; prints the remedy per failure (heal vs down + up) |
| `preprod-smoke` | `/v1/health` on 9101-9103, `:9090/`, `:5080/healthz` |
| `preprod-aliases` | Attach `users-grpc` and `mailpit` Docker aliases to the newest RUNNING task |
| `preprod-migrate` | Prisma (users) and golang-migrate (tracking) against Floci's RDS |
| `preprod-observability` | Seed the OpenObserve traces schema, import dashboards |
| `preprod-e2e ARGS=…` | Playwright against pre-prod (`ARGS="--project=gateway"`) |
| `preprod-load-test` / `preprod-load-test-smoke` | Gatling `fullJourney` / a ~20 s run |
| `preprod-down` | Full wipe: `down -v`, Floci children, ECR registry and volume, Floci volumes, local TF state and the `.terraform*` directories; refuses while the dev stack runs |

## Ports

| Host port | Reaches |
|---|---|
| `4566` | Floci AWS APIs and ECR |
| `9101` / `9102` / `9103` | ALB → users / orders / tracking (E2E internal layer) |
| `9090` | ALB → web (nginx serves the bundle; `/v1` → API Gateway) |
| `5080` | ALB → OpenObserve UI and ingest |
| `8025` | ALB → Mailpit UI and API |

Internal only: OTLP `4318` (collector, traces; logs travel `awslogs` → CloudWatch → collector, and
services set `OTEL_LOGS_EXPORTER=none`) and `4319` (browser RUM). The API Gateway
URL comes from `terraform output` in `infra/environments/preprod`.

## Configuration layout

- Parameters: SSM `/3mrai-preprod/<svc>/<VAR>`. Secrets: Secrets Manager `3mrai-preprod/<svc>/<VAR>`.
- Task definitions reference both by ARN in `secrets`; nothing is declared inline.
- **Pre-prod has no `.env.local.*` files** ([[env-files]]).
- A config change takes effect with `make preprod-deploy S=<svc> ENV_ONLY=1`: edit the value in
  `services.tf`; the target writes it to SSM or Secrets Manager, then starts new tasks.
- Collector endpoint: `O2_ENDPOINT`. Web RUM upstream: `OTLP_RUM_UPSTREAM`.
- Image tags: `<sha12>` or `<sha12>-dirty-<epoch>-<hash8>` in
  `infra/environments/preprod/image-tags.auto.tfvars.json`.
- `build_push.py` skips build and push for a service whose tag already exists in ECR (tags are
  immutable), so the same commit with a clean tree reuses the pushed image and only records the tag.

## Heal and doctor

After `docker compose restart`, a Docker daemon restart or a Floci recreate, run
`make preprod-heal`, then `make preprod-doctor` (all green expected). Heal and `preprod_targets.py` treat a
task as dead only when its `lastStatus` is STOPPED. Floci stops with SIGKILL
so DocumentDB and ElastiCache keep their data; OpenObserve and Mailpit have no volume, so their
data resets. Re-run `make preprod-observability` after OpenObserve is recreated.

## Redeploy one service

```bash
make preprod-deploy S=users          # code change
make preprod-deploy S=users ENV_ONLY=1   # config change
```

`ENV_ONLY=1` also re-creates the DB-URL secret versions with identical values (Floci RDS drift
makes Terraform see a change); this is harmless and brief.

Expect about 1-2 s of `503` on that service during the rollout (Floci limit, not a regression).
All images must already be pushed before any deploy (the `-target` apply still evaluates every
image tag).

## Teardown

`make preprod-down` removes everything including Floci-created RDS volumes and the ECR registry
container. Anything less leaves `RepositoryAlreadyExists` on the next apply or phantom stores.

It refuses while the dev stack (compose project `3mrai`) runs: its `floci-` container and
`floci=true` volume sweeps would delete dev's Floci children and data. Drop dev first with
`make clean` if that is intended ([[environment-exclusivity]]).

## Verification

- `make preprod-up` ends with smoke and `preprod-observability`; run `make preprod-doctor` afterwards (green expected).
- `make preprod-e2e` (and the load targets) run through `e2e_env.py`, which exports the Terraform
  outputs as env vars, including `WEBHOOK_SECRET` and `EVENTS_QUEUE_URL`.
- `make preprod-e2e ARGS="--project=gateway --project=gateway-tracking --project=email"`:
  95 passed, 11 skipped (Stripe disabled, cache-off spec), 0 failed.
- The observability project passes 6/6. The web build has RUM on (`NG_APP_RUM_ENABLED=true`), so
  the `rum_logs` stream appears once a browser loads the web app on `:9090`.
- `make preprod-load-test-smoke`: 551 requests, 0 failures. Full `preprod-load-test` saturates
  Floci's single process (86% / 59% OK, p95 17-50 s); a local capacity limit.

### Verification results

- **SC1** gateway, gateway-tracking and email E2E: 95 passed, 11 skipped, 0 failed.
- **SC2** Gatling smoke: 551 requests, 0 failures. Full load saturates Floci (known limit).
- **SC3** logs and traces of users, orders and tracking are queryable in OpenObserve.
- **SC4** a real browser at `:9090` completes register, login, cart, address and pay;
  `POST /v1/orders` returns `201`. The `web-tokyo` Playwright project: 115 passed, 13 failed,
  6 skipped; the failures are pre-existing selector drift and dev-fill dependencies, not pre-prod.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Gateway `{"message":"Not Found"}` | Route missing in `infra/modules/api-gateway`; the request never reached a service |
| Intermittent `503`, lasting 1-2 minutes after a deploy | Stale ALB target; `make preprod-heal` or deploy again (cleanup runs automatically) |
| Orders' gRPC dial to `users-grpc` fails to resolve (DNS) | `users-grpc` alias missing; `make preprod-aliases`. The ALB is not a gRPC path: it answers gRPC with `502` |
| Welcome email not delivered | `mailpit` alias missing; `make preprod-aliases` |
| `RepositoryAlreadyExists` on apply | ECR registry survived a teardown; `make preprod-down` |
| `NoSuchBucket` pulling an image | Dev Floci owns `:4566`; see [[environment-exclusivity]] |
| OpenObserve crash loop | Root password rejected; keep special characters in the generated password |
| Trace waterfall `HTTP 400` | `make observability-traces-schema` equivalent: `make preprod-observability` |

Cause and evidence for each Floci behaviour: [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]].

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[environment-exclusivity]]
- [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]
- [[local-dev-floci]]
- [[terraform-modules]]
- [[env-files]]
- [[testing]]
