import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { carrierHeaders } from "../../support/tracking-carrier-key.js";

// Gateway coverage of Tracking's security and contract properties, beyond the
// happy-path journey in tracking-flow.spec.ts: ownership isolation, the batch
// read's omission rule, creation idempotency, the carrier PUT's separate auth
// scheme, and the authorizer's 401.
//
// These belong at the gateway layer specifically. Ownership depends on the caller's
// identity arriving as `x-user-id` derived from a **verified** JWT sub; a direct
// service call fakes that header and therefore cannot prove the gateway wires it
// from the right claim. The carrier PUT's `auth = false` route declaration is a
// gateway artifact with no internal equivalent at all.
//
// All request paths are RELATIVE — see gateway-client.ts.

//: The gateway route for the carrier PUT is declared `auth = false`, so the whole
// point is that these calls carry NO Authorization header. `gatewayClient()` with
// no token gives exactly that.
const NO_TOKEN = undefined;

type TrackingPayload = {
  id: string;
  user_id: string;
  order_id: string;
  status: string;
  history: { status: string }[];
};

// Creates an order with `x-test-mode` OFF, so the tracking stays parked at SHIPPED
// for the whole test. Deliberate: a tracking that is quietly advancing in the
// background would make the carrier-PUT assertions racy — a PUT to ON_THE_WAY can
// legitimately be rejected as `not_strictly_forward` if the progression got there
// first. Without the header, nothing moves except what the test moves.
async function createOrderWithTracking(
  api: Awaited<ReturnType<typeof gatewayClient>>,
): Promise<{ orderId: string; tracking: TrackingPayload }> {
  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const catalogue = await products.json();
  const product = catalogue.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product, "no product with stock in the catalogue").toBeTruthy();

  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const orderId = (await created.json()).id as string;

  // Orders calls init-tracking after its transaction commits, so the row may lag
  // the 201 by a moment. Bounded retry, never an unbounded wait.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await api.get(`v1/trackings/${orderId}`);
    if (res.status() === 200) {
      return { orderId, tracking: (await res.json()) as TrackingPayload };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `No tracking appeared for ${orderId} within 20s — Orders' call to ` +
      "POST /v1/trackings/init-tracking did not land. Check the Orders logs.",
  );
}

