---
title: Tracking Testing
type: runbook
area: tracking
status: active
created: 2026-07-31
updated: 2026-07-31
tags: [type/runbook, area/tracking, status/active]
related:
  - "[[testing]]"
  - "[[tracking-service-design]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[orders-service-design]]"
---

# Tracking Testing

How the Tracking service satisfies the [[testing]] three-layer convention, and the checklist
to follow when adding a new endpoint.

## Layer 1 — unit / integration

```bash
cd services/tracking && pytest
```

294 tests, run against a **live** MySQL instance rather than mocks — the repository,
migration, state-machine, and TestMode-progression tests all exercise the real Alembic
schema. Files live under `services/tracking/tests/`, split by concern: `test_repository.py`,
`test_status_state_machine.py`, `test_test_mode_progression.py`, `test_rest_init_tracking.py`,
`test_rest_reads.py`, `test_rest_carrier_status.py`, `test_users_client.py`,
`test_current_caller.py`, plus fixtures in `conftest.py`.

> [!warning] Ownership tests need two distinct identity values
> Any test asserting the `cognito_sub`-scoped ownership filter must use **different** values
> for `user_id` and `cognito_sub`. A test that creates and reads with the same value for both
> cannot fail on the bug described in [[user-id-vs-cognito-sub-ownership-key]] — this is how
> the original regression passed 253 tests before this ADR's fix.

## Layer 2 — internal E2E

The Playwright `e2e/` "internal" project hits the service directly, with `x-user-id` faked —
bypassing the gateway entirely. The spec lives in `e2e/tests/tracking.spec.ts`.

## Layer 3 — gateway E2E

The Playwright "gateway" project hits `API_GATEWAY_URL` with a real Cognito JWT. Specs live in
`e2e/tests/gateway/tracking.spec.ts` (single-endpoint coverage) and
`e2e/tests/gateway/tracking-flow.spec.ts` (the multi-step create→poll-until-`DELIVERED` flow
that verifies [[tracking-service-design#TestMode automatic progression]] end to end — see
[[tracking-service-design#Gateway E2E verification of TestMode]] for why this endpoint exists
at all). The carrier `PUT` endpoint's custom API key is supplied via
`e2e/support/tracking-carrier-key.ts` rather than a Cognito JWT, since that route is
unauthenticated at the gateway (`auth = false`) and validated by the service itself — see
[[two-api-keys-two-trust-domains]].

Run all E2E layers (internal + gateway):

```bash
pnpm --filter @3mrai/e2e test
```

This requires the local stack up via `make bootstrap` (see [[local-dev]]). The gateway harness
auto-loads the repo-root `.env` and registers→logs in a dedicated E2E user
(`e2e/support/auth.ts`) to obtain the real JWT used as the `Authorization: Bearer` header.

## Checklist for a new Tracking endpoint

1. Add a pytest unit/integration test under `services/tracking/tests/`, run against the live
   MySQL database — not a mocked session. A mocked session can pass while the real
   schema/driver rejects the same write, the same class of gap
   [[2026-07-12-prisma-lazy-promise-als]] describes for a mocked Prisma client.
2. Add **both** Playwright E2E specs — one is not a substitute for the other:
   - an internal spec in `e2e/tests/tracking.spec.ts`, hitting the service directly with
     `x-user-id` faked, and
   - a gateway spec in `e2e/tests/gateway/tracking.spec.ts` (or `tracking-flow.spec.ts` for a
     multi-step flow), hitting the endpoint through `API_GATEWAY_URL` with a real JWT.
3. If it's a new HTTP route, add **both**:
   - the API Gateway route in `infra/modules/api-gateway/main.tf` — remember gateway path
     params are camelCase (`{orderId}`, not `{order_id}`), per
     [[tracking-service-design#Gateway path params are camelCase, not snake_case]], and
   - the corresponding nginx location, prefixed per-service the way
     [[tracking-service-design#Gateway-prefixed health path, not bare `/v1/health`]] documents
     for the health check.
4. If the endpoint is user-scoped, filter by `cognito_sub`, never `user_id` — see
   [[user-id-vs-cognito-sub-ownership-key]] — and write the ownership test with two distinct
   identity values per the warning above.

## Related

- [[testing]]
- [[tracking-service-design]]
- [[user-id-vs-cognito-sub-ownership-key]]
- [[two-api-keys-two-trust-domains]]
- [[orders-service-design]] — Orders' equivalent testing runbook and identical ownership
  pattern.
