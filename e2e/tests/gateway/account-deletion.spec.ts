import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { pickProductWithStock } from "../../support/catalogue.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";

// Account deletion through the API GATEWAY with a real Cognito JWT: authorizer → njs
// sub-extraction → nginx → Users → the two cascade legs. The exhaustive cases live in
// the internal counterpart, `tests/account-deletion.spec.ts`. This layer exists for
// what neither of the other two can see: a route absent from the gateway's route map
// 404s here while working perfectly on port 3000.
// See [[2026-08-25-route-works-in-process-but-404s-at-gateway]]

type Credentials = ReturnType<typeof makeUser>;

interface Session {
  token: string;
  /** The internal `usr_` id from the register response. */
  userId: string;
}

// Registers a user through the gateway and logs them in. Not `auth.ts`'s
// `getGatewayToken()`, which returns only `{ token, email }`: this spec needs the
// PASSWORD (to log in again as the re-registered account) and the `usr_` id ("the new
// account is a different row" is asserted by comparing ids). Credentials come in as a
// parameter because the headline case registers the SAME email twice.
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
  const product = pickProductWithStock(await products.json());

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
  // CONTRACT: Pin 404 exactly; do NOT widen this to "401 or 404". The JWT stays
  // cryptographically valid, so the authorizer ADMITS it and Users finds no live row.
  // A 200 is the failure this guards; an authorizer that later rejects deleted subs
  // should force a deliberate edit here, not be absorbed by a disjunction.
  // See [[testing]]
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

  // CONTRACT: Do NOT add an API-level assertion that the old row survives with its
  // real email. A soft-deleted row is invisible to every read path by construction
  // (Prisma's global filter), so "preserved" and "erased outright" produce identical
  // API responses — such a test cannot fail and would read as coverage. Proving it
  // needs a direct Postgres connection this suite deliberately does not have.
  // KNOWN GAP: no layer asserts the deleted row keeps its real email; that belongs in
  // Users' integration suite, which already has a live Postgres.
  // See [[soft-delete]]
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

  // CONTRACT: Assert through the PUBLIC login route, not the deleted user's stale
  // token — an unexpired token says nothing about whether the identity survived. A 200
  // here means `AdminDeleteUser` never ran (or was an `AdminDisableUser`), leaving the
  // headline case's re-registration racing an orphan in the pool.
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

  // CONTRACT: Pin 200-and-empty; do NOT widen to "401 or 404 or empty". The token is
  // still cryptographically valid, so the authorizer admits it and Orders answers 200
  // — and an EMPTY scoped list is the correct answer for an identity owning nothing,
  // which is exactly what the cascade must guarantee. A disjunction wide enough to
  // accept whatever happens is not an assertion.
  const after = await api.get("v1/orders/my-orders");
  expect(after.status()).toBe(200);
  expect(await after.json()).toEqual([]);
});
