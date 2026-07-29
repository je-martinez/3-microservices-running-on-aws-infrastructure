---
title: Three-Layer Testing Convention + E2E-Gateway Harness Design
type: spec
area: shared
status: draft
created: 2026-07-17
updated: 2026-07-17
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[local-dev]]"
  - "[[versioning]]"
propagates-to:
  - "[[testing]]"
---

# Three-Layer Testing Convention + E2E-Gateway Harness Design

## Summary

Establish a testing convention requiring **three layers per HTTP endpoint** — unit/integration,
internal E2E (direct service URL), and **E2E through the API gateway with a real Cognito JWT** — and
build the harness that makes the third layer real. Today **no automated test goes through the API
gateway with a JWT**: the orders xUnit suite and users vitest run in-process, and the existing
Playwright `e2e/` suite deliberately drives the users service directly on `:3000`, faking the
authorizer by injecting `x-user-id`. That bypass was justified by a comment claiming "the API
Gateway (Floci) does not forward the request path for HTTP_PROXY integrations" — an assumption this
session **disproved** (Floci substitutes a `{param}` in the integration URI with the real request
value; it was the missing `{orderId}` in the integration path, not path-forwarding, that produced a
405). This gap let three gateway-only bugs ship this session — `/v1/products` 404 (missing gateway
route), `/v1/orders/{orderId}` 405 (integration path dropped the id), and a Floci regex 500 (path
param named with an underscore) — none caught by any test, because the user-facing URL was never
exercised.

We **expand, not replace**: the current internal E2E scenario stays; we **add** a gateway scenario
that hits `API_GATEWAY_URL` with a Bearer JWT. Both run.

## Goals

- A documented convention: every endpoint has (1) unit/integration, (2) internal E2E, (3) gateway
  E2E with a real JWT. "An endpoint without all three is an incomplete change."
- A reusable JWT-acquisition helper (register → login through the gateway) using a dedicated,
  marked, auto-cleaned E2E user.
- A second Playwright project ("gateway") alongside the existing internal one, covering all current
  users + orders endpoints through the gateway.
- Correct the obsolete "gateway drops the path" bypass rationale so the pattern isn't perpetuated.

## Non-Goals

- Replacing or removing the existing internal E2E suite — it stays and keeps faking auth via
  `x-user-id` (it tests the service in isolation).
- Standing up CI. There is no application CI today; these tests run locally against `make bootstrap`.
  Automating a Floci-backed CI environment is a separate follow-up.
- Changing the services, the gateway, or auth — the `{orderId}` path fix that unblocked gateway
  routing is already committed. This design only adds tests + docs (and one obsolete-comment fix).

## The Convention (what is required)

Every HTTP endpoint requires three test layers:

1. **Unit / integration** — the endpoint's logic in isolation. Exists today: orders xUnit +
   Testcontainers-MySQL via `OrdersApiFactory` (in-process `WebApplicationFactory`); users vitest
   via `buildApp` with a mocked Awilix container.
2. **Internal E2E** — the service's own URL directly (bypassing the gateway), auth faked with
   `x-user-id`. Exists today: the Playwright `e2e/` suite against `http://localhost:3000`. **Kept
   as-is.**
3. **Gateway E2E** — the `API_GATEWAY_URL` the end user hits, with a real `Authorization: Bearer
   <JWT>`. This exercises the JWT authorizer → njs `sub` extraction → nginx routing → service, i.e.
   the whole user-facing path. **New; added alongside layer 2.**

Each gateway E2E asserts the classes of failure this session hit: the route resolves (no routing
404/405/500), the authorizer accepts a valid JWT (and rejects a missing/invalid one), and the
service returns the correct result.

### Where the convention is documented (four layers, each for its reader)

- **`docs/shared/conventions/testing.md`** (NEW) — the cross-service source of truth, following the
  convention template, indexed from `docs/00-overview/index.md`. Referenced by `[[testing]]`.
