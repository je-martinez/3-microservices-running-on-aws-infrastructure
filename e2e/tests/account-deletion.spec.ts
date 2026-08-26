import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiClient, ordersClient, trackingClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

// Account deletion, driven against the SERVICE PORTS directly (Users 3000,
// Orders 3001, Tracking 3002) with a faked `x-user-id` standing in for the
// authorizer's output. The gateway counterpart — real Cognito JWT, real
// authorizer, and the re-registration case that is the point of the whole
// feature — lives in `tests/gateway/account-deletion.spec.ts`.
//
// This file is the EXHAUSTIVE layer: it carries the cases that would make the
// gateway spec slow and noisy — the internal routes' key checks, their
// idempotency, and the empty-identity guard. That split is deliberate
// ([[testing]] §three layers): the gateway spec proves the URL a user hits
// resolves; this one proves the behaviour behind it.
//
// ## Why one identity value plays both `cognitoSub` and `userId` here
//
// The cascade routes take BOTH identities and match `cognito_sub OR user_id`.
// On the direct path there is no Cognito token, so a service records whatever
// `x-user-id` carried as its ownership key — here the `usr_` id returned by
// register (Users' gRPC `GetUserById` resolves a `usr_` id OR a Cognito sub,
// which is what makes that work; see `support/api-client.ts`). So passing the
// same `usr_` id in both fields is not a shortcut around the contract — it is
// the honest value of both fields for a user created this way. Verified live
// against the running stack, 2026-08-26.

const INTERNAL_KEY = process.env.GRPC_API_KEY;

// `.env.local.users` supplies it via playwright.config.ts. Failing here with the
// reason beats every internal-route case failing with an unexplained 401.
function internalKey(): string {
  if (!INTERNAL_KEY) {
    throw new Error(
      "GRPC_API_KEY is not set — run `make env-file` from the repo root so " +
        ".env.local.users exists, then re-run.",
    );
  }
  return INTERNAL_KEY;
}

interface Actor {
  /** The `usr_` id, used as `x-user-id` AND as both cascade identities. */
  id: string;
  email: string;
  /** The order this actor placed, which also produced a tracking. */
  orderId: string;
}

