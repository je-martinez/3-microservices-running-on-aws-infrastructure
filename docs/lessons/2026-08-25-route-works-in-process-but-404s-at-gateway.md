---
title: "A route that works in-process can still 404 at the gateway"
type: lesson
area: shared
status: active
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[testing]]"
  - "[[orders-service-design]]"
  - "[[2026-08-25-cart-endpoints-design]]"
---

# A route that works in-process can still 404 at the gateway

## Finding

The three `/v1/cart` routes passed all 233 in-process/integration tests and answered `200` when
hit directly on the Orders service port. Through the real gateway URL — the one the frontend
actually calls — they returned the gateway's own `{"message":"Not Found"}` 404.

Root cause: the routes existed in the .NET Minimal API and had full unit/integration coverage,
but had never been declared in `infra/modules/api-gateway/main.tf`, and nginx had no
`location /v1/cart` block. Without that block, the path falls through to nginx's default `/`
location and silently resolves to Users on port 3000 instead of Orders on 8080 — see
[[orders-service-design]] for why `/v1/products` needed the same dedicated block for the
identical reason (it is served by Orders under its own top-level path, not under `/v1/orders/*`).

This is exactly the fault class `services/orders/CLAUDE.md` §2b's third test layer exists to
catch: in-process/internal E2E tests fake the authorizer and hit the service URL directly, so
they never traverse API Gateway or nginx and cannot see a missing route declaration. See
[[testing]].

## The diagnostic

**A `404` carrying the gateway's own body shape (`{"message":"Not Found"}`) rather than the
service's own error shape (`{"error": "..."}`) means the request never reached the service at
all.** This is the tell that distinguishes "the route doesn't exist in the service" from "the
route isn't wired at the gateway" — the two look identical from a black-box client's
perspective ("I got a 404") until you look at the response body shape.

**After the fix, a `401` is the good answer**, not a bug. A `401 Unauthorized` on a route that
previously 404'd proves the route now resolves through nginx/API Gateway and reached the
Cognito authorizer — the authorizer rejecting an unauthenticated/malformed test request is
expected and correct. Chasing that 401 as if it were still the routing bug wastes a debugging
cycle re-solving an already-solved problem.

## How to apply

- **A new HTTP route needs three declarations, not one**: the service's own route definition,
  the API Gateway resource (`infra/modules/api-gateway/main.tf`), and — for anything not covered
  by an existing path prefix — its own nginx `location` block
  (`infra/modules/compute/nginx/nginx.conf`). Missing any one of the three produces a route that
  works everywhere except through the URL a real user hits.
- **Gateway E2E with a real Cognito JWT (`services/orders/CLAUDE.md` §2b, [[testing]]) is not
  optional polish** — it is the only test layer that would have caught this, because it is the
  only layer that actually goes through nginx/API Gateway rather than the service's bare port.
- **When a new route 404s only through the gateway, check the response body shape first** before
  assuming the service itself is broken — the gateway's own 404 body is the fastest signal that
  routing, not application code, is the fault.

## Related

- [[testing]] — the three-test-layer convention this finding is a concrete instance of.
- [[orders-service-design]] — documents why `/v1/products` and `/v1/cart` each need their own
  nginx `location` block, being served by Orders under a top-level path outside `/v1/orders/*`.
- [[2026-08-25-cart-endpoints-design]] — the spec/milestone this was found during.
