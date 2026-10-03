---
title: "Floci Pre-Production Environment Design"
type: spec
area: infra
status: accepted
created: 2026-10-02
updated: 2026-10-03
tags:
  - type/spec
  - area/infra
  - status/accepted
propagates-to:
  - "[[local-dev-floci]]"
  - "[[local-dev]]"
  - "[[aws-resources]]"
  - "[[terraform-modules]]"
  - "[[env-files]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[environment-exclusivity]]"
  - "[[preprod]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
related:
  - "[[2026-10-02-dev-stack-floci-2-1]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[local-dev-floci]]"
  - "[[local-dev]]"
  - "[[aws-resources]]"
  - "[[terraform-modules]]"
  - "[[env-files]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[testing]]"
  - "[[git-workflow]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[environment-exclusivity]]"
  - "[[preprod]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
---

# Floci Pre-Production Environment — Design

## Spec amendments (as built)

Implementation (2026-10-03) departs from the decisions below in the ways listed here. **Where
this section and a later section disagree, this section wins**; the superseded text is marked
inline so the original reasoning stays readable. Operational detail: [[preprod]]; decision
record: [[ADR-0022-preprod-ecs-on-floci]].

| # | Original | As built |
|---|---|---|
| 1 | Path rules on one internal ALB listener `:9091` | **One ALB listener per service**: users `9101`, orders `9102`, tracking `9103`, web `9090`, OpenObserve `5080`, Mailpit UI `8025`, OTLP `4318`, browser RUM `4319`. Services call each other over HTTP on paths outside the gateway route map, so a port per service needs no rule upkeep. `9101-9103` are published to the host for the E2E internal layer |
| 2 | API GW overwrites `x-user-id` on every route | **Auth routes overwrite `x-user-id` from `claims.sub`; public routes `remove:header.x-user-id`.** Verified on 2.1.0: `overwrite` on a route without the authorizer leaves a client-sent value intact |
| 3 | Terraform state unspecified | **Local state** in `infra/environments/preprod` (a backend bucket inside a disposable emulator only adds a bootstrap step) |
| 4 | RDS ports from a discovery script | **RDS proxy ports from `data "aws_rds_cluster"`** |
| 5 | Collector and web endpoints fixed | **`O2_ENDPOINT`** (collector to OpenObserve) and **`OTLP_RUM_UPSTREAM`** (web `/otlp/` to collector) are env-configured; dev keeps today's values as defaults |
| 6 | gRPC to Users through the ALB if the F2 check passes | **Docker alias `users-grpc:50051`.** Floci's ALB answers gRPC with `502` (malformed header). `users_grpc_via_alb` defaults to `false` |
| 7 | Redeploy of one service with no failed requests | **About 1-2 s of `503` per rolling replacement** (measured 1.8 s for Users). Floci never applies container health checks and the ALB routes before the app listens |
| 8 | Success criterion 2: Gatling `fullJourney` runs | `make preprod-load-test-smoke` passes (551 requests, 0 failures). **Full load saturates Floci's single process** (86% / 59% OK, p95 17-50 s): a known local capacity limit, not a pre-prod defect |
| 9 | Healthcheck `GET /` | **`GET /_floci/health HTTP/1.1` with `Host: localhost`**; 2.1.0 answers `GET /` over HTTP/1.0 without `Host` with `500` |
| 10 | Config parameters under `/3mrai/preprod/...` | `/3mrai-preprod/<svc>/<VAR>` and Secrets Manager `3mrai-preprod/<svc>/<VAR>` |
| 11 | Lifecycle rows `preprod-up` and `preprod-heal` below | **Superseded.** `preprod-up` = live-environment refusal (amendment 16) → guard → Floci → apply A → build/push (`PP_IMAGES`) → migrate → apply B → wait → stale-target cleanup → aliases → smoke → `preprod-observability`. `preprod-heal` = `compose up --wait floci` → `floci_heal` (`FLOCI_NETWORK`) → wait → stale-target cleanup → aliases |
| 12 | Doctor reports a stray ECR registry | **Dropped.** `preprod-down` removes the registry and doctor runs against a live environment. Doctor also checks stale ALB targets and aliases |
| 13 | Every `preprod-*` target names the next command on failure | **make stops at the failing step**; `preprod-doctor` prints the remedy per failure (heal vs down + up). The next command is not printed for every target |
| 14 | RUM unspecified for pre-prod | **RUM is enabled** in pre-prod web builds (`NG_APP_RUM_ENABLED=true`); `rum_logs` appears once a browser loads the app |
| 15 | Web build args include Cognito ids and the WS URL from Terraform | **Only the WS URL** comes from Terraform; there are no Cognito ids in the build args |
| 16 | `preprod-deploy ENV_ONLY=1` runs `force-new-deployment` only; no guards beyond the exclusivity prompt | **Final-review hardening.** `preprod-deploy ENV_ONLY=1` first applies `module.app_config` (writes edited SSM/Secrets values), then forces a new deployment. `preprod-up` refuses when pre-prod is already up (`preprod_live.py`). `preprod-down` refuses while the dev stack runs (`env_guard.py --check-other`). `build_push.py` reuses an image tag already in ECR instead of rebuilding. The E2E runner also exports `WEBHOOK_SECRET` and `EVENTS_QUEUE_URL` |

