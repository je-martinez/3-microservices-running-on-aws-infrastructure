---
title: "Local API Gateway: per-route HTTP_PROXY integrations (Floci path-forwarding limit)"
type: adr
area: infra
status: accepted
created: 2026-07-28
updated: 2026-07-28
tags:
  - type/adr
  - area/infra
  - status/accepted
related:
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[2026-07-11-local-gateway-per-route-integration-design]]"
  - "[[2026-07-11-local-gateway-per-route-integration]]"
  - "[[2026-07-15-orders-gateway-integration-design]]"
  - "[[networking]]"
  - "[[terraform-modules]]"
  - "[[floci-rds-apigw-limits]]"
---

# Local API Gateway: per-route HTTP_PROXY integrations (Floci path-forwarding limit)

## Decision

In the **local (Floci) environment only**, the `infra/modules/api-gateway` module creates
**one `HTTP_PROXY` integration per route**, with that route's path baked directly into the
`integration_uri` (e.g. `http://nginx-stable/v1/health`, `http://nginx-stable/v1/users/register`),
instead of a single shared integration. A `local_gateway` boolean variable (default `false`)
gates this: when `true`, a `local.routes` map drives per-route integrations via `for_each`;
when `false` (production), the module keeps its original single shared integration.

## Why

Floci's `HTTP_PROXY` integration treats `integration_uri` as a **literal URL**, parsed by
Java's `new URI(...)`. It ignores `RequestParameters` path overwrites
(`overwrite:path=$request.path`) and rejects any templating (`$request.path`,
`${request.path.proxy}`, `{proxy}` all fail or drop the path). A single shared integration
therefore always forwards `GET /` to the backend regardless of the route hit — every route
404s through the local gateway.

This is a **Floci emulator limitation**, not a Terraform config error: the same single-shared-
integration config is correct on real AWS, which does forward the matched path. Verified live:
baking the path into the URI (`http://nginx-stable/v1/health`) makes the gateway forward
`GET /v1/health` correctly (confirmed in nginx access logs), and the same pattern worked for
`POST /v1/users/register` (201, real Postgres persistence).

## Consequences

- Local and production topologies stay identical in shape (API GW → nginx/ALB → service); only
  the **number of integrations** differs (N local vs 1 prod). No change to
  [[ADR-0009-apigw-alb-fargate]] (the prod topology) or the core decision in
  [[ADR-0016-local-apigw-nginx-ecs]] (nginx as the local reverse proxy).
- Terraform is the sole source of truth for integration URIs — no post-apply
  `update-integration` patching, unlike the earlier IP-patch bootstrap this decision retires.
- `make env-file` writes the reachable local gateway invoke URL
  (`http://localhost:4566/restapis/<api_id>/$default/_user_request_`) into the AUTO-GENERATED
  box, built from `terraform output -raw api_id` — not from the module's AWS-format `invoke_url`
  output, which is not reachable against Floci.
- Extended for Orders (per [[2026-07-15-orders-gateway-integration-design]]): the `local.routes`
  map gained Orders' routes (`POST /v1/orders`, `GET /v1/orders/my-orders`,
  `GET /v1/orders/{order_id}`, `GET /v1/orders/health`), and the gateway's bare `/v1/health`
  route was replaced by per-service `/v1/users/health` / `/v1/orders/health` (nginx rewrites
  each to the service's unprefixed internal `/v1/health`), resolving a health-path collision
  between the two services.
- A **second** `terraform apply` against a live Floci stack is unreliable regardless (see
  [[floci-rds-apigw-limits]]) — this change is always validated via `make bootstrap` from a
  clean slate, never an in-place re-apply.

## Related

- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0009-apigw-alb-fargate]]
- [[2026-07-11-local-gateway-per-route-integration-design]]
- [[2026-07-11-local-gateway-per-route-integration]]
- [[2026-07-15-orders-gateway-integration-design]]
- [[networking]]
- [[terraform-modules]]
- [[floci-rds-apigw-limits]]
