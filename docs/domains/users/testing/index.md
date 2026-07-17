---
title: Users Testing
type: runbook
area: users
status: active
created: 2026-07-17
updated: 2026-07-17
tags: [type/runbook, area/users, status/active]
related:
  - "[[testing]]"
  - "[[users-service-design]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
---

# Users Testing

How the Users service satisfies the [[testing]] three-layer convention, and the checklist to
follow when adding a new endpoint.

## Layer 1 — unit / integration

```bash
cd services/users && pnpm test
```

vitest, run against a mocked Awilix container — no real database or Cognito call. Auth is faked
by injecting the identity directly rather than going through a JWT.

## Layer 2 — internal E2E

The Playwright `e2e/` "internal" project hits the service directly on `http://localhost:3000`,
with `x-user-id` faked — bypassing the gateway entirely.

## Layer 3 — gateway E2E

The Playwright "gateway" project hits `API_GATEWAY_URL` with a real Cognito JWT. Specs live in
`e2e/tests/gateway/users.spec.ts`.

Run all E2E layers (internal + gateway):

```bash
pnpm --filter @3mrai/e2e test
```

This requires the local stack up via `make bootstrap` (see [[local-dev]]). The gateway harness
auto-loads the repo-root `.env` and registers→logs in a dedicated E2E user (`support/auth.ts`) to
obtain the real JWT used as the `Authorization: Bearer` header.

## Checklist for a new users endpoint

1. Add a vitest unit/integration test against the mocked container.
2. Add an internal E2E spec if the endpoint needs service-direct coverage.
3. Add a gateway spec in `e2e/tests/gateway/users.spec.ts` hitting the endpoint through
   `API_GATEWAY_URL` with a real JWT.
4. If it's a new public or protected HTTP route, add **both**:
   - the API Gateway route in `infra/modules/api-gateway/main.tf`, and
   - the corresponding nginx location.

   The route must resolve through the gateway, not just the service directly — this is exactly
   what the `/v1/products` 404 and `{orderId}` 405 bugs were on the orders side (see
   [[2026-07-17-testing-layers-and-e2e-gateway-design]]). Note: gateway path params use camelCase
   (Floci's Java-regex router), and the integration path must include the `{param}` segment or
   Floci silently drops it.
5. Regenerate `openapi.yaml` via `pnpm generate:openapi` per the golden rule in
   `services/users/CLAUDE.md`.

## Related

- [[testing]]
- [[users-service-design]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
