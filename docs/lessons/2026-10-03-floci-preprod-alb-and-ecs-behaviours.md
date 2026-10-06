---
title: "Floci 2.1.0 ALB and ECS behaviours that shaped the pre-prod environment"
type: lesson
area: infra
status: active
created: 2026-10-03
updated: 2026-10-03
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[preprod]]"
  - "[[environment-exclusivity]]"
  - "[[2026-10-02-floci-2-1-restart-and-gateway-findings]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[local-dev-floci]]"
---

# Floci 2.1.0 ALB and ECS behaviours that shaped the pre-prod environment

Verified while building [[preprod]] (2026-10-02 to 2026-10-03). Each item is a present-tense
property of Floci 2.1.0 with the symptom that exposed it and what the repo does about it.
Severity is **high** because items 1, 3 and 4 produce intermittent `503`s or a permanently
unhealthy target while every control-plane call reports success.

## Findings

### 1. The ALB never applies container health checks

Floci stores the ECS `healthCheck` of a container definition but never applies it (the Docker
container has no `Healthcheck`), and the ALB registers a target as soon as the task starts, before
the app listens. A rolling replacement therefore shows **about 1-2 s of `503`** (measured 1.8 s
for Users at 0.5 s sampling). Redeploy criteria on Floci read "no failed request beyond that
window", not "zero failures".

### 2. `list_tasks` returns STOPPED tasks

Counting tasks by `list_tasks` overstates readiness during and after a rollout. The readiness wait
(`wait_services.py`) counts only `RUNNING` tasks created after the PRIMARY deployment, and waits
until they equal `desiredCount`.

### 3. A stopped task's ALB target is never deregistered

The stale target stays registered, so the ALB keeps sending traffic to a dead IP for 1-2 minutes
and the target stays unhealthy permanently. `preprod_targets.py` deregisters targets whose IP has
no live task and runs after every up, deploy and heal.

### 4. Body-less requests arrive chunked, with an empty body and no `Content-Type`

The ALB re-sends a request without a body as `Transfer-Encoding: chunked` with an empty body and no
`Content-Type`. Fastify answered `415`, which broke `DELETE /v1/users/me` for real users (host
port `9101` goes through the ALB too, so no infra-only fix exists). Users treats a zero-length body
without a `Content-Type` as no body; a **non-empty** body with a missing or unknown type is still
`415`. See `services/users/src/shared/http/empty-body-parser.ts`.

### 5. The ALB does not carry gRPC

An HTTP/2 gRPC listener answers `502` with a malformed header, while the container directly
returns a proper gRPC status. Users gRPC uses the Docker alias `users-grpc:50051`
(`users_grpc_via_alb = false`). Aliases are lost whenever a task is recreated, so they are
re-applied after every up, deploy and heal, on the **newest RUNNING** task, reconnecting with the
task's own IP so the ALB target stays valid.

### 6. Fargate rejects 256 CPU / 256 MiB

Floci answers "no Fargate configuration" for that combination. Mailpit runs with 512 MiB.

### 7. OpenObserve rejects passwords without special characters

A generated root password with no special character put OpenObserve in a crash loop. The
`random_password` resource requires at least one of each class.

### 8. `-target` applies still evaluate every service's image tag

`preprod-deploy` keeps `-target` for blast radius, but Terraform evaluates all services' image
tags, so every image must already be pushed before deploying any one of them.

### 9. `awslogs-group` is ignored

Logs land in `/ecs/<family>`; the collector reads that, and drops the platform's own groups
(OpenObserve, otel-collector, Mailpit, `/aws/ecr/registry`) so `unclassified` holds only
application noise.

### 10. ECR URIs always point at `:4566`

This is the root of [[environment-exclusivity]].

### 11. Healthcheck request shape

`GET / HTTP/1.0` without a `Host` header answers `500` on 2.1.0. The compose healthcheck sends
`GET /_floci/health HTTP/1.1` with `Host: localhost` and `Connection: close`.

## Standing rules

- Never trust `available` or `runningCount` alone; `make preprod-doctor` checks ECS vs containers,
  ALB targets, aliases and phantom stores.
- A rollout `503` window under about 2 s is the emulator, not a regression.
- Full Gatling load saturates Floci's single process (86% / 59% OK, p95 17-50 s, `502`s). That is a
  local capacity limit; `make preprod-load-test-smoke` (551 requests, 0 failures) is the load
  criterion.

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[preprod]]
- [[environment-exclusivity]]
- [[2026-10-02-floci-2-1-restart-and-gateway-findings]]
- [[floci-recreate-destroys-backing-containers]]
- [[local-dev-floci]]