Further as-built facts: the ECS services are `users`, `orders`, `tracking`, `web`,
`otel-collector`, `openobserve`, `mailpit`; aliases are re-applied by `preprod-up`,
`preprod-deploy` and `preprod-heal`; the collector drops the platform's own log groups; a
stopped task's ALB target is deregistered by `preprod_targets.py`; Users accepts an empty
body without a `Content-Type` (the ALB re-sends body-less requests that way). Evidence:
[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]. Results: `preprod-up` from scratch green
in about 3m40s; E2E gateway, gateway-tracking and email 95 passed, 11 skipped (Stripe
disabled, cache-off spec), 0 failed.

## Context

Today the local stack is split in two: Floci emulates the AWS resources (RDS, DocumentDB,
ElastiCache, SQS, Lambda, Cognito, API Gateway, one nginx ECS task), while the services
themselves (`users`, `orders`, `tracking`, `web`), the observability stack (`otel-collector`,
`openobserve`) and `mailpit` run as plain compose services beside it. That is a good
development loop and a poor rehearsal of production: images are never pushed to a registry,
configuration comes from generated `.env.local.*` files instead of Parameter Store / Secrets
Manager, and the gateway reaches the services through an nginx task that production does not
have ([[ADR-0009-apigw-alb-fargate]] vs [[ADR-0016-local-apigw-nginx-ecs]]).

This spec adds a **pre-production environment**: a second compose file whose **only** image is
Floci, with every other workload running **inside** Floci as ECS services pulling from Floci's
ECR, configured through SSM Parameter Store and Secrets Manager. Its purpose is testing: the
gateway E2E suite, the Gatling load tests, observability and the web app all run against it.

### What the user asked for

- A new compose whose only image is Floci; everything that today runs beside Floci runs inside it.
- `users`, `orders`, `tracking` as an ECS cluster with images pulled from ECR.
- Evaluate Amplify vs ECS for the web app.
- Floci lifecycle hooks considered for (1) pushing images to ECR and (2) deploying the infrastructure.
- Environment variables injected from SSM Parameter Store and Secrets Manager.
- An observability service and a Mailpit service.
- Floci's limitations checked both against its documentation and empirically.

### Assumptions (confirmed during design)

- RDS, DocumentDB, ElastiCache, SQS, Lambda (events pipeline) and Cognito stay Floci-managed
  resources, exactly as in dev.
- The existing Terraform modules are reused from a new root `infra/environments/preprod`.
- Pre-prod is a disposable test environment, not a long-lived one.

## Feasibility evidence (2026-10-02)

All findings below come from throwaway probes against an **isolated** Floci instance
(separate compose project, port and network), cross-checked against the official docs.
Floci **2.1.0** (2026-09-15) was the version probed; dev currently runs **1.7.0**
(2026-08-18), and several behaviours differ.

### Works (verified)

