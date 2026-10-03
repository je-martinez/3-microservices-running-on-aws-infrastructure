---
title: "ADR-0022: Pre-production runs on ECS inside Floci, behind API Gateway and per-service ALB listeners"
type: adr
area: infra
status: accepted
id: ADR-0022
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
created: 2026-10-03
updated: 2026-10-03
tags:
  - type/adr
  - area/infra
  - status/accepted
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[preprod]]"
  - "[[environment-exclusivity]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
---

# ADR-0022: Pre-production runs on ECS inside Floci, behind API Gateway and per-service ALB listeners

## Context

Dev runs the services as compose containers beside Floci, reads generated `.env.local.*` files,
and reaches services through an nginx ECS task ([[ADR-0016-local-apigw-nginx-ecs]]). That is a
good development loop and a poor rehearsal of [[ADR-0009-apigw-alb-fargate]]: images never pass
through a registry, configuration never comes from Parameter Store or Secrets Manager
([[ADR-0007-secrets-parameter-store]]), and an nginx hop exists that production does not have.

Floci 2.1.0 closes the gaps that justified nginx in dev: its API Gateway applies
`overwrite:header` / `remove:header` / `overwrite:path` request parameters, its ALB serves `ip`
targets registered by ECS services, and its ECS pulls from its own ECR.

## Decision

Add a **pre-production environment** whose only compose image is Floci
(`docker-compose.preprod.yml`, project `3mrai-preprod`, `floci/floci:2.1.0`). Everything else
runs inside Floci:

```
host :9101-9103 / :9090 / :5080 / :8025
        │
API Gateway v2 (JWT authorizer; x-user-id overwritten from the claim on auth routes,
        │        removed on public routes; /health routes overwrite the path)
        ▼
ALB — one listener per service (users 9101, orders 9102, tracking 9103, web 9090,
        │        OpenObserve 5080, Mailpit UI 8025, OTLP 4318 / RUM 4319)
        ▼
ECS services in Floci (users, orders, tracking, web, otel-collector, openobserve, mailpit)
        images from Floci's ECR · config from SSM + Secrets Manager
```

1. **Seven ECS services pull immutable-tagged images from Floci's ECR.** Tags are `<sha12>` or
   `<sha12>-dirty-<epoch>-<hash8>`; never `latest`.
2. **Configuration only through SSM and Secrets Manager.** Parameters live at
   `/3mrai-preprod/<svc>/<VAR>`, secrets at `3mrai-preprod/<svc>/<VAR>`, referenced by ARN in each
   task definition's `secrets`. No `.env.local.*` file is read by a pre-prod workload.
3. **No nginx in pre-prod.** API Gateway does the identity injection; the ALB does routing. Dev
   keeps nginx until a separate decision retires it.
4. **One ALB listener per service**, not path rules on a shared port, because services also call
   each other over HTTP on paths outside the gateway's route map.
5. **Orchestration lives in the host Makefile** (`preprod-up`, `preprod-deploy`, `preprod-heal`,
   `preprod-doctor`, …), not in Floci init hooks: the Floci image carries no docker, terraform,
   aws or python.
6. **Non-HTTP traffic uses Docker network aliases.** Floci's ALB answers gRPC with a malformed
   header (502), so Users gRPC goes through `users-grpc:50051`; Floci's SES relays to the
   `mailpit` alias. Aliases are re-applied after every up, deploy and heal.
7. **Pre-prod and dev are mutually exclusive** — see [[environment-exclusivity]].
8. **Terraform state is local**, and RDS proxy ports come from `data "aws_rds_cluster"`.
9. **The web app runs on ECS.** Amplify is absent in Floci, CloudFront delivery is not in 2.1.0,
   and S3 website hosting answers `404` on SPA deep links.

## Consequences

- The gateway E2E suite, Gatling smoke, observability and the web app run against a topology that
  differs from production only by emulator and data stores.
- A rolling replacement shows about 1-2 s of `503` on Floci (the ALB routes before the app
  listens and never applies container health checks). Production does not share this; the
  measurement (1.8 s for Users) and its cause are in
  [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]].
- Full Gatling load saturates Floci's single process (86% / 59% OK, p95 17-50 s). Capacity
  testing is out of scope locally; `make preprod-load-test-smoke` is the load criterion.
- Pre-prod is disposable: restart is safe (SIGKILL stop keeps DocumentDB and ElastiCache data),
  `make preprod-down` is a full wipe.
- ADR-0016 is not superseded: nginx stays the dev mechanism. Its claim-to-header limitation no
  longer holds on Floci 2.1.0.

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0017-floci-local]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0018-observability-openobserve]]
- [[preprod]]
- [[environment-exclusivity]]
- [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]
- [[terraform-modules]]
