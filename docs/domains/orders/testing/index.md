---
title: Orders Testing
type: runbook
area: orders
status: active
created: 2026-07-17
updated: 2026-07-17
tags: [type/runbook, area/orders, status/active]
related:
  - "[[testing]]"
  - "[[orders-service-design]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
---

# Orders Testing

How the Orders service satisfies the [[testing]] three-layer convention, and the checklist to
follow when adding a new endpoint.

## Layer 1 — unit / integration

```bash
cd services/orders && dotnet test
```

xUnit + Testcontainers-MySQL via `OrdersApiFactory`, an in-process `WebApplicationFactory`. It
seeds a product, mocks `IUserDirectory`, and fakes auth via the `x-user-id` header. Requires
Docker (Testcontainers spins up a real MySQL container per run).

## Layer 2 — internal E2E

The Playwright `e2e/` "internal" project hits the service directly on `http://localhost:3001`,
with `x-user-id` faked — bypassing the gateway entirely. The spec lives in
`e2e/tests/orders.spec.ts`.

## Layer 3 — gateway E2E

The Playwright "gateway" project hits `API_GATEWAY_URL` with a real Cognito JWT. Specs live in
`e2e/tests/gateway/orders.spec.ts` (plus `orders-flow.spec.ts` for the multi-step
create→list→get flow).

Run all E2E layers (internal + gateway):

```bash
pnpm --filter @3mrai/e2e test
```

This requires the local stack up via `make bootstrap` (see [[local-dev]]). The gateway harness
auto-loads the repo-root `.env` and registers→logs in a dedicated E2E user (`support/auth.ts`) to
obtain the real JWT used as the `Authorization: Bearer` header.

## Checklist for a new orders endpoint

1. Add a .NET unit/integration test (xUnit, `OrdersApiFactory`).
2. Add **both** Playwright E2E specs — one is not a substitute for the other:
   - an internal spec in `e2e/tests/orders.spec.ts`, hitting the service directly on
     `http://localhost:3001` with `x-user-id` faked, and
   - a gateway spec in `e2e/tests/gateway/orders.spec.ts`, hitting the endpoint through
     `API_GATEWAY_URL` with a real JWT — see the `products` create / get-by-id specs as examples.
3. If it's a new HTTP route, add **both**:
   - the API Gateway route in `infra/modules/api-gateway/main.tf`, and
   - the corresponding nginx location.

   The route must resolve through the gateway, not just the service directly — this is exactly
   what the `/v1/products` 404 and `{orderId}` 405 bugs were (see
   [[2026-07-17-testing-layers-and-e2e-gateway-design]]). Note: gateway path params use camelCase
   (Floci's Java-regex router), and the integration path must include the `{param}` segment or
   Floci silently drops it.
4. Regenerate `openapi.yaml` per the golden rule in `services/orders/CLAUDE.md`.

## Related

- [[testing]]
- [[orders-service-design]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
