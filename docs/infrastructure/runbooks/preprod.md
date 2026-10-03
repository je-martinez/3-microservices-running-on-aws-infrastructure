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

Order: exclusivity guard, Floci up (compose project `3mrai-preprod`, healthcheck
`GET /_floci/health HTTP/1.1`), Terraform apply with `deploy_services=false` (data stores,
Cognito, messaging, ECR, config), build and push every image, `preprod-migrate`, apply with
`deploy_services=true` (ECS services, ALB, gateway), wait for RUNNING tasks, deregister stale ALB
targets, aliases, smoke, observability seed. It is **not resumable**: on failure run
`make preprod-down && make preprod-up`.

## Make targets

| Target | Does |
|---|---|
| `preprod-up` | Everything, from scratch |
| `preprod-deploy S=<svc>` | Build, push with a new immutable tag, `-target` apply for that service, wait, clean stale targets, aliases, smoke. `ENV_ONLY=1` skips the build and forces a new deployment (ECS reads SSM and secrets only at task start) |
| `preprod-heal` | After a Floci or Docker restart: Floci up, start Exited DocumentDB/Valkey containers, remove orphan task containers, wait, clean stale targets, re-apply aliases |
| `preprod-doctor` | ECS services vs containers, ALB target health, aliases, phantom DocumentDB/Valkey |
| `preprod-smoke` | `/v1/health` on 9101-9103, `:9090/`, `:5080/healthz` |
| `preprod-aliases` | Attach `users-grpc` and `mailpit` Docker aliases to the newest RUNNING task |
| `preprod-migrate` | Prisma (users) and golang-migrate (tracking) against Floci's RDS |
| `preprod-observability` | Seed the OpenObserve traces schema, import dashboards |
| `preprod-e2e ARGS=…` | Playwright against pre-prod (`ARGS="--project=gateway"`) |
| `preprod-load-test` / `preprod-load-test-smoke` | Gatling `fullJourney` / a ~20 s run |
| `preprod-down` | Full wipe: `down -v`, Floci children, ECR registry and volume, Floci volumes, local TF state |

## Ports

| Host port | Reaches |
|---|---|
| `4566` | Floci AWS APIs and ECR |
| `9101` / `9102` / `9103` | ALB → users / orders / tracking (E2E internal layer) |
| `9090` | ALB → web (nginx serves the bundle; `/v1` → API Gateway) |
| `5080` | ALB → OpenObserve UI and ingest |
| `8025` | ALB → Mailpit UI and API |

Internal only: OTLP `4318` (collector, traces and logs) and `4319` (browser RUM). The API Gateway
URL comes from `terraform output` in `infra/environments/preprod`.

## Configuration layout

- Parameters: SSM `/3mrai-preprod/<svc>/<VAR>`. Secrets: Secrets Manager `3mrai-preprod/<svc>/<VAR>`.
- Task definitions reference both by ARN in `secrets`; nothing is declared inline.
- **Pre-prod has no `.env.local.*` files** ([[env-files]]).
- A config change takes effect with `make preprod-deploy S=<svc> ENV_ONLY=1`.
- Collector endpoint: `O2_ENDPOINT`. Web RUM upstream: `OTLP_RUM_UPSTREAM`.
- Image tags: `<sha12>` or `<sha12>-dirty-<epoch>-<hash8>` in
  `infra/environments/preprod/image-tags.auto.tfvars.json`.

## Heal and doctor

After `docker compose restart`, a Docker daemon restart or a Floci recreate, run
`make preprod-heal`, then `make preprod-doctor` (all green expected). Floci stops with SIGKILL
so DocumentDB and ElastiCache keep their data; OpenObserve and Mailpit have no volume, so their
data resets. Re-run `make preprod-observability` after OpenObserve is recreated.

## Redeploy one service

```bash
make preprod-deploy S=users          # code change
make preprod-deploy S=users ENV_ONLY=1   # config change
```

Expect about 1-2 s of `503` on that service during the rollout (Floci limit, not a regression).
All images must already be pushed before any deploy (the `-target` apply still evaluates every
image tag).

## Teardown

`make preprod-down` removes everything including Floci-created RDS volumes and the ECR registry
container. Anything less leaves `RepositoryAlreadyExists` on the next apply or phantom stores.

## Verification

- `make preprod-up` ends with smoke and doctor green.
- `make preprod-e2e ARGS="--project=gateway --project=gateway-tracking --project=email"`:
  95 passed, 11 skipped (Stripe disabled, cache-off spec), 0 failed.
- The observability project passes except the `rum_logs` stream, which appears only after a
  browser session.
- `make preprod-load-test-smoke`: 551 requests, 0 failures. Full `preprod-load-test` saturates
  Floci's single process (86% / 59% OK, p95 17-50 s); a local capacity limit.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Gateway `{"message":"Not Found"}` | Route missing in `infra/modules/api-gateway`; the request never reached a service |
| Intermittent `503`, lasting 1-2 minutes after a deploy | Stale ALB target; `make preprod-heal` or deploy again (cleanup runs automatically) |
| `502` on Orders to Users gRPC | `users-grpc` alias missing; `make preprod-aliases` |
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
