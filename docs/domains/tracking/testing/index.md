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
  - "[[testmode-in-process-no-durable-scheduler]]"
---

# Tracking Testing

How the Tracking service satisfies the [[testing]] three-layer convention, and the checklist
to follow when adding a new endpoint.

## Layer 1 — unit / integration

```bash
cd services/tracking-go && make test-db
```

`make test` alone runs `go test -race ./...` but **silently skips** the database-backed tests
in `internal/adapter/mysql` for want of a live connection, and still prints `ok` — a hollow
green that already cost the Go migration a debugging session (see
[[testmode-in-process-no-durable-scheduler]]'s sibling wiring-hazard lessons for the same
shape of failure). `make test-db` discovers the real host/port/credentials from the generated
`.env.local.tracking` (Floci reassigns RDS proxy ports on every apply, so the port is never a
constant) and exports **both** `TRACKING_DATABASE_URL` (the creation/reads/transition suites)
and `TRACKING_TEST_MYSQL_DSN` (the count/soft-delete suites) — setting only one of the two
still leaves part of the suite skipping silently. Without the local stack up, use
`make -C services/tracking-go test-no-db`, which skips loudly instead.

Run against a **live** MySQL instance rather than mocks — the repository, migration,
state-machine, and TestMode-progression tests all exercise the real golang-migrate schema. The
suite lives under `services/tracking-go/internal/`, colocated with the code it tests per Go
convention (`*_test.go` beside the file it covers), not gathered into a separate `tests/`
directory the way the retired Python service organized it.

> [!warning] Ownership tests need two distinct identity values
> Any test asserting the `cognito_sub`-scoped ownership filter must use **different** values
> for `user_id` and `cognito_sub`. A test that creates and reads with the same value for both
> cannot fail on the bug described in [[user-id-vs-cognito-sub-ownership-key]] — this is how
> the original regression passed 253 tests before this ADR's fix, and the ADR's Go addendum
> records a second, Go-specific way the same mistake reappears: an optional-scope parameter
> whose zero value is `""` rather than `nil`, silently meaning "scoped to the empty string"
> instead of "unscoped."

> [!warning] The suite runs against the SHARED local database — leave the schema as you found it
> "Live MySQL" above means the same local `tracking` database the running service and the
> gateway E2E suite use, not a throwaway one — Floci's MySQL grants the `test` user no
> `CREATE DATABASE` privilege, so a per-run database is not an option, and running against the
> real one (then restoring it) is the only way to exercise the schema for real. Any fixture that
> manipulates schema must leave it exactly as it found it: a teardown that drops the tracking
> tables once left the local stack with no schema, surfacing as `init-tracking` returning 500
> and the gateway E2E going red — a failure that looked like broken application code, not a
> test side effect. Dropping the tables does **not** drop `schema_migrations`, and with the
> stamp intact `migrate up` becomes a no-op that reports success — so `make migrate-tracking`
> prints "applied" while applying nothing. Tables and migration stamp must always be restored
> together. `make doctor` cross-checks tables against the databases that should hold them
> precisely so this surfaces before a request does. Full mechanics:
> `services/tracking-go/CLAUDE.md` §6, and `services/tracking-go/migrations/README.md` for the
> stamp-vs-replay recipe.

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

1. Add a `go test` unit/integration test beside the code it covers under
   `services/tracking-go/internal/`, run against the live MySQL database — not a mocked
   `*sql.DB`. A mocked repository test can pass while the real schema/driver rejects the same
   write (the 1062 duplicate-key translation, a `NULL` scan, `JSON_CONTAINS`, fsp-0 rounding —
   see `services/tracking-go/CLAUDE.md` §6), the same class of gap
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
- [[testmode-in-process-no-durable-scheduler]] — the wiring-hazard shape referenced above: a
  component that is correct, unit-tested, and never reached by the running process.
