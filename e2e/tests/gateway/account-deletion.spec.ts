import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";

// Account deletion through the API GATEWAY with a real Cognito JWT: authorizer →
// njs sub-extraction → nginx → Users → the two cascade legs. The internal
// counterpart (direct service ports, faked `x-user-id`, exhaustive cases on the
// cascade routes) is `tests/account-deletion.spec.ts`.
//
// This layer exists because the other two cannot see gateway-only failures: a
// route absent from `infra/modules/api-gateway/main.tf`'s route map 404s here
// while working perfectly on port 3000, and `DELETE` on an existing path is
// exactly the shape of change that gets left out of a route map.

type Credentials = ReturnType<typeof makeUser>;

interface Session {
  token: string;
  /** The internal `usr_` id from the register response. */
  userId: string;
}

// Registers a user through the gateway and logs them in.
//
// Not `support/auth.ts`'s `getGatewayToken()`, which returns only `{ token, email }`
// — this spec needs (a) the PASSWORD, to log in again as the re-registered account,
// and (b) the `usr_` id, because "the new account is a different row" is asserted by
// comparing ids. Same shape as `tracking-flow.spec.ts`'s local `registerAndLogin`,
// which forked the helper for the same reason rather than widening a return type
// that 38 call sites depend on.
//
// Takes the credentials as a parameter instead of generating them, because the
// headline case must register the SAME email twice — which is the entire feature.
async function registerAndLogin(user: Credentials): Promise<Session> {
  const rawBaseURL = process.env.API_GATEWAY_URL;
  if (!rawBaseURL) throw new Error("API_GATEWAY_URL is not set — run `make bootstrap`.");
  // Trailing-slash baseURL + relative request paths, same rule as gateway-client.ts:
  // a leading slash would replace the gateway's whole path and land on Floci's root.
  const baseURL = rawBaseURL.endsWith("/") ? rawBaseURL : `${rawBaseURL}/`;
  const ctx = await request.newContext({
    baseURL,
    extraHTTPHeaders: { "X-E2E-Source": "true" },
  });

  const reg = await ctx.post("v1/users/register", { data: user });
  expect(reg.status(), `register failed: ${await reg.text()}`).toBe(201);
  const registered = await reg.json();
  expect(registered.id).toMatch(/^usr_/);

  const login = await ctx.post("v1/users/login", {
    data: { email: user.email, password: user.password },
  });
  expect(login.status(), `login failed: ${await login.text()}`).toBe(200);
  const body = await login.json();
  const token = body.accessToken ?? body.idToken;
  expect(token, `login returned no token: ${JSON.stringify(body)}`).toBeTruthy();

  await ctx.dispose();
  return { token, userId: registered.id as string };
}

async function placeOrder(api: APIRequestContext): Promise<string> {
  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const product = (await products.json()).find(
    (p: { unitsInStock: number }) => p.unitsInStock > 0,
  );
  expect(product, "the seed catalog has no in-stock product").toBeTruthy();

  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);
  return order.id as string;
}