test("GET v1/tracking/health is public and returns 200 with no auth", async () => {
  const api = await gatewayClient(NO_TOKEN);
  // SINGULAR `/v1/tracking/health`, not the plural `/v1/trackings/*` the functional
  // routes use. The prefix is load-bearing, not cosmetic: nginx's catch-all
  // `location /` proxies anything unmatched to users:3000, so a bare
  // `GET /v1/health` gateway route would resolve to USERS and return Users' 200 —
  // a health check reporting green while never once reaching Tracking.
  const res = await api.get("v1/tracking/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET v1/trackings/{orderId} without a Bearer token is 401 from the authorizer", async () => {
  const api = await gatewayClient(NO_TOKEN);
  // Rejected at the gateway's JWT authorizer, before nginx or the service — so the
  // order id need not exist. A 404 here would mean the authorizer was bypassed and
  // the service answered, which is the failure this guards.
  const res = await api.get("v1/trackings/ord_doesnotexist");
  expect(res.status()).toBe(401);
});

test("GET v1/trackings (batch) without a Bearer token is 401 from the authorizer", async () => {
  const api = await gatewayClient(NO_TOKEN);
  const res = await api.get("v1/trackings?order_ids=ord_doesnotexist");
  expect(res.status()).toBe(401);
});

test("POST v1/trackings/init-tracking without a Bearer token is 401 from the authorizer", async () => {
  const api = await gatewayClient(NO_TOKEN);
  const res = await api.post("v1/trackings/init-tracking", {
    data: { order_id: "ord_doesnotexist" },
  });
  expect(res.status()).toBe(401);
});

test("GET v1/trackings/{orderId} for a nonexistent order is 404", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.get("v1/trackings/ord_doesnotexist");
  expect(res.status()).toBe(404);
});

// THE ownership test. User B reading user A's tracking must be answered 404, not
// 403: a 403 would confirm that a tracking exists for that order id, turning the
// endpoint into an oracle for other people's order ids. The response must be
// indistinguishable from "no such tracking" — asserted by comparing it against the
// genuinely-nonexistent case above and requiring the same code.
//
// Two DIFFERENT users, and therefore two different Cognito subs, is what makes this
// test able to fail at all. Tracking stores both `user_id` (internal `usr_`) and
// `cognito_sub`, and only the latter is the ownership key. A suite that created and
// read with a single identity passes whether the filter is right or wrong — that
// exact blind spot let a `user_id`-scoped filter ship past 253 tests
// (services/tracking/CLAUDE.md §5b).
test("ownership isolation: another user's tracking is 404, never 403", async () => {
  test.setTimeout(90_000);

  const owner = await getGatewayToken();
  const ownerApi = await gatewayClient(owner.token);
  const { orderId, tracking } = await createOrderWithTracking(ownerApi);

  // The owner can read it — otherwise a 404 for the other user would prove nothing
  // (a filter that matches nobody 404s everyone, including the rightful owner).
  const asOwner = await ownerApi.get(`v1/trackings/${orderId}`);
  expect(asOwner.status()).toBe(200);
  expect((await asOwner.json()).id).toBe(tracking.id);

  const other = await getGatewayToken();
  expect(other.email).not.toBe(owner.email);
  const otherApi = await gatewayClient(other.token);

  const asOther = await otherApi.get(`v1/trackings/${orderId}`);
  expect(asOther.status()).toBe(404);
  expect(asOther.status()).not.toBe(403);

  // Byte-identical to the not-found case, not merely the same code: any extra field
  // ("exists but not yours", an id echo) would leak the very fact 404 exists to hide.
  const missing = await otherApi.get("v1/trackings/ord_doesnotexist");
  expect(missing.status()).toBe(404);
  expect(await asOther.json()).toEqual(await missing.json());
});

// The batch read's counterpart to the 404 rule: ids the caller does not own are
// silently OMITTED from the list. Never an error, never a per-id partial-failure
// entry, and with no indication of how many were dropped or why — a caller who asks
// for three and owns one gets exactly one tracking back.
test("batch read silently omits ids the caller does not own, and never errors", async () => {
  test.setTimeout(120_000);

  const owner = await getGatewayToken();
  const ownerApi = await gatewayClient(owner.token);
  const mine = await createOrderWithTracking(ownerApi);

  const other = await getGatewayToken();
  const otherApi = await gatewayClient(other.token);
  const theirs = await createOrderWithTracking(otherApi);

  // Ask for: one I own, one someone else owns, one that does not exist.
  const res = await ownerApi.get(
    `v1/trackings?order_ids=${mine.orderId},${theirs.orderId},ord_doesnotexist`,
  );
  // 200, not 207/400/404: "none of these are yours" is a complete answer to the
  // question asked, not a failure.
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.trackings)).toBe(true);
  expect(body.trackings).toHaveLength(1);
  expect(body.trackings[0].order_id).toBe(mine.orderId);
  // No side channel describing what was dropped.
  const returnedIds = body.trackings.map((t: TrackingPayload) => t.order_id);
  expect(returnedIds).not.toContain(theirs.orderId);
  expect(returnedIds).not.toContain("ord_doesnotexist");

  // A batch of nothing-but-unowned ids is still a 200 with an empty list, and is
  // deliberately indistinguishable from a batch of ids that do not exist.
  const noneOwned = await ownerApi.get(
    `v1/trackings?order_ids=${theirs.orderId},ord_doesnotexist`,
  );
  expect(noneOwned.status()).toBe(200);
  expect((await noneOwned.json()).trackings).toEqual([]);
});