| Capability | Evidence |
|---|---|
| ECR push from host, ECS pull | `docker push` to the ECR URI; ECS task runs the image |
| ECS task `secrets` from SSM (ARN, bare name, SecureString) and Secrets Manager (whole + `:password::` JSON key) | Values present in the task container's env |
| ECS **service** with `desiredCount`, self-heal | Killed task replaced in ~10 s |
| ALB data plane: path rules, default fixed-response 404, `ip` targets auto-registered by the ECS service `loadBalancers` block | `/echo` → task, `/x` → 404 |
| API GW v2 HTTP_PROXY → ALB listener | Response from the ECS task through the gateway |
| API GW JWT authorizer + `overwrite:header.x-user-id = $context.authorizer.claims.sub` + `overwrite:path` | Header carries the Cognito `sub`; path rewritten; 401 without token |
| Terraform (provider `= 5.31.0`) for SSM, Secrets Manager, ECR, ECS cluster/task def/service, ALB/TG/listener/rule, API GW | 16 resources applied; **second apply = "No changes"** |
| Redeploy one service by changing its image tag | New task definition, rolling update, **120/120 requests 200** during the rollout (v1→v2) |

### Does not work / limits (verified)

| Limit | Consequence for this design |
|---|---|
| Cloud Map: ECS tasks not registered, no DNS | No service discovery by name |
| NLB TCP listener answers HTTP 400 | No TCP passthrough |
| ECS `hostname` ignored; task containers named `floci-ecs-<taskId>-<container>` | No stable DNS name from ECS itself |
| `FLOCI_SERVICES_ECS_PUBLISH_AWSVPC_PORTS_TO_HOST` did not publish | No host-port route |
| Amplify absent from Floci; CloudFront content delivery not in 2.1.0 (docs describe nightly) | Web app cannot use Amplify or CloudFront |
| S3 website serves `index.html` on deep links **with status 404** | S3 website rejected for the SPA |
| `awslogs-group` ignored — logs land in `/ecs/<family>` | Collector config reads `/ecs/<family>` |
| Init hooks: image has no docker / terraform / aws / python; 2.1.0 also drops `curl`; 30 s per-script timeout; a failing hook shuts Floci down | Hooks cannot push images or deploy |
| ECR URIs are always `…localhost:4566`; `FLOCI_BASE_URL` does not change them | Two Floci instances cannot both serve ECR — pre-prod must own `:4566` |
| ECR registry container (`floci-ecr-registry`) and its volume survive `down -v`; a fresh apply then fails with `RepositoryAlreadyExists` | `preprod-down` removes them explicitly |
| Floci-created RDS volumes survive `down -v` | `preprod-down` removes them explicitly |
| gRPC through the ALB | Verified in F2 with the real Users image: **does not work** (`502`, malformed header); alias used |

### Floci restart behaviour and the persistence fix (verified on 2.1.0)

Floci's **graceful shutdown deletes** its DocumentDB and ElastiCache containers (log:
`Stopping 1 DocumentDB container(s) on shutdown`), and nothing relaunches them at boot. On
2.1.0 this happens on a plain **stop/start**, not only on recreation as on 1.7.0. The API keeps
answering `available` (phantoms). Neither control-plane calls, a data-plane ping, reboot/modify
operations nor `FLOCI_SERVICES_ECS_RECONCILE_CONTAINERS_ON_STARTUP` bring them back.

| Resource | Graceful stop (default) | With `stop_signal: SIGKILL` |
|---|---|---|
| RDS | Relaunched on its named volume, data intact | Same |
| ECS service | Relaunched, but **only after the first ECS API call** (lazy reconciler); `runningCount` lies meanwhile; an orphan task container may remain | Same |
| DocumentDB | Phantom, data lost | **Container survives with its data** |
| ElastiCache (Valkey) | Phantom, data lost | **Container survives with its data** |

With `stop_signal: SIGKILL`, `docker compose restart` and `up -d --force-recreate` both kept all
data. After a Docker daemon restart the DocumentDB/Valkey containers are `Exited` but intact, and
`docker start` restores them with their data. SIGKILL is safe because
`FLOCI_STORAGE_MODE=persistent` flushes on every write ([[floci-storage-modes-and-tmp-corruption]]).
Deleting and recreating a phantom with the same id works on 2.1.0 (it wedged on 1.7.0) but
yields an empty store.

