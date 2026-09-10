---
title: "Web Gateway Integration Milestone"
type: plan
area: shared
status: active
created: 2026-09-04
updated: 2026-09-10
tags:
  - type/plan
  - area/shared
  - status/active
  - milestone/web-gateway-integration
  - issue/JE-237
  - issue/JE-238
  - issue/JE-239
  - issue/JE-240
  - issue/JE-241
  - issue/JE-242
  - issue/JE-243
  - issue/JE-244
  - issue/JE-245
  - issue/JE-246
related:
  - "[[milestone-plan]]"
  - "[[linear-references]]"
  - "[[phase-c-review-flow]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[web-app-foundation-milestone]]"
  - "[[testing]]"
  - "[[angular-component-authoring]]"
  - "[[env-files]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[2026-09-07-dev-form-autofill]]"
  - "[[2026-09-10-formfield-owns-its-control-bindings-ng8022]]"
  - "[[2026-09-10-formfield-reads-the-raw-dom-value]]"
  - "[[2026-09-10-signal-forms-required-accepts-whitespace]]"
---

# Web Gateway Integration Milestone

Logical execution plan for the **Web Gateway Integration** milestone: task sequence, phases,
and the blocking dependency graph. The detailed design lives in
[[2026-09-04-web-gateway-integration-design]] (superpowers spec). This note is the
milestone-level map, per [[milestone-plan]].

