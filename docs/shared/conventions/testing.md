---
title: Testing
type: convention
area: shared
status: active
created: 2026-07-17
updated: 2026-07-17
tags: [type/convention, area/shared, status/active]
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[local-dev]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
---

# Testing

## Rule

Every HTTP endpoint MUST have all three test layers before it is considered done:

1. **Unit / integration** — the endpoint's logic tested in isolation. Orders uses xUnit with
   Testcontainers-MySQL through the in-process `WebApplicationFactory`; Users uses vitest with a
   mocked container.
2. **Internal E2E** — the service's own URL hit directly, bypassing the gateway, with `x-user-id`
   faked. This is the existing Playwright `e2e/` suite running against `http://localhost:3000`.
3. **Gateway E2E** — the `API_GATEWAY_URL` the end user actually hits, with a real
   `Authorization: Bearer <Cognito JWT>`. This is the only layer that exercises the full
   user-facing path: JWT authorizer → njs sub-extraction → nginx routing → service.

**An endpoint missing gateway E2E is an incomplete change** — the same imperative as the OpenAPI
golden rule applies here. Gateway specs live in `e2e/tests/gateway/`. Run all E2E layers with
`pnpm --filter @3mrai/e2e test`, which executes both the `internal` and `gateway` Playwright
projects. This requires the local stack to be up via `make bootstrap` (see [[local-dev]]).

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

## Related

- [[ADR-0010-cognito-auth]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[local-dev]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
- [[orders/testing/index|Orders Testing]]
- [[users/testing/index|Users Testing]]