- **`services/orders/CLAUDE.md` + `services/users/CLAUDE.md`** — a GOLDEN-RULE-style section
  ("every endpoint needs all three test layers … an endpoint missing gateway E2E is an incomplete
  change"), the strong imperative agents read while implementing, linking to `[[testing]]`.
- **Root `CLAUDE.md`** — a one-line global rule under Working rules, so it binds the whole repo.
- **`docs/domains/{orders,users}/testing/`** (currently empty `.gitkeep`) — concrete per-service
  guidance: how to run each layer, the gateway harness, the seeded/known fixtures.

## The Harness (how)

Expand the existing `@3mrai/e2e` Playwright package — do not rewrite it.

### Structure

```
e2e/
├── playwright.config.ts    ← two projects: "internal" (existing) + "gateway" (new)
├── support/
│   ├── api-client.ts        ← existing (direct service, x-user-id) — comment corrected
│   ├── gateway-client.ts    ← NEW: baseURL = API_GATEWAY_URL, attaches Bearer JWT
│   ├── auth.ts              ← NEW: register→login helper → returns a token
│   ├── chance-factory.ts    ← existing (random users) — reused by auth.ts
│   ├── global-setup.ts      ← extended: also health-check the gateway
│   └── global-teardown.ts   ← existing e2e-cleanup — reused for the E2E user
└── tests/
    ├── users.spec.ts        ← existing internal spec — kept
    └── gateway/             ← NEW: gateway specs (all endpoints)
```

### Auth helper (`auth.ts`) — the key new piece

- Creates a **dedicated E2E user**, marked and auto-cleaned (reusing the existing `X-E2E-Source:
  true` header and the flag-gated `DELETE /v1/users/e2e-cleanup` teardown), with an identifiable
  email (e.g. `e2e+<random>@…` from the existing `chance-factory`). Not a random user polluting real
  data, not a magic seeded user.
- Flow: `POST /v1/users/register` then `POST /v1/users/login` **through the gateway** (both are
  `auth = false` public routes) → returns the token to use as `Bearer`.
- **Which token:** the login returns `idToken`/`accessToken`. This session verified live that the
  **accessToken** passes the gateway JWT authorizer and its `sub` is what njs forwards as
  `x-user-id`. The helper returns that; implementation confirms which token the Floci authorizer
  accepts (id vs access audience) and pins it.

### Config

- The "gateway" Playwright project sets `baseURL = process.env.API_GATEWAY_URL` (already in `.env`,
  refreshed by `make env-file`). The "internal" project keeps `http://localhost:3000`.
- `global-setup` additionally health-checks the gateway (`GET /v1/orders/health`, a public route)
  and fails with a clear "run `make bootstrap`" message if the stack is down (mirrors the existing
  service health check).
- The obsolete comment in `api-client.ts` (gateway "does not forward the request path") is corrected
  — the new gateway client + specs demonstrate it does, once the integration URI carries the param.

## Coverage & Phasing

**Target: all current endpoints, through the gateway.**

- **users:** `GET`/`PATCH /v1/users/me` (protected); `POST /v1/users/{register,login,refresh}` and
  health (public — also the helper's own flow).
- **orders:** `GET /v1/products`, `POST /v1/orders`, `GET /v1/orders/my-orders`,
  `GET /v1/orders/{orderId}`, `GET /v1/orders/health`.

Each gateway spec asserts: route resolves (no routing 404/405/500), authorizer behavior (200 with a
valid JWT, 401 without), and a correct service response.

Phased to avoid a fragile big-bang:

- **Phase 1 — convention + harness base:** the four convention docs; `gateway-client.ts`; `auth.ts`
  (E2E user, register→login→token); extended `global-setup`; and **one end-to-end gateway spec**
  proving the pattern (e.g. register→login→`POST /v1/orders`→`GET /v1/orders/{id}`, the exact flow
  that 405'd this session). This de-risks the harness before broad coverage.
- **Phase 2 — full coverage:** gateway specs for every remaining users + orders endpoint.

## Risks & Open Points

- **Authorizer token type** — confirm the Floci JWT authorizer accepts the chosen token (access vs
  id audience). Verified live that a real Bearer works; pin the exact token in `auth.ts`.
- **Stack dependency** — gateway E2E needs the full local stack (`make bootstrap`: Floci + apply +
  compose). `global-setup` must fail fast and clearly when it's down. No CI runs this yet.
- **E2E user isolation** — each run creates its own marked user and cleans it up; confirm
  `e2e-cleanup` covers orders too (it soft-deletes the caller's orders) so gateway create-order
  specs don't accumulate data.
- **Gateway env freshness** — `API_GATEWAY_URL` (and Cognito IDs) change on every `make bootstrap`;
  the harness must read them from `.env` at run time, never hardcode.

## Verification

- `pnpm --filter @3mrai/e2e test` runs both projects; the "internal" project passes unchanged and
  the "gateway" project register→login→calls each endpoint with a Bearer JWT and asserts the
  results.
- A gateway spec that would have caught this session's bugs: `GET /v1/orders/{id}` via the gateway
  returns 200 (not 405), `/v1/products` via the gateway returns 200 (not 404).
- The convention docs exist and are indexed; the per-service CLAUDE.md GOLDEN-RULE sections link to
  `[[testing]]`; `node scripts/validate-vault.mjs` passes.

## Related

- [[ADR-0010-cognito-auth]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[local-dev]]
- [[versioning]]
