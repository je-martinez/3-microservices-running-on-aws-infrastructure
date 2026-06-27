---
title: Networking
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/spec, area/infra, status/active]
related:
  - ADR-0009-apigw-alb-fargate
---

# Networking

## Summary

Describes the shared network topology for 3MRAI: the request path from clients through API
Gateway and ALB to ECS Fargate services in production, and the equivalent local path via
Docker Watch. See [[ADR-0009-apigw-alb-fargate]] for the architectural decision.

## Stack & Data Store

- **DNS:** Route 53 private hosted zone `3mrai.internal` for inter-service resolution;
  public hosted zone `3mrai.example.com` for client-facing endpoints.
- **Edge:** AWS API Gateway (HTTP API) — terminates TLS, enforces Cognito auth, routes to ALB.
- **Load balancer:** Application Load Balancer (internal) — forwards to ECS Fargate target groups.
- **Compute:** ECS Fargate — one service per microservice (`users`, `orders`, `tracking`).
- **Local substitute:** Docker Compose + Docker Watch; services bind on `localhost:<port>` and
  communicate directly without ALB overhead.

## Request Path — Production

```
Client
  └─► API Gateway (HTTPS :443)
        └─► Cognito authorizer (JWT validation)
              └─► ALB (HTTP :80, internal)
                    ├─► ECS Fargate — users-service   (:3001)
                    ├─► ECS Fargate — orders-service  (:3002)
                    └─► ECS Fargate — tracking-service (:3003)
```

Inter-service communication (gRPC) goes directly ALB-to-service or service-to-service over
the private hosted zone, bypassing API Gateway. See [[ADR-0003-grpc-inter-service]].

## Request Path — Local Development

```
curl / client app
  └─► Docker network (bridge)
        ├─► users-service   (localhost:3001)
        ├─► orders-service  (localhost:3002)
        └─► tracking-service (localhost:3003)
```

Docker Watch (live-reload) restarts only the affected container on source change, preserving
the others. See [[local-dev-ministack]] for the full local-dev runbook.

## Route 53 Names

| Record | Type | Target |
|---|---|---|
| `3mrai.example.com` | A (alias) | API Gateway custom domain |
| `users.3mrai.internal` | A | ALB target group (users) |
| `orders.3mrai.internal` | A | ALB target group (orders) |
| `tracking.3mrai.internal` | A | ALB target group (tracking) |

## Security Groups

- **alb-sg:** allows inbound HTTPS 443 from `0.0.0.0/0`; outbound to `ecs-sg` on service ports.
- **ecs-sg:** allows inbound only from `alb-sg`; outbound to RDS, SQS, DocumentDB endpoints.
- **rds-sg:** allows inbound only from `ecs-sg` on the DB port.

## Cross-cutting rules

- All network resources are provisioned by the `infra/modules/networking` Terraform module.
- Naming follows `cloudposse/label/null`; see [[terraform-modules]].
- TLS termination happens at API Gateway only; all internal traffic is unencrypted within the VPC.

## Related

- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0003-grpc-inter-service]]
- [[terraform-modules]]
- [[aws-resources]]
- [[local-dev-ministack]]