// ## The load-bearing case
//
// Everything else in this file is a guard around this one journey. It is the only
// place where the feature's headline promise — deleting an account FREES ITS EMAIL
// — is actually exercised end to end, against the real partial unique index, the
// real Cognito pool, and the real gateway.
test("a deleted account releases its email, and re-registering it yields a clean new account", async () => {
  const credentials = makeUser();
  const first = await registerAndLogin(credentials);
  const api = await gatewayClient(first.token);

  // 1 — the account exists and owns data on both downstream services.
  const me = await api.get("v1/users/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).id).toBe(first.userId);

  const orderId = await placeOrder(api);

  // Tracking is created by Orders calling `init-tracking` during order creation,
  // so it exists by the time the 201 came back — no polling needed. Asserted
  // rather than assumed: if this were empty, the cascade's tracking leg would be
  // deleting nothing and the assertion after the deletion would be vacuous.
  const trackingBefore = await api.get(`v1/trackings?order_ids=${orderId}`);
  expect(trackingBefore.status()).toBe(200);
  expect((await trackingBefore.json()).trackings).toHaveLength(1);

  // 2 — the deletion itself, through the gateway, with the real JWT.
  const deleted = await api.delete("v1/users/me");
  expect(deleted.status(), `delete failed: ${await deleted.text()}`).toBe(204);

  // 3 — the old token no longer reaches a live account.
  //
  // Observed to be 404, not 401, and the distinction is worth pinning: the JWT is
  // still cryptographically valid for the rest of its lifetime, so the authorizer
  // ADMITS it and the request reaches Users, which finds no live row. The task
  // brief allowed "401 or 404"; the real behaviour is deterministic, so it is
  // asserted exactly. A 200 is the failure this guards, and a future change that
  // made the authorizer reject deleted subs would flip this to 401 — which should
  // be a deliberate edit here, not silently absorbed by a disjunction.
  const meAfter = await api.get("v1/users/me");
  expect(meAfter.status(), `old token returned ${await meAfter.text()}`).toBe(404);

  // 4 — THE POINT: the same email registers again.
  //
  // This is what the partial unique index (`WHERE deleted_at IS NULL`) and the
  // Cognito `AdminDeleteUser` exist for. A 409 here means the address stayed
  // burned; the old row is preserved, so a plain `@unique` or a skipped Cognito
  // delete would both surface exactly here and nowhere else.
  const second = await registerAndLogin(credentials);
  const reborn = await gatewayClient(second.token);

  // A DIFFERENT row, not the old one resurrected. Soft delete means the old row
  // still exists; if re-registration had somehow revived it (an upsert, a cleared
  // `deleted_at`), the ids would match and the "clean account" assertions below
  // would pass while the user silently inherited their deleted past.
  expect(second.userId).not.toBe(first.userId);

  const meReborn = await reborn.get("v1/users/me");
  expect(meReborn.status()).toBe(200);
  const rebornBody = await meReborn.json();
  expect(rebornBody.id).toBe(second.userId);
  expect(rebornBody.email).toBe(credentials.email);
  expect(rebornBody.deletedAt).toBeNull();

  // 5 — the new account starts empty. The cascade swept the old orders AND the
  // new identity does not resolve to them.
  const orders = await reborn.get("v1/orders/my-orders");
  expect(orders.status()).toBe(200);
  expect(await orders.json()).toEqual([]);

  const trackings = await reborn.get(`v1/trackings?order_ids=${orderId}`);
  expect(trackings.status()).toBe(200);
  expect((await trackings.json()).trackings).toEqual([]);

  // ## LIMITATION — the preserved-row assertion is NOT made here, deliberately
  //
  // The spec (Task 9, step 3) also asks that the OLD row still be in Postgres with
  // `deleted_at` stamped and its REAL email intact — no tombstoning. That cannot be
  // asserted through the API, and the reason is structural rather than an oversight:
  // a soft-deleted row is invisible to every read path BY CONSTRUCTION (Prisma's
  // global filter), so "preserved with its real email" and "erased outright" produce
  // byte-identical API responses. An API-only assertion here would be a test that
  // cannot fail — worse than no test, because it would read as coverage.
  //
  // Asserting it properly needs a direct Postgres connection, and this suite has
  // NONE — no `pg` dependency, no DSN, no precedent (`support/` reaches only HTTP,
  // WebSocket and OpenObserve). Adding a database client to the E2E suite for one
  // assertion is a new dependency and a new failure mode, and was explicitly ruled
  // out of this task.
  //
  // What IS proven above, and is the strongest the API can give: the new account
  // exists, is a DIFFERENT row from the old one (`second.userId !== first.userId`),
  // carries the same email, and owns nothing. The old row's existence is implied —
  // if it had been hard-deleted, the ids could not be compared and, more to the
  // point, ADR-0004 forbids the SQL `DELETE` that would do it (the write user holds
  // no `DELETE` grant), which is enforced at the service layer with its own unit
  // tests.
  //
  // The gap is real and named: **no test in any layer asserts that the deleted row
  // keeps its real email.** Closing it belongs in Users' own integration suite,
  // which already has a live Postgres, not here.
});

test("DELETE v1/users/me without a Bearer token is 401 at the gateway", async () => {
  const api = await gatewayClient(); // no token

  // The route-map assertion. A 401 is the GOOD answer: it proves
  // `DELETE /v1/users/me` resolved in the gateway's route map and reached the JWT
  // authorizer. A 404 carrying the gateway's own `{"message":"Not Found"}` — as
  // opposed to the service's `{error: …}` shape — would mean the request never
  // reached Users at all, which is the exact failure this layer exists to catch.
  const res = await api.delete("v1/users/me");
  expect(res.status()).toBe(401);
});

test("the deleted account's credentials no longer authenticate", async () => {
  const credentials = makeUser();
  const session = await registerAndLogin(credentials);

  const api = await gatewayClient(session.token);
  expect((await api.delete("v1/users/me")).status()).toBe(204);

  // Login is the surface a returning user actually hits, and it must fail — the
  // Cognito account is gone, which is what freed the email. A 200 here would mean
  // `AdminDeleteUser` never ran (or was an `AdminDisableUser`), and the
  // re-registration in the headline case would then be racing an orphan in the
  // pool. Asserted through the PUBLIC login route rather than the deleted user's
  // stale token, because a token that has not expired yet says nothing about
  // whether the identity behind it survived.
  const rawBaseURL = process.env.API_GATEWAY_URL!;
  const baseURL = rawBaseURL.endsWith("/") ? rawBaseURL : `${rawBaseURL}/`;
  const anon = await request.newContext({ baseURL });
  const login = await anon.post("v1/users/login", {
    data: { email: credentials.email, password: credentials.password },
  });
  expect(login.status()).toBe(401);
  expect(await login.json()).toEqual({ error: "invalid_credentials" });
  await anon.dispose();
});

test("a deleted user's stale token reaches Orders but owns nothing", async () => {
  const first = await registerAndLogin(makeUser());
  const api = await gatewayClient(first.token);

  const orderId = await placeOrder(api);
  const before = await api.get("v1/orders/my-orders");
  expect((await before.json()).map((o: { id: string }) => o.id)).toContain(orderId);

  expect((await api.delete("v1/users/me")).status()).toBe(204);

  // The token is still cryptographically valid for its remaining lifetime, so the
  // authorizer lets it through and Orders answers 200 — verified live, 2026-08-26.
  // That is not a hole: `my-orders` is a scoped list, and an EMPTY list is the
  // complete and correct answer for an identity that owns nothing. What the
  // cascade must guarantee is precisely this — the rows are gone, so a stale
  // credential is worth nothing even while it still parses.
  //
  // Pinned to 200-and-empty rather than "401 or 404 or empty": a disjunction wide
  // enough to accept whatever happens is not an assertion, and this behaviour was
  // observed, not guessed.
  const after = await api.get("v1/orders/my-orders");
  expect(after.status()).toBe(200);
  expect(await after.json()).toEqual([]);
});