## Decisions

1. **Single-image compose.** `docker-compose.preprod.yml`, project `3mrai-preprod`, one service:
   `floci` pinned to `floci/floci:2.1.0`, `stop_signal: SIGKILL`, its own network and named
   state volume. It publishes `4566` (AWS APIs + ECR) and the ALB listeners meant for the host:
   `9090` (web), `5080` (OpenObserve UI) and `8025` (Mailpit UI). Nothing else.
2. **Floci pinned to 2.1.0 in both environments.** Dev migrates as phase F0 (see Phases).
3. **Dev and pre-prod are mutually exclusive — a convention** ([[environment-exclusivity]]). Starting either one while the
   other is up prompts the user: *drop the other environment, or do nothing*. Required, not
   cosmetic: both need `:4566` and the fixed-name `floci-ecr-registry` container.
4. **Orchestration from the host Makefile**, not Floci init hooks (the image carries none of the
   tools). Hooks are used only for lightweight readiness, if at all.
5. **No nginx.** API Gateway does what the nginx task did: the JWT authorizer, `x-user-id`
   from `claims.sub` via `overwrite:header` (public routes remove it instead; see amendment 2), and the `/health` rewrites via `overwrite:path`. The
   ALB does the per-service routing.
6. **Web app on ECS** behind the ALB, using the existing `apps/web` image (static bundle +
   nginx that proxies `/v1` to the gateway, keeping `/v1` relative so no CORS is needed).
   Amplify and CloudFront are unavailable and S3 website returns 404 on deep links.
