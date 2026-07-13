---
title: Networking
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-07-12
tags: [type/spec, area/infra, status/active]
related:
  - ADR-0009-apigw-alb-fargate
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev-floci]]"
---

# Networking

## Summary

Describes the shared network topology for 3MRAI: the **target** request path from clients
through API Gateway and ALB to ECS Fargate services in production ([[ADR-0009-apigw-alb-fargate]],
not yet implemented), and the **actual, current** local path, which goes through API Gateway v2
and an nginx ECS reverse proxy rather than an ALB — see [[ADR-0016-local-apigw-nginx-ecs]] and the
[[local-dev-floci]] runbook.

## Stack & Data Store

- **DNS:** Route 53 private hosted zone `3mrai.internal` for inter-service resolution;
  public hosted zone `3mrai.example.com` for client-facing endpoints. **Production target, not
  yet implemented** — see the [Route 53 Names](#route-53-names) section below.
- **Edge:** AWS API Gateway (HTTP API) — terminates TLS, enforces Cognito auth. In production
  the target is to route to an ALB; locally it routes to nginx (see below).
- **Load balancer:** Application Load Balancer (internal) — **production target topology**, not
  yet implemented. Locally, an nginx ECS task stands in for this hop — see
  [[ADR-0016-local-apigw-nginx-ecs]].
- **Compute:** ECS Fargate — one service per microservice (`users`, `orders`, `tracking`).
- **Local reverse proxy:** an ECS task running nginx (with njs) — see
  [Request Path — Local Development](#request-path--local-development) below.

## Request Path — Production (target, not yet implemented)

```
Client
  └─► API Gateway (HTTPS :443)
        └─► Cognito authorizer (JWT validation)
              └─► ALB (HTTP :80, internal)
                    ├─► ECS Fargate — users-service   (:3001)
                    ├─► ECS Fargate — orders-service  (:3002)
                    └─► ECS Fargate — tracking-service (:3003)
```

> [!warning] Not yet implemented
> This is the **target** production topology per [[ADR-0009-apigw-alb-fargate]]. It has not been
> deployed — the project has only implemented and verified the local topology described below.
> Only the Users service exists today; Orders and Tracking ports are illustrative of the intended
> shape, not live resources.

Inter-service communication (gRPC) is intended to go directly ALB-to-service or service-to-service
over the private hosted zone, bypassing API Gateway. See [[ADR-0003-grpc-inter-service]].

### Health Checks

The health check contract (both the eventual ALB target group and the current local setup):

> [!info] Health check contract
> - **Path:** `GET /v1/health`
> - **Expected response:** HTTP `200`
> - Targets that fail to return `200` are marked **unhealthy** and removed from rotation until they recover.

Verified today for the Users service (`http://localhost:3000/v1/health`); Orders and Tracking will
follow the same `/v1/health` contract once they exist.

## Request Path — Local Development (actual, current)

```
curl / client app
  └─► API Gateway v2  (http://localhost:4566/restapis/<id>/$default/_user_request_/…)
        └─► Cognito JWT authorizer (real JWT validation against Floci)
              └─► ECS task: nginx (+ njs)   — decodes the JWT, injects x-user-id
                    │  proxy_pass via Docker embedded DNS
                    ▼
              users container  (nginx-stable alias → users:3000)
```

There is **no ALB locally** — API Gateway integrates directly with the nginx ECS task. This is a
deliberate decision, not a simplification of the diagram above: Floci's API Gateway never maps
JWT/authorizer claims into a request header (verified across 6 configurations), so nginx+njs
decodes the token and injects `x-user-id` itself. Full rationale, verified findings, and the
Floci-capability update: [[ADR-0016-local-apigw-nginx-ecs]]. Full bootstrap steps: [[local-dev-floci]].

## Route 53 Names

> [!warning] Not yet implemented
> The table below is the **production target** naming scheme per [[ADR-0009-apigw-alb-fargate]].
> No Route 53 zones or records are provisioned today — locally, DNS resolution is Docker embedded
> DNS (`resolver 127.0.0.11`) via compose service names / `FLOCI_SERVICES_ECS_DOCKER_NETWORK`, not
> Route 53 (Route 53 does not back name resolution inside Floci — see [[ADR-0017-floci-local]]).

| Record | Type | Target |
|---|---|---|
| `3mrai.example.com` | A (alias) | API Gateway custom domain |
| `users.3mrai.internal` | A | ALB target group (users) |
| `orders.3mrai.internal` | A | ALB target group (orders) |
| `tracking.3mrai.internal` | A | ALB target group (tracking) |

## Security Groups

> [!warning] Not yet implemented
> The three-tier `alb-sg` / `ecs-sg` / `rds-sg` split below is the **production target** design.
> The current `infra/modules/networking` module provisions a VPC, subnets, and a security group —
> not this full multi-SG topology; treat this table as design intent, not deployed fact.

- **alb-sg:** allows inbound HTTPS 443 from `0.0.0.0/0`; outbound to `ecs-sg` on service ports.
- **ecs-sg:** allows inbound only from `alb-sg`; outbound to RDS, SQS, DocumentDB endpoints.
- **rds-sg:** allows inbound only from `ecs-sg` on the DB port.

## Cross-cutting rules

- All network resources are provisioned by the `infra/modules/networking` Terraform module.
- Naming follows `cloudposse/label/null`; see [[terraform-modules]].
- TLS termination happens at API Gateway only; all internal traffic is unencrypted within the VPC.

## Related

- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0017-floci-local]]
- [[ADR-0003-grpc-inter-service]]
- [[terraform-modules]]
- [[aws-resources]]
- [[local-dev-floci]]
