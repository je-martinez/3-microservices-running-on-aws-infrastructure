# Three-Layer Testing Convention + E2E-Gateway Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document a three-layer testing convention (unit / internal-E2E / gateway-E2E-with-real-JWT) and expand the Playwright `e2e/` package with a new "gateway" scenario that hits `API_GATEWAY_URL` with a real Cognito JWT, covering all current users + orders endpoints.

**Architecture:** Keep the existing internal E2E suite untouched; add a second Playwright project ("gateway") that acquires a JWT via a register→login helper (dedicated, marked, auto-cleaned E2E user) and drives every endpoint through the gateway. Document the convention in four places (vault convention, per-service CLAUDE.md GOLDEN-RULE sections, root CLAUDE.md, per-service testing docs).

**Tech Stack:** Playwright (`@3mrai/e2e`), Node, Cognito-via-Floci token flow, the API gateway (`API_GATEWAY_URL` from `.env`).

## Global Constraints

- **Expand, do NOT replace:** the existing internal project (baseURL `http://localhost:3000`, `x-user-id` faked) stays. The gateway project is added alongside.
- **Read env at runtime:** `API_GATEWAY_URL` (and Cognito IDs) change on every `make bootstrap` — never hardcode; read from `process.env` (populated from `.env`).
- **Dedicated E2E user:** the gateway auth helper creates a marked user via the existing `makeUser()` (`e2e+<unique>@example.com`) + `X-E2E-Source` header, and it's cleaned up via the existing `DELETE /v1/users/e2e-cleanup` teardown. No random real users, no magic seeded user.
- **Token type:** the login returns `idToken`/`accessToken`. Verified live that the **accessToken** passes the gateway JWT authorizer (its `sub` is what njs forwards). Confirm during implementation which the Floci authorizer accepts and pin it in the helper.
- **Docs are the source of truth:** the vault convention (`docs/shared/conventions/testing.md`) is authoritative; CLAUDE.md sections reference it via `[[testing]]`.
- **Stack dependency:** gateway E2E needs `make bootstrap` up; `global-setup` must fail fast with an actionable message. No CI runs this (out of scope).
- **Node:** `nvm use` before pnpm/node. `e2e/` imports use `.js` extensions in TS imports (ESM — see existing specs).
- **Git:** main session commits per task (commit-only, no push); implementers write code/docs only. Conventional Commits; docs → scope `vault`/`shared`, harness → scope `e2e`.
- **Vault writes go through the obsidian-vault agent** (the convention doc + per-service testing docs + index), per repo policy.

---

### Task 1: The testing convention doc (vault) + index

**Files (via obsidian-vault agent):**
- Create: `docs/shared/conventions/testing.md`
- Modify: `docs/00-overview/index.md` (index under Conventions)

**Interfaces:**
- Produces: the `[[testing]]` note that the CLAUDE.md sections (Task 2) link to.

- [ ] **Step 1: Draft the convention content**

The convention states the three layers required per endpoint (unit/integration; internal E2E via direct service URL with `x-user-id`; gateway E2E via `API_GATEWAY_URL` + real Bearer JWT). Use the convention template (`docs/templates/convention-template.md`): frontmatter (`title: Testing`, `type: convention`, `area: shared`, `status: active`, dates, folder-style tags, `related`), then `# Testing / ## Rule / ## Rationale / ## Related`. The Rule section: an imperative — "Every HTTP endpoint MUST have all three layers; an endpoint missing gateway E2E is an incomplete change." The Rationale: cite the three gateway-only bugs this session (products 404, {orderId} 405, regex 500) that in-process/internal tests missed. `## Related`: `[[ADR-0010-cognito-auth]]`, `[[ADR-0016-local-apigw-nginx-ecs]]`, `[[local-dev]]`, and the design spec `[[2026-07-17-testing-layers-and-e2e-gateway-design]]`.

- [ ] **Step 2: Dispatch obsidian-vault to create + index + validate**

The main session dispatches the `obsidian-vault` agent with the content to: create `docs/shared/conventions/testing.md`, index it in `docs/00-overview/index.md` under `## Conventions` (matching the existing wikilink+description pattern), and run `nvm use && node scripts/validate-vault.mjs`. Expected: `Vault validation passed`.

- [ ] **Step 3: Commit** (main session)

Staged: `docs/shared/conventions/testing.md`, `docs/00-overview/index.md`.
Message: `docs(vault): add the three-layer testing convention`

---

### Task 2: GOLDEN-RULE sections in the CLAUDE.md files (root + orders + users)

**Files:**
- Modify: `CLAUDE.md` (root — a one-line global rule under Working rules)
- Modify: `services/orders/CLAUDE.md` (a GOLDEN-RULE-style testing section)
- Modify: `services/users/CLAUDE.md` (same)