// Registers a user and gives them one order (which Orders' `init-tracking` call
// turns into a tracking row), so a deletion has something on both downstream
// services to actually remove. A user with no data cannot distinguish "the
// cascade ran" from "the cascade matched nothing".
async function makeActorWithData(
  users: APIRequestContext,
  orders: APIRequestContext,
): Promise<Actor> {
  const user = makeUser();
  const reg = await users.post("/v1/users/register", { data: user });
  expect(reg.status()).toBe(201);
  const { id } = await reg.json();

  const products = await orders.get("/v1/products", { headers: { "x-user-id": id } });
  expect(products.status()).toBe(200);
  const product = (await products.json()).find(
    (p: { unitsInStock: number }) => p.unitsInStock > 0,
  );
  expect(product, "the seed catalog has no in-stock product").toBeTruthy();

  const created = await orders.post("/v1/orders", {
    headers: { "x-user-id": id },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const orderId = (await created.json()).id as string;

  return { id, email: user.email, orderId };
}

async function trackingsFor(
  tracking: APIRequestContext,
  actor: Actor,
): Promise<Array<{ id: string }>> {
  const res = await tracking.get(`/v1/trackings?order_ids=${actor.orderId}`, {
    headers: { "x-user-id": actor.id },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).trackings;
}

async function orderIdsFor(orders: APIRequestContext, actor: Actor): Promise<string[]> {
  const res = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": actor.id } });
  expect(res.status()).toBe(200);
  return (await res.json()).map((o: { id: string }) => o.id);
}

test("DELETE /v1/users/me removes the account and cascades to orders and trackings", async () => {
  const users = await apiClient();
  const orders = await ordersClient();
  const tracking = await trackingClient();
  const actor = await makeActorWithData(users, orders);

  // Precondition, asserted rather than assumed: without it a cascade that ran
  // against an empty account would pass every assertion below.
  expect(await orderIdsFor(orders, actor)).toContain(actor.orderId);
  expect(await trackingsFor(tracking, actor)).toHaveLength(1);

  const deleted = await users.delete("/v1/users/me", { headers: { "x-user-id": actor.id } });
  expect(deleted.status()).toBe(204);

  // The account itself.
  const me = await users.get("/v1/users/me", { headers: { "x-user-id": actor.id } });
  expect(me.status()).toBe(404);

  // Orders — gone from the list read AND from the by-id read. Both, because they
  // are different query paths: the list filters by owner, the by-id read filters
  // by owner AND id, and a soft-delete predicate missing from one of them would
  // leave the row reachable through the other.
  expect(await orderIdsFor(orders, actor)).toEqual([]);
  const byId = await orders.get(`/v1/orders/${actor.orderId}`, {
    headers: { "x-user-id": actor.id },
  });
  expect(byId.status()).toBe(404);

  // Tracking — gone from the multi-id read and from the per-order read.
  expect(await trackingsFor(tracking, actor)).toEqual([]);
  const trackingById = await tracking.get(`/v1/trackings/${actor.orderId}`, {
    headers: { "x-user-id": actor.id },
  });
  expect(trackingById.status()).toBe(404);
});

test("DELETE /v1/users/me twice returns 204 then 404", async () => {
  const users = await apiClient();
  const user = makeUser();
  const reg = await users.post("/v1/users/register", { data: user });
  expect(reg.status()).toBe(201);
  const { id } = await reg.json();

  const first = await users.delete("/v1/users/me", { headers: { "x-user-id": id } });
  expect(first.status()).toBe(204);

  // 404, not 204: the second call resolves no live user, so there is nothing to
  // delete and saying "done" would be a lie about what happened.
  const second = await users.delete("/v1/users/me", { headers: { "x-user-id": id } });
  expect(second.status()).toBe(404);
  expect(await second.json()).toEqual({ error: "not_found" });
});

test("deleting one user leaves another user's orders and trackings untouched", async () => {
  const users = await apiClient();
  const orders = await ordersClient();
  const tracking = await trackingClient();

  const victim = await makeActorWithData(users, orders);
  const bystander = await makeActorWithData(users, orders);

  const deleted = await users.delete("/v1/users/me", { headers: { "x-user-id": victim.id } });
  expect(deleted.status()).toBe(204);

  // The blast-radius assertion. The cascade predicates are an OR over two
  // identity columns, so a bug that widened either side — an empty string, a
  // null, a LIKE — would sweep rows belonging to everyone else, and the victim's
  // own assertions above would still pass. This is the one that catches it.
  expect(await orderIdsFor(orders, bystander)).toContain(bystander.orderId);
  expect(await trackingsFor(tracking, bystander)).toHaveLength(1);

  const me = await users.get("/v1/users/me", { headers: { "x-user-id": bystander.id } });
  expect(me.status()).toBe(200);
});

test("DELETE /v1/orders/by-user rejects a missing key and a wrong key with 401", async () => {
  const orders = await ordersClient();
  const body = { cognitoSub: "usr_whatever", userId: "usr_whatever" };

  const missing = await orders.delete("/v1/orders/by-user", { data: body });
  expect(missing.status()).toBe(401);

  const wrong = await orders.delete("/v1/orders/by-user", {
    headers: { "x-api-key": "not-the-internal-key" },
    data: body,
  });
  expect(wrong.status()).toBe(401);
});

test("DELETE /v1/trackings/by-user rejects a missing key and a wrong key with 401", async () => {
  const tracking = await trackingClient();
  const body = { cognito_sub: "usr_whatever", user_id: "usr_whatever" };

  const missing = await tracking.delete("/v1/trackings/by-user", { data: body });
  expect(missing.status()).toBe(401);

  const wrong = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": "not-the-internal-key" },
    data: body,
  });
  expect(wrong.status()).toBe(401);
});

test("DELETE /v1/trackings/by-user rejects the CARRIER key — the two credentials are not interchangeable", async () => {
  const carrierKey = process.env.TRACKING_CARRIER_API_KEY;
  test.skip(
    !carrierKey,
    "TRACKING_CARRIER_API_KEY is not set — run `make env-file` so .env.local.tracking exists.",
  );

  const tracking = await trackingClient();

  // Tracking holds TWO inbound keys under the SAME header name: this internal
  // one (GRPC_API_KEY) and the EXTERNAL carrier's, which authenticates
  // `PUT /v1/trackings/{orderId}/status`. Accepting the carrier's key here would
  // let an outside vendor erase a user's entire delivery history — so the check
  // that they are distinct belongs in a test, not only in a comment.
  //
  // Asserted with the REAL carrier key rather than a random string: a random
  // string proves nothing beyond the wrong-key case above, and the failure mode
  // being guarded is a handler wired to `carrier_api_key` instead of
  // `grpc_api_key`, which only a genuine carrier key can expose.
  const res = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": carrierKey! },
    data: { cognito_sub: "usr_whatever", user_id: "usr_whatever" },
  });
  expect(res.status()).toBe(401);

  // Sanity: the two keys really are different values, so the assertion above is
  // not passing because the local stack happened to generate them identically.
  expect(carrierKey).not.toBe(internalKey());
});

