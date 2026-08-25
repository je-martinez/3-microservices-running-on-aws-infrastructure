---
title: Orders Testing
type: runbook
area: orders
status: active
created: 2026-07-17
updated: 2026-08-25
tags: [type/runbook, area/orders, status/active]
related:
  - "[[testing]]"
  - "[[orders-service-design]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-16-orders-list-products-endpoint-design]]"
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

## Layer 4 — load testing (a different question: shape, not correctness)

Not a substitute for layers 1-3 and not scored against the same criteria. The three layers above
answer "is it correct?"; load testing answers "what shape does it have under sustained traffic?"
— percentiles, throughput, error rate, not pass/fail assertions on behaviour. Full framing:
`e2e/CLAUDE.md` §1, and the `gatling-js` skill.

Lives in `e2e/load-tests/`, run with `pnpm run smoke` / `pnpm run load` (see `e2e/CLAUDE.md` §2).
Cart coverage:

- `e2e/load-tests/src/scenarios/cart.ts` — four named requests: `putCart`, `getCart`,
  `updateCartQuantity` (exercises the sync path on an existing cart, not creation), `deleteCart`
  (exercises the same shared deletion path an `items: []` PUT and an order-consuming-the-cart
  flow both go through).
- A **"Cart buyer journey"** scenario in `e2e/load-tests/src/fullJourney.gatling.ts`: register →
  login → list products → build a cart → read it **three times** (a real page load / cart-badge
  refresh pattern) → then a `randomSwitch()` split, 85% updates the quantity and orders from the
  cart (confirming the cart emptied afterward), 15% abandons it via `deleteCart`. Injected in
  `setUp` **alongside**, not instead of, the pre-existing "Buyer journey" (orders straight from
  the catalogue, no cart) — ordering without a cart is still a supported path, so both stay under
  load.
- Two `details()` assertions budget the two cart requests independently: `GET /v1/cart` <
  3000ms (p3), `PUT /v1/cart` < 5000ms (p3).

> [!info] `GET /v1/cart` is the load-shape change the cart introduces, and the one to watch
> Every cart read costs a live catalogue query (`WHERE Id IN (...)` re-pricing and
> re-checking availability for every line), and a real user reads their cart far more often
> than they write it — page loads, cart-badge refreshes. That is why the "Cart buyer journey"
> scenario reads the cart three times per iteration and why `GET /v1/cart` gets its own
> `details()` budget: the write (`PUT`) is a single insert/sync under a unique index and was
> already the kind of thing this suite budgets; the read is the genuinely new sustained-traffic
> pattern the cart adds to Orders. A future reader adding cart traffic should not assume the
> write is the expensive path here — profile the read.

Verified (smoke profile): 551/551 OK. `DELETE /v1/cart` does not sample at smoke volume (only
15% of `cartBuyer` iterations take that branch) and was confirmed separately with a heavier probe.

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
5. If the route changes how users reach an existing flow (a new way to do something already
   possible, not just a new independent capability), add a load-test scenario in
   `e2e/load-tests/` — see Layer 4 above. The cart milestone shipped without this initially and
   it went undetected because nothing fails when a load scenario is simply missing; see
   [[testing]]'s "a new route is not done when the service serves it" checklist in the root
   `CLAUDE.md`.

## Related

- [[testing]]
- [[orders-service-design]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-16-orders-list-products-endpoint-design]]
- [[2026-08-25-cart-endpoints-design]] — the cart milestone whose four test layers (including
  the load-test scenario documented in Layer 4 above) satisfy this checklist.
