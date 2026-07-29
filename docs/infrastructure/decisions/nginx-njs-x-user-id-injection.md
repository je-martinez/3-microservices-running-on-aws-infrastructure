---
title: "Local identity: nginx+njs decodes the JWT and injects x-user-id"
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
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-07-11-gap1-nginx-njs-xuserid-design]]"
  - "[[2026-07-11-gap1-nginx-njs-xuserid]]"
  - "[[2026-07-15-orders-gateway-integration-design]]"
  - "[[users-service-design]]"
  - "[[terraform-modules]]"
---

# Local identity: nginx+njs decodes the JWT and injects x-user-id

## Decision

In the **local (Floci) environment only**, the nginx ECS reverse proxy
(per [[ADR-0016-local-apigw-nginx-ecs]]) runs an **njs** script (`auth.js`) that decodes the
`Authorization: Bearer <token>` JWT, extracts the `sub` claim, and sets
`proxy_set_header x-user-id <sub>` on every proxied location before forwarding to a backend
service. The config (`auth.js` + `nginx.conf`) ships as checked-in files under
`infra/modules/compute/nginx/`, bind-mounted into the nginx ECS task via a Floci host volume
(`volume { host_path = ... }` + container `mountPoints`).

## Why

The users (and later orders) services read caller identity from the `x-user-id` header. API
Gateway validates the Cognito JWT via its JWT authorizer, but does **not** map the token's
claims into a request header locally — verified across **6 live POCs** against Floci
(v1/v2 request-parameter mapping, Lambda-authorizer context, JWT-claims syntax, VPC-Link+ALB,
REST v1 API): Floci accepts every one of these configurations at apply time but never executes
the claim→header mapping at request time. (This works on real AWS; it is an emulator gap.)

njs was chosen over a Lambda-proxy alternative (also POC'd working) because nginx is already in
the request path — njs adds no extra hop or per-request Lambda invocation cost.

## Consequences

- **No signature validation in nginx.** njs only decodes the payload; the API Gateway JWT
  authorizer already validated the token upstream (trust boundary per [[ADR-0010-cognito-auth]]).
  A missing/malformed token yields an empty `x-user-id`, which the service then answers with
  401/404 per its own route contract — nothing throws in nginx.
- **Local-only mechanism.** No production IaC changes: production uses the API Gateway's native
  claim→header mapping in its own deploy milestone. The local njs script is a documented,
  scoped exception to keeping nginx config minimal (one `js_set` + one `proxy_set_header`).
- **Corrects an assumption in [[ADR-0016-local-apigw-nginx-ecs]].** That ADR originally assumed
  local ECS "cannot mount host volumes" (inherited from Ministack) and embedded the nginx config
  in the task's shell `command`. Floci **does** support ECS host volumes (verified live), so the
  config moved to real, checked-in files bind-mounted in — see the ADR's "Update (2026-07-11)"
  section, which this decision is the concrete implementation of.
- **Extended to Orders.** Per [[2026-07-15-orders-gateway-integration-design]], the same njs
  `x-user-id` injection applies to the `location /v1/orders/` block nginx gained for Orders — no
  change to the njs script itself, since the header is set at the `http` level and applies to
  every location.
- Floci also does not validate refresh tokens (a garbage refresh token returns `200`), so the
  `/v1/users/refresh` 401 path is exercisable only against real AWS or in unit tests, not
  locally end-to-end — a related, separately-noted Floci gap.

## Related

- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0010-cognito-auth]]
- [[2026-07-11-gap1-nginx-njs-xuserid-design]]
- [[2026-07-11-gap1-nginx-njs-xuserid]]
- [[2026-07-15-orders-gateway-integration-design]]
- [[users-service-design]]
- [[terraform-modules]]