**Interfaces:**
- Consumes: the `[[testing]]` convention (Task 1).

- [ ] **Step 1: Root CLAUDE.md — global rule**

Under the "Working rules" / Scope area, add a short rule: every new/changed HTTP endpoint requires the three test layers (unit, internal E2E, gateway E2E with a real JWT); reference the convention. One or two sentences — the root file is terse.

- [ ] **Step 2: services/orders/CLAUDE.md — GOLDEN-RULE section**

Add a section modeled on the existing `## 2a. GOLDEN RULE — keep openapi.yaml in sync` (bold imperative + consequence). Content: "Every Orders HTTP endpoint MUST have (1) xUnit/Testcontainers coverage, (2) internal E2E, and (3) gateway E2E with a real JWT (the URL the user hits). An endpoint without gateway E2E is an incomplete change." Note WHERE gateway specs live (`e2e/tests/gateway/`) and how to run them (`pnpm --filter @3mrai/e2e test`). Link `[[testing]]`.

- [ ] **Step 3: services/users/CLAUDE.md — GOLDEN-RULE section**

Same as Step 2, adapted to users (vitest for layer 1). Link `[[testing]]`.

- [ ] **Step 4: Verify the CLAUDE.md edits are coherent**

Run: `grep -n "gateway E2E\|three.layer\|\[\[testing\]\]" CLAUDE.md services/orders/CLAUDE.md services/users/CLAUDE.md`
Expected: the rule appears in all three, referencing the convention.

- [ ] **Step 5: Commit** (main session)

Staged: the three CLAUDE.md files.
Message: `docs(agents): require three-layer endpoint testing in root + service CLAUDE.md`

---

### Task 3: Gateway harness support — auth helper + gateway client + two-project config

**Files:**
- Create: `e2e/support/auth.ts`
- Create: `e2e/support/gateway-client.ts`
- Modify: `e2e/playwright.config.ts` (two projects: internal + gateway)
- Modify: `e2e/support/global-setup.ts` (also health-check the gateway)
- Modify: `e2e/support/api-client.ts` (correct the obsolete "gateway drops the path" comment)

**Interfaces:**
- Produces:
  - `getGatewayToken(): Promise<string>` in `auth.ts` — registers + logs in a marked E2E user through the gateway, returns the Bearer token.
  - `gatewayClient(token?: string): Promise<APIRequestContext>` in `gateway-client.ts` — baseURL `API_GATEWAY_URL`, attaches `Authorization: Bearer <token>` when given.

- [ ] **Step 1: Write `gateway-client.ts`**

```ts
import { request, type APIRequestContext } from "@playwright/test";

// Drives requests through the API gateway — the URL the end user hits. Unlike
// api-client.ts (direct service + faked x-user-id), this exercises the JWT
// authorizer → njs sub-extraction → nginx routing → service, end to end.
export async function gatewayClient(token?: string): Promise<APIRequestContext> {
  const baseURL = process.env.API_GATEWAY_URL;
  if (!baseURL) {
    throw new Error("API_GATEWAY_URL is not set — run `make bootstrap` (it writes .env), then re-run.");
  }
  return request.newContext({
    baseURL,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
```

- [ ] **Step 2: Write `auth.ts` (register→login→token via the gateway)**

```ts
import { request } from "@playwright/test";
import { makeUser } from "./chance-factory.js";

// Creates a dedicated, marked E2E user through the gateway (register + login on
// the public auth routes) and returns the token to use as a Bearer. The user is
// cleaned up by the existing e2e-cleanup teardown. Verified live that the access
// token passes the Floci JWT authorizer (its `sub` is forwarded as x-user-id).
export async function getGatewayToken(): Promise<{ token: string; email: string }> {
  const baseURL = process.env.API_GATEWAY_URL;
  if (!baseURL) throw new Error("API_GATEWAY_URL is not set — run `make bootstrap`.");
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
  const user = makeUser();
  const reg = await ctx.post("/v1/users/register", { data: user });
  if (reg.status() !== 201) throw new Error(`register via gateway failed: ${reg.status()} ${await reg.text()}`);
  const login = await ctx.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  if (login.status() !== 200) throw new Error(`login via gateway failed: ${login.status()} ${await login.text()}`);
  const body = await login.json();
  const token = body.accessToken ?? body.idToken;
  if (!token) throw new Error(`login returned no token: ${JSON.stringify(body)}`);
  await ctx.dispose();
  return { token, email: user.email };
}
```
IMPLEMENTATION NOTE: confirm which token the authorizer accepts by hitting one protected gateway route (e.g. `GET /v1/users/me`) with `accessToken` and, if it 401s, `idToken` — pin whichever returns 200. Document the choice in a comment.

