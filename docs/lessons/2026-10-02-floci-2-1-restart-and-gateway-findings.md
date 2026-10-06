---
title: "Floci 2.1.0: restart behaviour, gateway request parameters and the limits that still hold"
type: lesson
area: infra
status: active
created: 2026-10-02
updated: 2026-10-05
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[2026-10-02-dev-stack-floci-2-1]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[floci-elasticache-two-ports-and-provider-panic]]"
  - "[[local-dev-floci]]"
---

# Floci 2.1.0: restart behaviour, gateway request parameters and the limits that still hold

Dated record of what was probed and verified while moving the dev stack from Floci 1.7.0 to a
pinned **2.1.0** (2026-10-02). Probes ran against an isolated Floci instance and, for items 1, 6
and 10, against the real dev stack. The reusable conclusions live in the lessons linked under
[Related](#related); this note keeps the evidence.

Severity is **high** because item 1 silently destroys DocumentDB and ElastiCache data on every
ordinary stop, and the stack reports `available` while it happens.

## Findings

### 1. Graceful shutdown deletes DocumentDB and ElastiCache containers on every stop

Floci's shutdown hook removes both containers (log: `Stopping 1 DocumentDB container(s) on
shutdown`) and nothing relaunches them at boot, so the API answers `available` for phantoms. On
1.7.0 this happened only on recreation; on 2.1.0 a plain stop/start triggers it.

- **Fix:** `stop_signal: SIGKILL` on the `floci` compose service. It is safe because
  `FLOCI_STORAGE_MODE=persistent` flushes every write ([[floci-storage-modes-and-tmp-corruption]]).
- With SIGKILL, `docker compose restart` and `up -d --force-recreate` both kept all data.
- After a Docker daemon restart the containers are `Exited` but intact. **`make heal`**
  (`infra/scripts/floci_heal.py` plus `infra/environments/local/bootstrap.py`) restarts them,
  wakes the lazy ECS reconciler (it does nothing until the first ECS API call), removes orphan
  task containers and re-attaches `nginx-stable`.
- **`make doctor`** classifies backing containers as running, exited (`make heal`) or missing
  (`make clean && make bootstrap`).

### 2. Nothing but SIGKILL brings deleted containers back

Neither control-plane calls, a data-plane ping, reboot/modify operations nor
`FLOCI_SERVICES_ECS_RECONCILE_CONTAINERS_ON_STARTUP` relaunch a deleted DocumentDB or Valkey
container. Delete plus recreate with the same id works on 2.1.0 and yields an empty store; it
wedged on 1.7.0.

### 3. The image has no curl and answers HTTP/1.0 without Host with 500

The image ships bash and coreutils. It answers `GET / HTTP/1.0` without a `Host` header with
500, so the compose healthcheck uses bash `/dev/tcp` with `GET /_floci/health HTTP/1.1` plus a
`Host` header.

### 4. ECS rejects task-definition host volumes by default

Error: `volumes[].host.sourcePath is rejected by default`. `FLOCI_SERVICES_ECS_HOST_VOLUME_ROOTS`
allowlists the nginx config directory.

### 5. ElastiCache `Port` is the proxy port

`CreateReplicationGroup` `Port` must fall inside the proxy range. The Valkey container still
listens on 6379 in-network. The repo's script omits `Port`. See
[[floci-elasticache-two-ports-and-provider-panic]].

### 6. Second `terraform apply` no longer fails

Two consecutive `terraform -chdir=infra/environments/local apply -auto-approve` runs on a fresh
stack both exited 0 with `Apply complete! Resources: 0 added, 8 changed, 0 destroyed.` The same
8 in-place changes recur every time (perpetual drift, never "No changes"): three
`aws_apigatewayv2_integration.fn` (`content_handling_strategy`), `aws_cognito_user_pool.this`
(`lambda_config`/`username_configuration` read back absent, while `describe-user-pool` still
shows every trigger), `aws_ecs_service.nginx` (`propagate_tags`), `aws_ecs_task_definition.nginx`
(tags), and the `aws_rds_cluster.this` of `rds_aurora` and `rds_mysql`. `make doctor` stayed
green. The 1.7.0 `UpdateTags` failure recorded in [[floci-rds-apigw-limits]] does not
reproduce.

### 7. `aws_ssm_parameter` failures were a missing provider endpoint

`UnrecognizedClientException` came from an undeclared `ssm` provider endpoint, not a Floci
limit. The `ssm`, `ecr`, `s3` and `elasticache` endpoints are now declared.

### 8. Gateway request parameters

On API Gateway v2 `request_parameters`:

- `overwrite:header.x-user-id = $context.authorizer.claims.sub` works on JWT routes (the header
  carries the Cognito `sub`; 401 without a token).
- On routes **without** an authorizer, `overwrite:` leaves a client-sent `x-user-id` intact.
  `remove:header.x-user-id` strips it, so public routes need `remove:`.
- `overwrite:path` works.

This reverses the earlier "Floci never maps claims to a header" finding for 2.1.0.

### 9. Limits that still hold on 2.1.0

- ECR URIs always use `:4566` (`FLOCI_BASE_URL` does not change them).
- The ECR registry container and its `floci-ecr-registry-data` volume survive `down -v`;
  `make clean` now removes the volume explicitly.
- `awslogs-group` is ignored; logs land in `/ecs/<family>`.
- Cloud Map does not register or resolve ECS tasks; NLB TCP listeners answer HTTP 400; ECS
  `hostname` is ignored.
- CloudFront delivery is absent (the docs describe it for nightly builds only).

### 10. Full-suite verification on 2.1.0

`make clean && make bootstrap && make doctor` passed (all checks OK). No test failure is
attributable to Floci:

- web-* projects fail with `ECONNREFUSED ::1:4200` because the Angular app is not started by
  `bootstrap`; run `pnpm web:dev` first.
- `POST v1/orders` returns 400 `The 'paymentMethodId' field is required.` for 25 gateway tests;
  that is Orders/e2e-fixture drift, not Floci.
- One internal E2E count assertion varied between runs
  (`notifications.spec.ts`, `unread_count`); the variance is a shared-state effect.
- The tracking outbox test `TestARowThatKeepsFailingIsDiscardedRatherThanBlockingTheQueue`
  passes in isolation.

> [!warning] No 1.7.0 baseline
> The suite was not run on 1.7.0, so attribution is by error cause only, not by before/after
> comparison.

## Why this is recorded

A restart that silently deletes two data stores while the API reports `available` is invisible
to every shallow check, and the 1.7.0 knowledge in the earlier lessons gave the opposite advice
for several items (second apply, claim-to-header, recreate wedging). Each item above has a probe
or a verbatim output behind it.

## Heal/doctor verification

The dev-stack plan's Task 2 Step 6 (`make heal`) and Task 3 Step 5 (`docker stop` the Valkey container, then `make doctor`, expecting "fix: make heal") were part of the 2026-10-02/03 milestone work. The only live record kept is the dev regression in [[2026-10-03-floci-preprod-follow-ups]], green on 2026-10-03 (commit `8e6fc49c`): `make bootstrap`, `make doctor` all checks passed, `make down` then `make up` left the nginx alias attached. No separate transcript of the heal or stop-Valkey steps is kept.

## Related

- [[2026-10-02-floci-preprod-environment-design]] — the design whose "Feasibility evidence" section
  holds the isolated-instance probes.
- [[2026-10-02-floci-preprod-environment]] — the plan for the pre-production environment.
- [[2026-10-02-dev-stack-floci-2-1]] — the plan that pinned Floci 2.1.0 for the dev stack.
- [[floci-recreate-destroys-backing-containers]] — the SIGKILL and `make heal` fix, in depth.
- [[floci-storage-modes-and-tmp-corruption]] — why SIGKILL is safe under `persistent`.
- [[floci-vs-ministack-spike-findings]] — the "Floci 2.1.0 re-verification" summary.
- [[floci-rds-apigw-limits]] — second-apply behaviour.
- [[2026-10-03-floci-preprod-follow-ups]] — the live dev regression of 2026-10-03.
- [[floci-elasticache-two-ports-and-provider-panic]]
- [[local-dev-floci]] — the runbook with `make heal` and `make doctor`.