// Idempotency guard: one tracking per order, forever. A retried creation must not
// duplicate a shipment, so the second call is rejected with 409 and the existing
// tracking is left untouched.
test("a second init-tracking for the same order is 409 and leaves the tracking untouched", async () => {
  test.setTimeout(90_000);

  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const { orderId, tracking } = await createOrderWithTracking(api);

  // The first tracking came from Orders' own init-tracking call during order
  // creation, so this direct call is already the second one for this order.
  const conflict = await api.post("v1/trackings/init-tracking", {
    data: { order_id: orderId, shipping_address: { line1: "somewhere else" } },
  });
  expect(conflict.status()).toBe(409);
  // `reason` is nested under `detail` here (FastAPI's HTTPException contract for a
  // structured detail), unlike the carrier PUT's flat ErrorResponse — see
  // init_tracking_router._error. The token is what matters, and it names the RULE
  // rather than the mechanism: a caller should not have to know a unique index
  // is involved.
  const body = await conflict.json();
  expect(body.detail.reason).toBe("tracking_already_exists");

  // Untouched: same tracking id, same status, same single history row. A 409 that
  // had partially written would show up here as a changed id or an extra row.
  const after = await api.get(`v1/trackings/${orderId}`);
  expect(after.status()).toBe(200);
  const reread = (await after.json()) as TrackingPayload;
  expect(reread.id).toBe(tracking.id);
  expect(reread.status).toBe(tracking.status);
  expect(reread.history).toHaveLength(tracking.history.length);
});

// The carrier PUT, and the reason it has its own spec: it is authenticated by
// TRACKING_CARRIER_API_KEY and by NOTHING ELSE. No Bearer token, no `x-user-id` —
// its gateway route is declared `auth = false`, so the Cognito authorizer never
// runs. It must work in exactly that shape, which is the opposite of every other
// route here and the easiest thing to break by "fixing" the route to require auth.
test("the carrier PUT advances the status with only an API key and NO JWT", async () => {
  test.setTimeout(90_000);

  const { token } = await getGatewayToken();
  const authedApi = await gatewayClient(token);
  const { orderId, tracking } = await createOrderWithTracking(authedApi);
  expect(tracking.status).toBe("SHIPPED");

  // No token on this context — deliberately. If this ever needs one, the route's
  // `auth = false` declaration has been changed and every real carrier is broken.
  const carrierApi = await gatewayClient(NO_TOKEN);
  const res = await carrierApi.put(`v1/trackings/${orderId}/status`, {
    headers: carrierHeaders(),
    data: { status: "ON_THE_WAY" },
  });
  expect(res.status(), `carrier PUT failed: ${await res.text()}`).toBe(200);
  const updated = (await res.json()) as TrackingPayload;
  expect(updated.status).toBe("ON_THE_WAY");
  expect(updated.id).toBe(tracking.id);
  // The transition is appended to the immutable history, not swapped in place.
  expect(updated.history.map((h) => h.status)).toEqual(["SHIPPED", "ON_THE_WAY"]);

  // And the owner sees the carrier's update on their own read — the two surfaces
  // are the same record, not two views that could drift.
  const asOwner = await authedApi.get(`v1/trackings/${orderId}`);
  expect(asOwner.status()).toBe(200);
  expect((await asOwner.json()).status).toBe("ON_THE_WAY");
});

test("the carrier PUT with a wrong API key is 401", async () => {
  const api = await gatewayClient(NO_TOKEN);
  // A wrong key identifies nobody, so there is no principal to forbid: 401, not 403.
  // The order id need not exist — auth is a router-level dependency and runs before
  // the handler ever looks one up, so a 404 here would mean the key was accepted.
  const res = await api.put("v1/trackings/ord_doesnotexist/status", {
    headers: { "x-api-key": "definitely-not-the-carrier-key" },
    data: { status: "DELIVERED" },
  });
  expect(res.status()).toBe(401);
});

test("the carrier PUT with no API key at all is 401, indistinguishable from a wrong one", async () => {
  const api = await gatewayClient(NO_TOKEN);
  const missing = await api.put("v1/trackings/ord_doesnotexist/status", {
    data: { status: "DELIVERED" },
  });
  expect(missing.status()).toBe(401);

  // Absent and wrong must look the same, so a caller cannot probe whether the key
  // it holds is *nearly* right.
  const wrong = await api.put("v1/trackings/ord_doesnotexist/status", {
    headers: { "x-api-key": "definitely-not-the-carrier-key" },
    data: { status: "DELIVERED" },
  });
  expect(await missing.json()).toEqual(await wrong.json());
});

// A valid Cognito JWT is NOT a carrier credential. The two schemes live in separate
// trust domains and the PUT accepts only its own key — presenting a Bearer token
// instead must fail, or an end user could rewrite their own delivery status.
test("the carrier PUT rejects a valid Bearer token used in place of the API key", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.put("v1/trackings/ord_doesnotexist/status", {
    data: { status: "DELIVERED" },
  });
  expect(res.status()).toBe(401);
});