- [ ] **Step 3: Two-project `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  reporter: "list",
  projects: [
    {
      name: "internal",
      testDir: "./tests",
      testIgnore: "**/gateway/**",
      use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
    },
    {
      name: "gateway",
      testDir: "./tests/gateway",
      use: { baseURL: process.env.API_GATEWAY_URL },
    },
  ],
});
```
NOTE: keep the existing internal specs running exactly as before (the "internal" project uses the same testDir/baseURL). The gateway project points at `tests/gateway/`. Verify the internal `users.spec.ts` still runs under the "internal" project after this change.

- [ ] **Step 4: Extend `global-setup.ts` to health-check the gateway too**

Add, after the existing service health check, a gateway health check against a PUBLIC gateway route (`${process.env.API_GATEWAY_URL}/v1/orders/health` or `/v1/users/health`) with the same fail-fast + actionable message. If `API_GATEWAY_URL` is unset, throw the "run `make bootstrap`" error. Keep the existing service check.

- [ ] **Step 5: Correct the obsolete comment in `api-client.ts`**

Replace the comment claiming "The API Gateway (Floci) does not forward the request path" with an accurate one: the internal client drives the service directly to test it in isolation; the gateway path IS exercised by the gateway project (`gateway-client.ts`) — Floci does forward the path when the integration URI carries the route param (see the {orderId} fix). Do NOT change the function behavior.

- [ ] **Step 6: Run the internal suite to confirm no regression**