> [!success] Milestone complete — merged into `main`
> The nine planned issues (JE-237 through JE-245) are delivered, and the branch grew well beyond
> them before it closed: 113 commits reached `main` through
> [PR #77](https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/pull/77)
> (`feature/web-gateway-integration` → `main`), squash commit
> [`a529dac`](https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/commit/a529daccc242fc241ee2b155ecf90554b9c5df72),
> merged 2026-09-10. The branch was cut from `feature/web-app-foundation`, whose own
> [PR #76](https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/pull/76)
> merged on 2026-09-05; PR #77 opened against `main` on 2026-09-08. Both branches are deleted. The
> **What the branch delivered beyond the plan** section below records the extra scope; the
> per-issue tables describe the plan, not the final commit history. See [[linear-references]] —
> the vault references Linear via tags and links, it never mirrors issue status.

**Goal:** replace phase 1's 100%-fixture `apps/web/` with real API Gateway calls: a same-origin
nginx/`ng serve` proxy (not CORS), an encrypted-IndexedDB token store, a deduped refresh
interceptor, route guards, and a server-backed cart — without redesigning any of the 18 screens
phase 1 laid out.

## Logical phases

| Block | Issues | Description |
|---|---|---|
| Block 1 — Independent foundations | JE-237, JE-238, JE-239 | Gateway proxy wiring (nginx + `ng serve` + `NG_APP_API_GATEWAY_URL` + `make env-file`), the `core/api/types.ts` move plus `CartDto`/`Money`, and the encrypted IndexedDB token store. Independent of each other. |
| Block 2 — Sequential auth chain | JE-240 → JE-241 → JE-242 + JE-243 | HTTP client + auth interceptor, then the session store + deduped refresh interceptor, then route guards/boot rehydration and the auth screens wired to Users (JE-242, JE-243 both build on JE-241 and can run in parallel once it lands). |
| Block 3 — Data surfaces | JE-244 → JE-245 | Catalogue/orders/profile wired with fixtures deleted, then the real server-backed cart and checkout. |

## Task sequence

| # | Issue | Task | Deliverable | Spec note |
|---|---|---|---|---|
| 1 | [JE-237](https://linear.app/je-martinez/issue/JE-237) | nginx + `ng serve` proxy wiring | `apps/web/nginx.conf` as an envsubst template, `apps/web/proxy.conf.mjs` (gitignored, originally JSON — converted to an ES module 2026-09-07) + `apps/web/proxy.conf.example.mjs` (committed contract), `NG_APP_API_GATEWAY_URL`, `make env-file` wiring | [[2026-09-04-web-gateway-integration-design]] |
| 2 | [JE-238](https://linear.app/je-martinez/issue/JE-238) | `core/api/types.ts` move + extension | `fixtures/api-types.ts` moved to `core/api/types.ts`, extended with `CartDto`, `CartLineDto`, `Money` | [[2026-09-04-web-gateway-integration-design]] |
| 3 | [JE-239](https://linear.app/je-martinez/issue/JE-239) | Encrypted token store | `core/auth/token-store.ts` — AES-GCM with a non-extractable `CryptoKey` in IndexedDB | [[2026-09-04-web-gateway-integration-design]] |
| 4 | [JE-240](https://linear.app/je-martinez/issue/JE-240) | HTTP client + auth interceptor | `core/http/api-client.ts`, `core/auth/auth-interceptor.ts` — needs 1, 2 | [[2026-09-04-web-gateway-integration-design]] |
| 5 | [JE-241](https://linear.app/je-martinez/issue/JE-241) | Session store + refresh interceptor | `core/auth/session-store.ts`, `core/auth/refresh-interceptor.ts` sharing one in-flight refresh across concurrent 401s — needs 3, 4 | [[2026-09-04-web-gateway-integration-design]] |
| 6 | [JE-242](https://linear.app/je-martinez/issue/JE-242) | Route guards + boot rehydration | `core/auth/guards.ts` (`authGuard`, `guestGuard`), async rehydration awaited before a route decision — needs 5 | [[2026-09-04-web-gateway-integration-design]] |
| 7 | [JE-243](https://linear.app/je-martinez/issue/JE-243) | Auth screens wired to Users | Password, OTP, and reset screens calling the real Users API — needs 5 | [[2026-09-04-web-gateway-integration-design]] |
| 8 | [JE-244](https://linear.app/je-martinez/issue/JE-244) | Catalogue, orders, profile wired; fixtures deleted | `core/api/*.ts` domain services; `catalogue.fixture.ts`, `orders.fixture.ts`, `user.fixture.ts` deleted (`notifications.fixture.ts` stays, marked `CONTRACT:`) — needs 4, 6 | [[2026-09-04-web-gateway-integration-design]] |
| 9 | [JE-245](https://linear.app/je-martinez/issue/JE-245) | Real cart and checkout | `GET`/`PUT`/`DELETE /v1/cart` wired into `cart-drawer.ts`, serialized mutations — needs 8 | [[2026-09-04-web-gateway-integration-design]] |

Issues 1–3 (JE-237, JE-238, JE-239) are independent and parallelizable; from JE-240 onward the
chain is sequential, with JE-242 and JE-243 branching in parallel off JE-241.

## Dependencies

### Dependency table

| Task | Blocked by |
|---|---|
| JE-237 | — |
| JE-238 | — |
| JE-239 | — |
| JE-240 | JE-237, JE-238 |
| JE-241 | JE-239, JE-240 |
| JE-242 | JE-241 |
| JE-243 | JE-241 |
| JE-244 | JE-240, JE-242 |
| JE-245 | JE-244 |

### Dependency diagram

```mermaid
flowchart TD
    subgraph Block1["Block 1 — Independent foundations"]
        F1["JE-237 / nginx + ng serve proxy"]
        F2["JE-238 / core/api/types.ts move"]
        F3["JE-239 / encrypted token store"]
    end

    subgraph Block2["Block 2 — Sequential auth chain"]
        A1["JE-240 / HTTP client + auth interceptor"]
        A2["JE-241 / session store + refresh interceptor"]
        A3["JE-242 / route guards + boot rehydration"]
        A4["JE-243 / auth screens wired to Users"]
    end

    subgraph Block3["Block 3 — Data surfaces"]
        D1["JE-244 / catalogue, orders, profile wired"]
        D2["JE-245 / real cart and checkout"]
    end

    F1 --> A1
    F2 --> A1
    F3 --> A2
    A1 --> A2
    A2 --> A3
    A2 --> A4
    A1 --> D1
    A3 --> D1
    D1 --> D2
```

Block 1's three issues are independent groundwork: the gateway proxy (JE-237), the type move
(JE-238), and the encrypted token store (JE-239) can run in any order relative to each other.
Block 2 is a sequential chain — the HTTP client (JE-240) needs the proxy and the types; the
session store and refresh interceptor (JE-241) need both the token store and the HTTP client;
route guards (JE-242) and the auth screens (JE-243) both build on the session store and can
proceed in parallel once JE-241 lands. Block 3 needs the HTTP client and the guards before
wiring the remaining screens (JE-244), and the real cart (JE-245) is the last issue, needing
JE-244's wired API services.

## Stop points (batch review)

Per [[phase-c-review-flow]], this milestone has two stop points, matching the block boundaries:

1. **Block 1 → Block 2.** The proxy wiring, the type move, and the token store are the
   foundation every later issue builds on — JE-240 cannot start meaningfully until all three
   land.
2. **Block 2 → Block 3.** JE-242 and JE-243 both depend on JE-241's session store and refresh
   interceptor; once both land, they are batched for review together before Block 3's screens
   and cart wiring proceed.

## What each issue delivered

- **JE-237** — resolved the `$default` literal trap in `proxy_pass` (percent-encoded as
  `%24default`; every other escape attempt fails against a real nginx), the resolver pattern for
  per-request Docker DNS, and the container-vs-host Floci address split.
- **JE-238** — `core/api/types.ts` now carries `CartDto`, `CartLineDto`, and `Money`
  (`{cents, amount, formatted, currency}`), read directly per [[money-representation]] rather
  than re-rounded client-side.
- **JE-239** — the `CryptoKey` is generated `extractable: false` and stored in IndexedDB; key
  bytes are never readable from JS, blocking storage scraping and devtools dumps (not an active
  XSS calling `decrypt()` in-page — no SPA design stops that).
- **JE-240** — `provideHttpClient(withInterceptors(...))` plus a typed `ApiError`; the auth
  interceptor skips public routes (`login`, `register`, `refresh`, `otp/*`, `password/forgot`,
  `password/confirm`).
- **JE-241** — the refresh interceptor shares one in-flight refresh across concurrent 401s
  (`shareReplay`); `/v1/users/refresh` returns only `idToken` + `accessToken` and does not
  rotate the refresh token.
- **JE-242** — `authGuard` awaits IndexedDB rehydration before deciding; `guestGuard` bounces an
  authenticated user away from `/login`.
- **JE-243** — password, OTP, and reset screens now call the real Users endpoints.
- **JE-244** — catalogue, orders, and profile screens wired to their real APIs;
  `catalogue.fixture.ts`, `orders.fixture.ts`, `user.fixture.ts` deleted.
- **JE-245** — `cart-drawer.ts` is server-backed (`GET`/`PUT`/`DELETE /v1/cart`); mutations are
  serialized in the store since `PUT` replaces the whole cart.

## What the branch delivered beyond the plan

The nine issues above describe the milestone as planned. The branch that shipped it carries 113
commits, so a large part of `main`'s current web app is not traceable to any of them. Rather
than invent issue IDs, this section names the extra scope as it appears in the merged history:

- **Signal Forms migration.** Every form in `apps/web/` is expressed as a Signal Forms schema,
  on Angular 22 (Angular, NgRx, the builder, and eslint moved together). Three traps this
  surfaced are recorded as lessons — [[2026-09-10-formfield-owns-its-control-bindings-ng8022]],
  [[2026-09-10-formfield-reads-the-raw-dom-value]], and
  [[2026-09-10-signal-forms-required-accepts-whitespace]].
- **Address autocomplete.** A same-origin Geoapify geocoding proxy
  ([[2026-09-06-address-geocoding-proxy-design]]) backs a street autocomplete on both the
  checkout and profile address forms, with one input per address field and no invented country.
- **A readable order number.** Orders gives every order a number a customer can read aloud, and
  snapshots the product name and image onto each order line so history survives catalogue edits.
- **Real sign-out.** Users revokes the caller's Cognito session on sign-out, and the web app's
  Sign out actually ends the session rather than only clearing local state.
- **Checkout and cart hardening.** The stepper is driven from real state with cart writes
  coalesced into one debounced call, order placement moved from the cart drawer to checkout, and
  the card form matches what Stripe accepts.
- **Dev-only form autofill**, whose three constraints are recorded in
  [[2026-09-07-dev-form-autofill]].
- **Repo-wide comment-convention enforcement** extended to Angular templates, with the gate wired
  into every agent.

## Verification totals

Measured at the point the nine planned issues completed, before the extra scope above landed —
these are the plan's numbers, not the branch's final ones.

- **175 Vitest** unit tests (refresh interceptor including the concurrent case, encrypted token
  store, guards, and the rest of the new `core/` surface).
- **16 Playwright E2E specs** in `e2e/tests/web/` (real login through the gateway, session
  surviving a reload, eviction on expiry), **32 runs under `--repeat-each=2`, zero flakes**.
- Typecheck, lint, and build all clean.
- Vault validator green.

## Outcome

> [!success] Merged into `main` on 2026-09-10
> The whole branch is in `main` via
> [PR #77](https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/pull/77),
> squash commit
> [`a529dac`](https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/commit/a529daccc242fc241ee2b155ecf90554b9c5df72)
> — 688 files, +47,170/−24,861. `apps/web/` runs entirely against the API Gateway; the phase-1
> fixtures it replaced are gone.

> [!info] JE-246 is a backend bug, not part of this branch
> A backend defect found during implementation belongs to **JE-246** rather than to this
> milestone — the scope here is the web app, not the services it calls. JE-246 is tracked
> independently in Linear per [[linear-references]].

## Related

- [[milestone-plan]] — convention this plan follows.
- [[linear-references]] — Linear reference convention.
- [[phase-c-review-flow]] — batch-review flow and dependency-gate stop points referenced above.
- [[2026-09-04-web-gateway-integration-design]] — the design spec specifying each deliverable.
- [[web-app-foundation-milestone]] — the phase-1 milestone this one continues, and the branch
  it was cut from.
- [[testing]] — the three-layer testing convention adapted for the web app's Vitest + gateway
  Playwright specs.
- [[angular-component-authoring]] — component conventions the new `core/` code follows.
- [[env-files]] — `.env.local.web` and `apps/web/proxy.conf.mjs` generation this milestone
  established (the proxy started as JSON, converted to an ES module 2026-09-07 by
  [[2026-09-06-address-geocoding-proxy-design]]).
- [[2026-09-06-address-geocoding-proxy-design]] — converted this milestone's `ng serve` proxy
  from JSON to an ES module to serve `/geocode/` alongside `/v1`.
- [[2026-09-07-dev-form-autofill]] — the three constraints behind the dev-only autofill.
- [[2026-09-10-formfield-owns-its-control-bindings-ng8022]],
  [[2026-09-10-formfield-reads-the-raw-dom-value]],
  [[2026-09-10-signal-forms-required-accepts-whitespace]] — the Signal Forms traps the migration
  surfaced.