test("both internal routes are idempotent: the second call reports 0", async () => {
  const users = await apiClient();
  const orders = await ordersClient();
  const tracking = await trackingClient();
  const actor = await makeActorWithData(users, orders);
  const key = internalKey();

  const ordersFirst = await orders.delete("/v1/orders/by-user", {
    headers: { "x-api-key": key },
    data: { cognitoSub: actor.id, userId: actor.id },
  });
  expect(ordersFirst.status()).toBe(200);
  // Asserted as ">= 1" rather than "=== 1": the count is what proves the first
  // call actually did work, which is the only thing that makes the 0 below
  // meaningful. Pinning it to exactly 1 would couple this test to how many rows
  // one order happens to produce.
  expect((await ordersFirst.json()).deleted).toBeGreaterThanOrEqual(1);

  const ordersSecond = await orders.delete("/v1/orders/by-user", {
    headers: { "x-api-key": key },
    data: { cognitoSub: actor.id, userId: actor.id },
  });
  expect(ordersSecond.status()).toBe(200);
  // The retry-safety guarantee the cascade's recovery story rests on: Users
  // calls Orders then Tracking, so a fault in the second leg is retried with the
  // first already done. `deleted_at IS NULL` is what makes that a no-op instead
  // of a double-stamp.
  expect(await ordersSecond.json()).toEqual({ deleted: 0, deletedDetails: 0, deletedCarts: 0 });

  const trackingFirst = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": key },
    data: { cognito_sub: actor.id, user_id: actor.id },
  });
  expect(trackingFirst.status()).toBe(200);
  expect((await trackingFirst.json()).deleted).toBeGreaterThanOrEqual(1);

  const trackingSecond = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": key },
    data: { cognito_sub: actor.id, user_id: actor.id },
  });
  expect(trackingSecond.status()).toBe(200);
  expect(await trackingSecond.json()).toEqual({ deleted: 0 });
});

// ## The empty-identity guard, and why it is worth two tests
//
// Both cascade predicates are `cognito_sub = ? OR user_id = ?`, and in MySQL both
// columns are NOT NULL varchar — which still permits the EMPTY STRING. An empty
// value on either side of that OR matches every row whose column was left blank
// or never backfilled: a mass erasure of other people's data from one malformed
// call. The refusal is the only thing standing between the two.
//
// The two services refuse differently and that is fine — Orders validates in the
// handler (400 with a named reason), Tracking in its Pydantic model (422 with
// FastAPI's validation shape). Asserting each service's ACTUAL status rather than
// a shared one is the point: a service that started accepting the empty string
// would return 200 here, and either expectation would catch it.

test("Orders' internal route refuses an empty identity with 400", async () => {
  const orders = await ordersClient();
  const key = internalKey();

  const emptySub = await orders.delete("/v1/orders/by-user", {
    headers: { "x-api-key": key },
    data: { cognitoSub: "", userId: "usr_whatever" },
  });
  expect(emptySub.status()).toBe(400);
  expect(await emptySub.json()).toEqual({ error: "cognito_sub_required" });

  // A DISTINCT reason per field, not a shared "identity_required": the caller is
  // another service, and which of the two it failed to send is the only fact
  // that tells an operator where the bug is.
  const emptyUserId = await orders.delete("/v1/orders/by-user", {
    headers: { "x-api-key": key },
    data: { cognitoSub: "usr_whatever", userId: "" },
  });
  expect(emptyUserId.status()).toBe(400);
  expect(await emptyUserId.json()).toEqual({ error: "user_id_required" });
});

test("Tracking's internal route refuses an empty identity with 422", async () => {
  const tracking = await trackingClient();
  const key = internalKey();

  const emptySub = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": key },
    data: { cognito_sub: "", user_id: "usr_whatever" },
  });
  expect(emptySub.status()).toBe(422);

  const emptyUserId = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": key },
    data: { cognito_sub: "usr_whatever", user_id: "" },
  });
  expect(emptyUserId.status()).toBe(422);

  // Names the field that failed, so a 422 raised for an unrelated reason (a
  // renamed key, a changed content type) cannot pass as this assertion.
  const detail = (await emptyUserId.json()).detail;
  expect(JSON.stringify(detail)).toContain("user_id");
});

test("the key check runs BEFORE the body is validated — a wrong key on an empty identity is still 401", async () => {
  const orders = await ordersClient();
  const tracking = await trackingClient();

  // Ordering matters for what an attacker learns: if validation ran first, an
  // unauthenticated caller could probe the body contract (field names, which one
  // is required) through the error messages of a route they cannot call. Both
  // services must answer 401 and nothing else.
  const ordersRes = await orders.delete("/v1/orders/by-user", {
    headers: { "x-api-key": "not-the-internal-key" },
    data: { cognitoSub: "", userId: "" },
  });
  expect(ordersRes.status()).toBe(401);

  const trackingRes = await tracking.delete("/v1/trackings/by-user", {
    headers: { "x-api-key": "not-the-internal-key" },
    data: { cognito_sub: "", user_id: "" },
  });
  expect(trackingRes.status()).toBe(401);
});