Run: `cd e2e && nvm use && pnpm test --project=internal` (requires the stack up via `make bootstrap`; if the stack isn't up, at least `npx playwright test --list` should show both projects and the internal tests unchanged).
Expected: the internal project's existing tests still pass (or list correctly if the stack is down — note which).

- [ ] **Step 7: Commit** (main session)

Staged: `auth.ts`, `gateway-client.ts`, `playwright.config.ts`, `global-setup.ts`, `api-client.ts`.
Message: `test(e2e): gateway harness — auth helper, gateway client, two-project config`

---

### Task 4: Phase-1 proof spec — the full flow through the gateway

**Files:**
- Create: `e2e/tests/gateway/orders-flow.spec.ts`

**Interfaces:**
- Consumes: `getGatewayToken` (Task 3), `gatewayClient` (Task 3).

- [ ] **Step 1: Write the end-to-end gateway proof spec**

Create `e2e/tests/gateway/orders-flow.spec.ts` covering the exact flow that broke this session, through the gateway with a real JWT:
```ts
import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";

test("through the gateway: auth, list products, create order, get it by id", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  // products route resolves through the gateway (was a 404 — missing gateway route)
  const products = await api.get("/v1/products");
  expect(products.status()).toBe(200);
  const list = await products.json();
  expect(Array.isArray(list)).toBe(true);
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  // create order (returns the full OrderDto)
  const created = await api.post("/v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);

  // get order by id — the {orderId} path param (was a 405: integration dropped the id)
  const fetched = await api.get(`/v1/orders/${order.id}`);
  expect(fetched.status()).toBe(200);
  expect((await fetched.json()).id).toBe(order.id);
});

test("through the gateway: protected route without a token is 401", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("/v1/orders/my-orders");
  expect(res.status()).toBe(401);
});
```

- [ ] **Step 2: Run the gateway project (stack must be up)**

Run: `cd e2e && nvm use && pnpm test --project=gateway` (requires `make bootstrap` up).
Expected: both tests pass — the create/get-by-id/products flow returns 200/201 through the gateway (proving the {orderId} 405 and products 404 are gone), and the no-token case is 401. If the stack is down, `npx playwright test --list --project=gateway` should show the spec.

- [ ] **Step 3: Commit** (main session)

Staged: `e2e/tests/gateway/orders-flow.spec.ts`.
Message: `test(e2e): gateway proof — auth→products→create→get-by-id + 401 path`

---

### Task 5: Phase-2 — full gateway coverage of all current endpoints

**Files:**
- Create: `e2e/tests/gateway/users.spec.ts`
- Create: `e2e/tests/gateway/orders.spec.ts`

**Interfaces:**
- Consumes: `getGatewayToken`, `gatewayClient`.

- [ ] **Step 1: `users.spec.ts` (gateway) — all users endpoints**

Cover through the gateway: public `POST /v1/users/register`, `/login`, `/refresh` (the helper already exercises register/login; add refresh: login → use refresh token → new tokens), `GET /v1/users/health` (200 no auth); protected `GET /v1/users/me` (200 with Bearer, 401 without) and `PATCH /v1/users/me` (200 with Bearer updates the profile). Use `getGatewayToken` for the authed cases. Assert route resolution + authorizer behavior + correct body.

- [ ] **Step 2: `orders.spec.ts` (gateway) — remaining orders endpoints**

Cover through the gateway (beyond the Task-4 flow): `GET /v1/orders/health` (200 no auth), `GET /v1/orders/my-orders` (200 with Bearer, lists the caller's orders; 401 without), `GET /v1/products` (200 with Bearer; 401 without — it's a protected route), and the error paths that are gateway-observable: `POST /v1/orders` with a nonexistent product → 404 `unknown_product`, and an over-stock quantity → 409 `insufficient_stock`. Assert method+route resolve (no 405/404-routing) and the correct status/body.

- [ ] **Step 2b: Assert methods that should NOT be allowed**

Add a check that a wrong method on a param route is handled correctly through the gateway — e.g. `POST /v1/orders/{id}` (not defined) behaves as expected (the gateway only declares `GET` there). This guards the class of bug where a route/method mismatch surfaces only at the gateway. Assert the actual gateway response (document what it returns).

- [ ] **Step 3: Run the full gateway project**

Run: `cd e2e && nvm use && pnpm test --project=gateway`
Expected: all gateway specs pass with the stack up. Confirm no cross-test data bleed (each authed spec uses its own E2E user via `getGatewayToken`).

- [ ] **Step 4: Run BOTH projects together**

Run: `cd e2e && pnpm test`
Expected: internal + gateway both green. Teardown (`e2e-cleanup`) leaves no residue.

- [ ] **Step 5: Commit** (main session)

Staged: `e2e/tests/gateway/users.spec.ts`, `e2e/tests/gateway/orders.spec.ts`.
Message: `test(e2e): full gateway coverage of users + orders endpoints`

---

### Task 6: Per-service testing docs (docs/domains/*/testing/)

**Files (via obsidian-vault agent):**
- Create: `docs/domains/orders/testing/index.md` (replacing the empty `.gitkeep` area)
- Create: `docs/domains/users/testing/index.md`

- [ ] **Step 1: Draft per-service testing guidance**

For each service: how to run each of the three layers (the exact commands — orders: `dotnet test`; users: `pnpm test`; both: `pnpm --filter @3mrai/e2e test` for internal+gateway), what the gateway harness does, the dedicated E2E user, and a short checklist for adding a new endpoint (all three layers + openapi + gateway route). Link `[[testing]]`.

- [ ] **Step 2: Dispatch obsidian-vault to create + index + validate**

Create both notes; index them where domain notes are indexed (or from the service's domain area / the testing convention's Related). Run the vault validator. Expected: `Vault validation passed`.

- [ ] **Step 3: Commit** (main session)

Staged: the two testing docs (+ any index edits).
Message: `docs(vault): per-service testing guidance for orders and users`

---

## Self-Review

**Spec coverage:**
- The convention (three layers, imperative) → Task 1 (vault) + Task 2 (CLAUDE.md ×3). ✓
- Documented in four places → Tasks 1, 2, 6 (vault convention, root+service CLAUDE.md, per-service testing docs). ✓
- Harness: gateway client + auth helper (dedicated E2E user) + two-project config + gateway health check + corrected comment → Task 3. ✓
- Token type confirmed live → Task 3 Step 2 note. ✓
- Phase 1 proof spec (the flow that broke) → Task 4. ✓
- Phase 2 full coverage of all current endpoints → Task 5. ✓
- Expand not replace (internal suite kept) → Global Constraints + Task 3 Steps 3/6. ✓
- Would catch this session's bugs → Task 4 (products/{orderId}) + Task 5 (method-mismatch). ✓
- Read env at runtime, stack-dependency fail-fast → Global Constraints + Task 3 Steps 1/2/4. ✓

**Placeholder scan:** No TBD/"handle edge cases". The "confirm which token the authorizer accepts" note is an explicit verify-then-pin instruction with a defined fallback (access → id), not a placeholder.

**Type/name consistency:** `getGatewayToken()` returns `{ token, email }` (Task 3) and is consumed in Tasks 4–5. `gatewayClient(token?)` consistent across Tasks 3–5. `[[testing]]` is the convention slug created in Task 1 and referenced in Tasks 2, 6. The two Playwright projects are named "internal"/"gateway" consistently (config Task 3, run commands Tasks 4–5).

**Risk sequencing:** the convention (Task 1) precedes the CLAUDE.md links to it (Task 2). The harness support (Task 3) precedes the specs that use it (Tasks 4–5). The proof spec (Task 4) de-risks before full coverage (Task 5). Vault writes are routed through obsidian-vault (Tasks 1, 6).

## Related

- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
- [[ADR-0010-cognito-auth]]
- [[local-dev]]
