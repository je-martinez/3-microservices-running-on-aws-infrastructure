---
title: Testing
type: convention
area: shared
status: active
created: 2026-07-17
updated: 2026-08-03
tags: [type/convention, area/shared, status/active]
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[local-dev]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway]]"
---

# Testing

## Rule

Every HTTP endpoint MUST have all three test layers before it is considered done:

1. **Unit / integration** — the endpoint's logic tested in isolation. Orders uses xUnit with
   Testcontainers-MySQL through the in-process `WebApplicationFactory`; Users uses vitest with a
   mocked container; Tracking uses pytest against a **live** MySQL rather than mocks.
2. **Internal E2E** — the service's own URL hit directly, bypassing the gateway, with `x-user-id`
   faked. Each service has its own internal Playwright spec running against its own port: orders
   against `http://localhost:3001`, users against `http://localhost:3000`, tracking against
   `http://localhost:3002`. Do not assume users' port applies to every service — each service gets
   its own spec at its own port.
3. **Gateway E2E** — the `API_GATEWAY_URL` the end user actually hits, with a real
   `Authorization: Bearer <Cognito JWT>`. This is the only layer that exercises the full
   user-facing path: JWT authorizer → njs sub-extraction → nginx routing → service.

**File structure — every service needs BOTH Playwright specs.** Layers 2 and 3 are not one spec
each in the abstract — every service MUST have exactly two Playwright spec files, and both must
exist and cover the service's endpoints:

- **Internal spec:** `e2e/tests/<service>.spec.ts` — the `internal` project, hits the service
  directly (orders on `http://localhost:3001`, users on `:3000`) with `x-user-id` faked.
- **Gateway spec:** `e2e/tests/gateway/<service>.spec.ts` — the `gateway` project, hits
  `API_GATEWAY_URL` with a real JWT.

**An endpoint missing either its internal OR its gateway E2E spec is an incomplete change** — the
same imperative as the OpenAPI golden rule applies here. Run all E2E layers with
`pnpm --filter @3mrai/e2e test`, which executes both the `internal` and `gateway` Playwright
projects. This requires the local stack to be up via `make bootstrap` (see [[local-dev]]).

**Commands.** `make test-e2e` (or its shorthand `pnpm e2e`) is exactly that
`pnpm --filter @3mrai/e2e test` run — use whichever is convenient. On-demand commands for the
three layers:

- `make test-all` — all three layers for all three services (unit + internal E2E + gateway E2E);
  E2E requires the stack up (`make bootstrap`).
- `make test-unit` — layer 1 only (orders `dotnet test`, users `vitest`, tracking `pytest`, e2e
  `typecheck`); no stack needed.
- `make test-e2e` — layers 2+3 (Playwright internal + gateway); requires the stack up.
- `pnpm --filter @3mrai/e2e typecheck` (or `pnpm run typecheck` from `e2e/`) — static type-check
  of the E2E specs; also runs as part of `make test-unit`.
- Granular package.json scripts: `pnpm orders:test`, `pnpm users:test`, `pnpm e2e:internal`,
  `pnpm e2e:gateway`, `pnpm e2e` (both projects).

**Symmetry check:** when adding a service or endpoint, confirm both `e2e/tests/<svc>.spec.ts` and
`e2e/tests/gateway/<svc>.spec.ts` exist and cover it — an easy asymmetry to miss (this is exactly
what happened with orders: a gateway spec existed with no internal spec until it was caught in
review).

## Rationale

Unit/integration and internal E2E tests both fake the authorizer — they inject `x-user-id`
directly and never touch the gateway. An endpoint can pass every one of those tests and still be
broken for the actual user, because nothing in that path exercises the real Cognito JWT, the
authorizer, or nginx's routing rules (see [[ADR-0010-cognito-auth]], [[ADR-0016-local-apigw-nginx-ecs]]).

This gap is not theoretical: in a single session, three gateway-only bugs shipped past every
existing test. `/v1/products` returned 404 because the gateway route was never added. `GET
/v1/orders/{orderId}` returned 405 because the integration path dropped the id segment. A path
parameter named with an underscore crashed Floci's routing regex with a 500. All three were
invisible to unit, integration, and internal E2E tests, and all three surfaced immediately through
the gateway URL. Gateway E2E closes that gap by testing exactly what the user hits, not a
convenient stand-in for it.

## Per-service guidance

This convention defines the rule; each service documents how it satisfies the three layers and
the checklist for adding a new endpoint:

- [[orders/testing/index|Orders Testing]]
- [[users/testing/index|Users Testing]]
- [[tracking/testing/index|Tracking Testing]]

## E2E cleanup by tag

All three services expose a flag-guarded `e2e-cleanup` endpoint (Users `DELETE /v1/users/e2e-cleanup`,
Orders `DELETE /v1/orders/e2e-cleanup`, Tracking `DELETE /v1/trackings/e2e-cleanup`), and the E2E
harness's global teardown (`e2e/support/global-teardown.ts`) calls all three at the end of a run.
Each takes **no caller identity** — the harness's teardown runs once, globally, with no user
session — so ownership-by-caller cannot work here; instead, every service marks the rows a test
created with a `"E2E Source"` tag at write time, and the cleanup deletes by that tag.

A row is tagged only when the write request sent `x-e2e-source: true` **and** the service's own
`E2E_TESTING_ENABLED` flag was on — **both conditions are mandatory**. The conjunction is what stops
an untrusted client tagging its own rows so that someone else's teardown deletes them; the header
alone is never sufficient. The same two-part rule protects `test_mode`/`x-test-mode` (see
[[tracking-service-design#TestMode automatic progression]]). With the flag off, neither half of the
mechanism exists: nothing gets tagged, and (in Orders and Tracking) the cleanup route itself is
never mounted, so a caller sees `405` on that path rather than a `404` or a silently-empty `200`.
Every service implements the underlying delete as a soft-delete, per [[soft-delete]].

## Related

- [[ADR-0010-cognito-auth]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[local-dev]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
- [[2026-07-17-testing-layers-and-e2e-gateway]] — the implementation plan for the design above.
- [[orders/testing/index|Orders Testing]]
- [[users/testing/index|Users Testing]]
- [[tracking/testing/index|Tracking Testing]]
- [[soft-delete]] — the soft-delete-by-tag mechanism each service's `e2e-cleanup` endpoint uses.
- [[tracking-service-design]] — Tracking's `e2e-cleanup` endpoint and the `x-e2e-source`/
  `E2E_TESTING_ENABLED` conjunction, documented in full.