7. **Stable names for non-HTTP traffic — hybrid.** OTLP moves to HTTP through a dedicated ALB
   listener `:4318` (its `/v1/traces` path would collide with the API's `/v1` on a shared one). ~~gRPC to Users goes through the ALB if F2's verification passes, otherwise through an
   alias.~~ *(Superseded by amendment 6: gRPC uses the `users-grpc` alias.)* SMTP to Mailpit (Floci's SES relay) always uses an alias: a Python script runs
   `docker network connect --alias <name>` on the task container after deploy and from
   `make preprod-heal`. A self-healed task loses its alias until heal runs; doctor reports it.
8. **Configuration only through SSM and Secrets Manager.** Terraform writes
   `/3mrai-preprod/<svc>/<VAR>` parameters and the credential/API-key secrets; every task
   definition references them by ARN in `secrets`. Pre-prod has no `.env.local.*` files. The
   provider gains the missing `ssm` and `ecr` endpoints (their absence, not Floci, is what made
   `aws_ssm_parameter` fail — the CONTRACT note in `infra/modules/docdb/main.tf` is corrected).
9. **Immutable image tags.** Every image is tagged with the git SHA (plus a timestamp suffix
   when the tree is dirty); never `latest`. A code change therefore always produces a new task
   definition revision.
10. **Persistence across Floci restarts** via `stop_signal: SIGKILL` plus heal/down discipline
    (see "Floci restart behaviour"), in both environments.
11. **Pre-prod does not survive a teardown by design.** Restart is safe; `preprod-down` is a full
    wipe.

## Architecture

> [!warning] Superseded diagram
> The diagram shows the original shared `:9091` listener with path rules. As built, each service
> owns its listener (amendment 1) and Users gRPC uses an alias (amendment 6).

```
host:9090 ─► ALB public listener ──default──► web (ECS; nginx serves bundle, /v1 → API GW)

API GW (JWT authorizer, overwrite:header.x-user-id, overwrite:path)
   └─► ALB internal listener :9091 (not published)
          ├─ /v1/orders*, /v1/cart*, /v1/products* ─► orders   (ECS)
          ├─ /v1/trackings*, /v1/tracking/*        ─► tracking (ECS)
          └─ default                               ─► users    (ECS)

ALB :4318 (internal) ─► otel-collector (OTLP/HTTP)
ALB :5080 (host)     ─► openobserve UI + ingest
ALB :8025 (host)     ─► mailpit UI

alias (Docker network)  mailpit:1025 ◄── Floci SES relay
                        users:50051  ◄── orders/tracking gRPC (only if ALB gRPC fails)

Floci-managed: RDS (Postgres, MySQL), DocumentDB, ElastiCache, SQS, Lambda, Cognito, SSM,
Secrets Manager, ECR, CloudWatch Logs
```

ECS services: `users`, `orders`, `tracking`, `web`, `otel-collector`, `openobserve`, `mailpit`.
Exact route ownership is copied from the current api-gateway route map and nginx `location`
blocks during implementation — the list above is illustrative, the route map is authoritative.

### Terraform layout

- New root `infra/environments/preprod`, reusing `networking`, `rds-aurora`, `cognito`,
  `messaging`, `docdb`, `redis`, `dynamodb`, `api-gateway`, `api-gateway-ws`, `lambda`, `label`.
- New modules:
  - `ecr` — one repository per image.
  - `ecs-service` — generic: task definition (image, cpu/memory, `secrets`, `environment`,
    `portMappings`, `awslogs`), service, optional target group + listener rule.
  - `alb` — load balancer; *(superseded by amendment 1: one listener per service)* listeners `9090` (web, host), `9091` (API, internal), `4318`
    (OTLP, internal), `5080` (OpenObserve, host), `8025` (Mailpit UI, host); path rules on `9091`.
  - `app-config` — SSM parameters and Secrets Manager secrets per service.
- `api-gateway` gains a mode where integrations target the ALB with `request_parameters`
  instead of the nginx task; dev keeps its current wiring until a separate decision.
- Applies are split: **A** (ECR, data stores, Cognito, messaging, config) then image push, then
  **B** (ECS services, ALB, gateway integrations), because task definitions need pushed images.

## Lifecycle (Makefile)

| Target | Does |
|---|---|
| `preprod-up` (superseded, see amendment 11) | Exclusivity guard → Floci up (host-side health, no `curl` in the image) → apply A → build + push all images → apply B → migrations (Prisma, golang-migrate) against discovered RDS ports → aliases → wait `runningCount == desired` → smoke |
| `preprod-deploy S=<svc>` (the `ENV_ONLY=1` behaviour is superseded, see amendment 16) | Build that image → push with a new immutable tag → apply B for that service → rolling update → wait → health smoke for that service. `ENV_ONLY=1` skips the build and runs `force-new-deployment` (**superseded by amendment 16**: it applies `module.app_config` first) (ECS reads secrets only at task start) |
| `preprod-heal` (superseded, see amendment 11) | One ECS API call (wakes the lazy reconciler) → `docker start` any `Exited` Floci DocumentDB/Valkey container → remove orphan ECS task containers not in `list-tasks` → re-apply aliases |
| `preprod-doctor` | Reports: ECS services vs `docker ps`, ALB target health, aliases, phantom DocumentDB/Valkey (API `available` but no running container), stray ECR registry (dropped, see amendment 12) |
| `preprod-down` | `down -v` → remove Floci-created children on the project network → remove `floci-ecr-registry` + its volume → remove Floci-created RDS volumes of this environment |
| `preprod-e2e`, `preprod-load-test` | The existing gateway E2E suite and Gatling `fullJourney`, pointed at pre-prod |

`preprod-up` is not resumable mid-way (as with `bootstrap-provision` today): a failure stops with
a clear message and the recovery is `preprod-down && preprod-up`.

The exclusivity guard is shared: `make bootstrap`/`make up` (dev) get the mirror prompt.

### Web build-time configuration

`NG_APP_*` values are compiled into the bundle, so `preprod-deploy S=web` and `preprod-up` pass
them as build args; as built only the WS URL is read from Terraform (amendment 15).

## Observability

`otel-collector` and `openobserve` run as ECS services. Service logs go `awslogs` → CloudWatch
Logs (`/ecs/<family>`) → the collector's existing `aws_cloudwatch` receivers → OpenObserve.
Traces go OTLP/HTTP to the collector through the ALB's `:4318` listener. The compose `fluentd` logging driver
does not exist in pre-prod; collector pipelines that depend on it are adapted for the pre-prod
config. OpenObserve storage is ephemeral (task-local), consistent with a disposable environment.
`make observability-traces-schema` and dashboard import run against pre-prod's OpenObserve as
part of `preprod-up`.

## Error handling

- Every `preprod-*` target fails loudly at the first failing step; as built, make stops there and
  doctor prints the remedy per failure (amendment 13).
- Never trust `available` or `runningCount` alone: doctor and the readiness waits check the
  backing container.
- Recreating the Floci container is safe with `stop_signal: SIGKILL`; heal recovers the rest.
- Deleting DocumentDB/Valkey containers by hand loses their data — out of scope (no backups).

## Testing (success criteria)

Pre-prod is done when all four hold:

1. **Gateway E2E green:** the existing Playwright gateway suite, real Cognito JWTs, only the
   base URL changed.
2. **Gatling:** `fullJourney` runs against pre-prod.
3. **Observability visible:** logs and traces of `users`, `orders`, `tracking` in pre-prod's
   OpenObserve, verified in the viewer.
4. **Web navigable:** login → order completed at `http://localhost:9090`.

Plus the environment's own checks: redeploy one service with only the ~1-2 s rollout `503` window (amendment 7); restart
Floci and keep DocumentDB/Valkey data; `preprod-down` leaves no Floci containers or volumes.

## Phases

- **F0 — Dev on Floci 2.1.0** (prerequisite; ships as one package because 2.1.0 without the
  persistence fix is a regression for dev): pin 2.1.0, healthcheck without `curl`,
  `stop_signal: SIGKILL`, `make doctor` heal steps, `make clean` removing Floci-created
  children/volumes, re-verify the floci skill quirks, add missing provider endpoints.
- **F1 — Skeleton:** `docker-compose.preprod.yml`, `infra/environments/preprod` root,
  exclusivity guard (both directions), `preprod-up/down/doctor` scaffolding.
- **F2 — Services on ECS:** `ecr`, `ecs-service`, `app-config` modules; users/orders/tracking
  images; SSM/Secrets wiring; `preprod-deploy`. First task: verify gRPC through the ALB with the
  real Users image.
- **F3 — Edge:** `alb` module, API Gateway → ALB with `request_parameters` (no nginx), web on
  ECS, web redeploy.
- **F4 — Observability, Mailpit, aliases:** collector + OpenObserve services, CloudWatch log
  path, Mailpit + SES relay alias, `preprod-heal`.
- **F5 — Validation:** the four success criteria and the environment checks above.

## Out of scope

- Backups or recovery of DocumentDB/Valkey data deleted by hand.
- Running dev and pre-prod at the same time.
- Changing dev's gateway wiring (nginx) — dev keeps it; retiring it there is a separate decision.
- Real-AWS deployment of pre-prod.
- CloudFront/S3 hosting for the web app (revisit when a Floci release ships CloudFront delivery).

## Documentation to propagate

Existing notes to update: [[local-dev-floci]], [[local-dev]], [[aws-resources]],
[[terraform-modules]], [[env-files]] (pre-prod has none), [[ADR-0016-local-apigw-nginx-ecs]]
(nginx no longer needed where API GW header injection is available),
[[floci-recreate-destroys-backing-containers]], [[floci-storage-modes-and-tmp-corruption]],
[[floci-vs-ministack-spike-findings]], the floci skill quirks 6, 9, 13, 15, 16, 17 and the
"ships curl" claim.

New notes: a convention for dev/pre-prod exclusivity; a pre-prod runbook; a lesson for the
Floci 2.1.0 findings (claims→header works, SIGKILL persistence fix, lazy ECS reconciler, ECR
`:4566` coupling, the missing-SSM-endpoint misdiagnosis); an ADR for the pre-prod topology.

## Related

- [[local-dev-floci]]
- [[local-dev]]
- [[aws-resources]]
- [[terraform-modules]]
- [[env-files]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[floci-recreate-destroys-backing-containers]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[floci-vs-ministack-spike-findings]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0017-floci-local]]
- [[ADR-0018-observability-openobserve]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[testing]]
- [[git-workflow]]
- [[2026-10-02-dev-stack-floci-2-1]]
- [[2026-10-02-floci-preprod-environment]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[environment-exclusivity]]
- [[preprod]]
- [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]
