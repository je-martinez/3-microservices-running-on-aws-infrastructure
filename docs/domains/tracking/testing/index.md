---
title: Tracking Testing
type: runbook
area: tracking
status: active
created: 2026-07-31
updated: 2026-08-27
tags: [type/runbook, area/tracking, status/active]
related:
  - "[[testing]]"
  - "[[tracking-service-design]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[orders-service-design]]"
  - "[[2026-08-27-go-vs-python-performance]]"
---

# Tracking Testing

How the Tracking service satisfies the [[testing]] three-layer convention, and the checklist
to follow when adding a new endpoint.

## Layer 1 — unit / integration

```bash
cd services/tracking && pytest
```

Run against a **live** MySQL instance rather than mocks — the repository, migration,
state-machine, and TestMode-progression tests all exercise the real Alembic schema. The count
grows with the service; check `pytest --collect-only -q | tail -1` for the current total rather
than trusting a number pinned here (it drifted from 294 to 373 without this note being touched).
Files live under `services/tracking/tests/`, split by concern — non-exhaustive, but every layer
of the service has a file: `test_repository.py`, `test_status_state_machine.py`,
`test_test_mode_progression.py`, `test_rest_init_tracking.py`, `test_rest_reads.py`,
`test_rest_carrier_status.py`, `test_rest_e2e_cleanup.py`, `test_rest_health.py`,
`test_users_client.py`, `test_current_caller.py`, `test_app_factory.py`, `test_engine.py`,
`test_grpc_stubs.py`, `test_migration.py`, `test_log_identity.py`, `test_settings.py`, plus
fixtures in `conftest.py`.

> [!warning] Ownership tests need two distinct identity values
> Any test asserting the `cognito_sub`-scoped ownership filter must use **different** values
> for `user_id` and `cognito_sub`. A test that creates and reads with the same value for both
> cannot fail on the bug described in [[user-id-vs-cognito-sub-ownership-key]] — this is how
> the original regression passed 253 tests before this ADR's fix.

> [!warning] The suite runs against the SHARED local database — leave the schema as you found it
> "Live MySQL" above means the same local `tracking` database the running service and the
> gateway E2E suite use, not a throwaway one — Floci's MySQL grants the `test` user no
> `CREATE DATABASE` privilege, so a per-run database is not an option, and running against the
> real one (then restoring it) is the only way to exercise the schema for real. Any fixture that
> manipulates schema must leave it exactly as it found it: a teardown `drop_all` once left the
> local stack with no tracking tables, surfacing as `init-tracking` returning 500 and the
> gateway E2E going red — a failure that looked like broken application code, not a test side
> effect. Dropping the model tables does **not** drop `alembic_version` (no model declares it),
> and with the stamp intact `alembic upgrade head` becomes a no-op that reports success — so
> `make migrate-tracking` prints "applied" while applying nothing. Tables and migration stamp
> must always be restored together. Full mechanics: `services/tracking/CLAUDE.md` §5c-bis.
> Fixed 2026-08-06.

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

## Layer 4 — performance (Go migration closing gate)

[[2026-08-27-go-vs-python-performance]] records the measured Go-vs-Python comparison run as
closing-gate criterion 3 of the [[2026-08-27-tracking-go-migration-design|Go migration]]
(Task 26). Resource and startup metrics (image size, cold start, memory) were measured reliably
and Go wins all four; latency and throughput under sustained load were **not** measurable on
this stack — the local AWS emulator (Floci), not either runtime, was the bottleneck. See that
note for the full methodology, the two measurement defects it caught, and what a trustworthy
latency run would require.

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
- [[2026-08-27-go-vs-python-performance]] — the measured Go-vs-Python performance comparison,
  the fourth verification axis alongside the three test layers above.
