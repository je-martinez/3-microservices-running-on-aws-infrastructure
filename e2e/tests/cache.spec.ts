import { test, expect } from "@playwright/test";
import { apiClient, ordersClient, trackingClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { carrierHeaders } from "../support/tracking-carrier-key.js";
import {
  cacheHeaderOf,
  expectHit,
  expectMiss,
  expectMissOrHit,
  expectNoCacheHeaderOnWrite,
} from "../support/cache-headers.js";

// Internal E2E for the response cache: two consecutive GETs must produce
// MISS then HIT, and an intervening write must return the next read to MISS.
// Direct service ports, `x-user-id` faked — the gateway path is covered
// separately by tests/gateway/cache.spec.ts, which exists for one specific
// reason the internal layer structurally cannot see: a gateway or an nginx
// location block can silently strip an unknown RESPONSE header, and from the
// service port that failure is invisible.
//
// ## Why every test registers its OWN caller
//
// Six of the seven cache keys carry `{sub}:{user_id}`
// (docs/shared/conventions/x-cache-response-header.md). A shared caller would
// let one test's warm cache satisfy another test's "cold read" assertion, and
// that contamination is order-dependent — the suite would pass alone and fail
// in a full run. A fresh caller per test makes every first read genuinely cold
// by construction. `orders:products:v1` is the one shared, ownerless key, and
// it is handled explicitly below rather than pretended otherwise.
//
// ## Speed is a CORRECTNESS property here, not a nicety
//
// TTLs are short — 60s for the cart and both tracking keys. A MISS/HIT pair
// separated by more than the TTL fails INTERMITTENTLY, and the failure reads as
// a cache bug rather than a test bug, which is the expensive kind of flake.
// Therefore:
//   - the two reads of a pair are ISSUED BACK TO BACK, with nothing between
//     them (no registration, no product lookup, no polling);
//   - everything a pair needs — caller, product, order, tracking — is set up
//     BEFORE the first read;
//   - there is NO `waitForTimeout` anywhere in this file. Sleeping to "let the
//     cache settle" is precisely what pushes a pair over a 60s boundary. The
//     cache is populated synchronously by the MISS response before that
//     response is returned, so there is nothing to wait for.
// TTL EXPIRY is deliberately NOT tested at this layer: the only honest way to
// test it is to wait out a real TTL, which would add minutes to the suite. It
// is covered in layer 1 (unit/integration) with a clock the tests control.

// Configured TTLs, in seconds, from the spec's key table. Used as the UPPER
// bound on X-Cache-TTL — a larger value means the wrong TTL was written.
const TTL = {
  products: 600, // orders:products:v1              — 10 min
  cart: 60, //     orders:cart:v1:{sub}:{user_id}   — 60 s
  myOrders: 120, // orders:my-orders:v1:...:t{0|1}  — 2 min
  order: 120, //    orders:order:v1:...:t{0|1}      — 2 min
  tracking: 60, //  tracking:order:v1:...           — 60 s
  trackingList: 60, // tracking:list:v1:...         — 60 s
  me: 300, //       users:me:v1:{sub}:{user_id}     — 5 min
} as const;

// Registers a throwaway caller against Users and returns its `usr_` id, used
// as the faked `x-user-id` everywhere below. Same helper shape as
// orders.spec.ts / cart.spec.ts — Users' gRPC GetUserById resolves by `usr_`
// id OR Cognito sub, so this one value works as `x-user-id` against all three
// services.
async function registerCaller(): Promise<string> {
  const users = await apiClient();
  const res = await users.post("/v1/users/register", { data: makeUser() });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const { id } = await res.json();
  return id as string;
}

async function firstProductWithStock(
  api: Awaited<ReturnType<typeof ordersClient>>,
  userId: string,
): Promise<{ id: string; unitsInStock: number }> {
  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(products.status()).toBe(200);
  const product = (await products.json()).find(
    (p: { unitsInStock: number }) => p.unitsInStock > 0,
  );
  expect(product, "no product with stock in the catalogue").toBeTruthy();
  return product;
}

// ---------------------------------------------------------------- products

// `orders:products:v1` is the ONE key with no owner in it — a shared catalogue
// entry, 10-minute TTL. That makes it the only endpoint here where a previous
// test (or a previous RUN) may legitimately have left the entry warm, so the
// first read cannot be asserted as a MISS. The honest assertion is the pair
// relationship: whatever the first read reports, the second must be a HIT.
//
// ## Why this one test retries
//
// Being ownerless also means EVERY other test's `POST /v1/orders` invalidates
// it — order creation decrements stock. So a foreign order landing between this
// test's two reads legitimately turns the second into a MISS, and that is this
// test assuming exclusivity it does not have rather than a cache defect. The
// same hazard bit the gateway copy of this test in a full-project run.
//
// The retry is BOUNDED and the assertion is NOT weakened: every attempt still
// demands a genuine HIT with a valid TTL, and running out of attempts fails.
// Accepting "MISS then MISS" would be the weakening — it would pass against a
// cache that stores nothing at all.
test("GET /v1/products: the catalogue is cached — a second read is a HIT", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const attempts = 4;
  let lastSecond: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const first = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(first.status()).toBe(200);
    expectMissOrHit(first, `first GET /v1/products (attempt ${attempt})`);

    const second = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(second.status()).toBe(200);
    lastSecond = cacheHeaderOf(second);
    if (lastSecond === "HIT") {
      expectHit(second, "second GET /v1/products", TTL.products);
      // The cached body must be identical to what the handler produced — a HIT
      // that serves a different shape is worse than no cache at all.
      // `unitPrice` is a money OBJECT ({cents, amount, formatted, currency}),
      // not a number, since the money-representation change; a serializer that
      // flattened it on the way into Redis would be caught right here.
      expect(await second.json()).toEqual(await first.json());
      return;
    }
  }

  throw new Error(
    `second GET /v1/products was never a HIT in ${attempts} attempts (last: ` +
      `${lastSecond ?? "no X-Cache header at all"}). One MISS is explainable — a concurrent ` +
      "POST /v1/orders invalidates the shared catalogue key — but four in a row means the " +
      "catalogue is not being cached at all.",
  );
});

// Ordering a product decrements stock, so `orders:products:v1` must be
// invalidated by POST /v1/orders (spec's invalidation matrix). This is the one
// test that intentionally perturbs the shared key, so it does its cold read
// AFTER the write rather than before.
test("POST /v1/orders invalidates the catalogue: the next GET /v1/products is a MISS", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  // Warm it deliberately, so the assertion below is about invalidation and not
  // about the key merely being cold.
  const warm = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(warm.status()).toBe(200);

  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);

  const after = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(after.status()).toBe(200);
  expectMiss(after, "GET /v1/products after POST /v1/orders");
});

// -------------------------------------------------------------------- cart

test("GET /v1/cart: MISS then HIT for the same caller", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  // All setup finished BEFORE the pair, so the two reads are adjacent in time
  // and cannot straddle the 60s TTL.
  const put = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(put.status()).toBe(200);
  expectNoCacheHeaderOnWrite(put, "PUT /v1/cart");

  const first = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(first.status()).toBe(200);
  expectMiss(first, "first GET /v1/cart");

  const second = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(second.status()).toBe(200);
  expectHit(second, "second GET /v1/cart", TTL.cart);
  expect(await second.json()).toEqual(await first.json());
});

test("PUT /v1/cart invalidates the cart key: the next GET is a MISS with the new contents", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  const warm = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expectMiss(warm, "first GET /v1/cart");
  const hit = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expectHit(hit, "second GET /v1/cart", TTL.cart);

  // The intervening write.
  const update = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 3 }] },
  });
  expect(update.status()).toBe(200);

  const after = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(after.status()).toBe(200);
  expectMiss(after, "GET /v1/cart after PUT /v1/cart");
  // Header AND body: a stale HIT and a fresh MISS serving stale contents are
  // different bugs, and only checking the header would catch one of them.
  const cart = await after.json();
  expect(cart.items).toHaveLength(1);
  expect(cart.items[0].quantity).toBe(3);
});

test("DELETE /v1/cart invalidates the cart key", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expectMiss(
    await api.get("/v1/cart", { headers: { "x-user-id": userId } }),
    "first GET /v1/cart",
  );
  expectHit(
    await api.get("/v1/cart", { headers: { "x-user-id": userId } }),
    "second GET /v1/cart",
    TTL.cart,
  );

  const deleted = await api.delete("/v1/cart", { headers: { "x-user-id": userId } });
  expect(deleted.status()).toBe(204);

  const after = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(after.status()).toBe(200);
  expectMiss(after, "GET /v1/cart after DELETE /v1/cart");
  expect((await after.json()).id).toBeNull();
});

// Cross-user isolation at the E2E layer. Layer 1 asserts it against the key
// builder; this asserts it against the running service, which is where an
// interceptor that forgot to include the caller in the key would actually show
// up — as user B receiving a HIT on user A's warm entry.
test("GET /v1/cart: user B never gets a HIT on user A's warm cart", async () => {
  const api = await ordersClient();
  const userA = await registerCaller();
  const userB = await registerCaller();
  const product = await firstProductWithStock(api, userA);

  await api.put("/v1/cart", {
    headers: { "x-user-id": userA },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expectMiss(
    await api.get("/v1/cart", { headers: { "x-user-id": userA } }),
    "user A first read",
  );
  expectHit(
    await api.get("/v1/cart", { headers: { "x-user-id": userA } }),
    "user A second read",
    TTL.cart,
  );

  const asB = await api.get("/v1/cart", { headers: { "x-user-id": userB } });
  expect(asB.status()).toBe(200);
  expectMiss(asB, "user B's first read must not hit user A's entry");
  expect((await asB.json()).items).toEqual([]);
});

// --------------------------------------------------------------- my-orders

// ## The includeTracking trap, and why both variants get their own pair
//
// `?includeTracking=true` and `=false` are DIFFERENT cache keys —
// `orders:my-orders:v1:{sub}:{user_id}:t1` and `...:t0` — returning DIFFERENT
// response shapes. Verified live against the running service: the t0 body is a
// list of orders (keys id/userId/lines/total/…), while the t1 body is a list of
// `{order, tracking}` envelopes. A spec that warmed one variant and then
// asserted a HIT on the other would be asserting a BUG: it would only pass if
// the key ignored the parameter, which is exactly the defect the `t{0|1}`
// segment exists to prevent. So each variant is warmed and asserted
// independently, and one extra assertion proves they are genuinely separate
// entries rather than one shared entry that happens to look right.
test("GET /v1/orders/my-orders: MISS then HIT, per includeTracking variant", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);
  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);

  // Variant t0 — the default.
  const t0First = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
  expect(t0First.status()).toBe(200);
  expectMiss(t0First, "first GET /v1/orders/my-orders (includeTracking omitted)");
  const t0Second = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
  expectHit(t0Second, "second GET /v1/orders/my-orders (includeTracking omitted)", TTL.myOrders);

  // Variant t1 — a DIFFERENT key. Its first read must be a MISS even though t0
  // is now warm; a HIT here would mean the parameter is not part of the key.
  const t1First = await api.get("/v1/orders/my-orders?includeTracking=true", {
    headers: { "x-user-id": userId },
  });
  expect(t1First.status()).toBe(200);
  expectMiss(
    t1First,
    "first GET /v1/orders/my-orders?includeTracking=true (t0 is warm — this must still MISS)",
  );
  const t1Second = await api.get("/v1/orders/my-orders?includeTracking=true", {
    headers: { "x-user-id": userId },
  });
  expectHit(t1Second, "second GET /v1/orders/my-orders?includeTracking=true", TTL.myOrders);

  // And the two entries really are different content, not merely different
  // keys — the `true` variant wraps each order in a {order, tracking} envelope.
  expect(await t1Second.json()).not.toEqual(await t0Second.json());
});

test("POST /v1/orders invalidates BOTH my-orders variants", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  // Warm both variants.
  expectMiss(
    await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } }),
    "warm t0",
  );
  expectMiss(
    await api.get("/v1/orders/my-orders?includeTracking=true", {
      headers: { "x-user-id": userId },
    }),
    "warm t1",
  );

  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const orderId = (await created.json()).id as string;

  // Both variants must be gone — the per-user key index is what makes deleting
  // a variable `t{0|1}` suffix possible without SCAN, and this is the assertion
  // that fails if only one of them was registered in that index.
  const t0 = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
  expectMiss(t0, "GET my-orders (t0) after POST /v1/orders");
  expect((await t0.json()).some((o: { id: string }) => o.id === orderId)).toBe(true);

  const t1 = await api.get("/v1/orders/my-orders?includeTracking=true", {
    headers: { "x-user-id": userId },
  });
  expectMiss(t1, "GET my-orders (t1) after POST /v1/orders");
});

// ------------------------------------------------------------ order by id

test("GET /v1/orders/{orderId}: MISS then HIT, and the t0/t1 variants are separate keys", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);
  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const orderId = (await created.json()).id as string;

  const first = await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": userId } });
  expect(first.status()).toBe(200);
  expectMiss(first, `first GET /v1/orders/${orderId}`);
  const second = await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": userId } });
  expectHit(second, `second GET /v1/orders/${orderId}`, TTL.order);
  expect(await second.json()).toEqual(await first.json());

  // Same trap as my-orders: `?includeTracking=true` is key `...:t1`, a
  // different entry with a different body. Warm t0 must not satisfy it.
  const withTracking = await api.get(`/v1/orders/${orderId}?includeTracking=true`, {
    headers: { "x-user-id": userId },
  });
  expect(withTracking.status()).toBe(200);
  expectMiss(
    withTracking,
    `first GET /v1/orders/${orderId}?includeTracking=true (t0 is warm — this must still MISS)`,
  );
});

test("GET /v1/orders/{orderId}: user B never gets a HIT on user A's warm order", async () => {
  const api = await ordersClient();
  const owner = await registerCaller();
  const other = await registerCaller();
  const product = await firstProductWithStock(api, owner);
  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": owner },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const orderId = (await created.json()).id as string;

  expectMiss(
    await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": owner } }),
    "owner first read",
  );
  expectHit(
    await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": owner } }),
    "owner second read",
    TTL.order,
  );

  // The other caller must get the ownership 404, NOT a cached 200. Only 200s
  // are cached, so this also proves the non-200 exclusion holds.
  const asOther = await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": other } });
  expect(
    asOther.status(),
    "another caller must never be served the owner's cached order",
  ).toBe(404);
  // And the 404 itself is never a HIT — a cached 404 would be served back to the
  // owner once their own entry expired.
  expect(cacheHeaderOf(asOther), "a 404 must never be served as a cache HIT").not.toBe("HIT");
});

// ---------------------------------------------------------------- tracking

// A synthetic order id — deliberately NOT a real Orders order, matching
// tests/tracking.spec.ts. `init-tracking` never validates the order's
// existence, so this keeps the Tracking cache tests independent of Orders and
// removes the "wait for the tracking row to appear" polling that would
// otherwise sit between the setup and the MISS/HIT pair and burn TTL.
// Fits VARCHAR(21) — ID_LENGTH in tracking's domain/models.py.
function syntheticOrderId(): string {
  return `ord_c${Math.random().toString(36).slice(2, 12)}`.slice(0, 21);
}

async function createTracking(
  api: Awaited<ReturnType<typeof trackingClient>>,
  userId: string,
): Promise<string> {
  const orderId = syntheticOrderId();
  const res = await api.post("/v1/trackings/init-tracking", {
    headers: { "x-user-id": userId },
    // No `x-test-mode`: a tracking that advanced on its own would invalidate
    // its own cache mid-test and turn every HIT assertion racy.
    data: { order_id: orderId, shipping_address: { line1: "1 Test St", city: "Austin" } },
  });
  expect(res.status(), `init-tracking failed: ${await res.text()}`).toBe(201);
  return orderId;
}

// ## Tracking cache specs MUST use a user that Users can resolve
//
// The one trap in this section, and it is not obvious from the assertions. A
// response key here is `tracking:{order|list}:v1:{sub}:{user_id}:…`, so the
// handler needs the caller's INTERNAL `usr_` id — resolved from the
// `cognito_sub` through Users over gRPC. When Users does not know that sub the
// resolve returns None, `CacheKeys` correctly DECLINES to build a key, and the
// read is served uncached: `X-Cache: MISS`, forever, no matter how healthy the
// cache is. That is the designed "skip caching when unresolved" behaviour, not
// a defect.
//
// So a spec that reuses a pre-seeded tracking row — the local DB has one owned
// by `11111111-1111-4111-8111-111111111111`, a sub Users has never heard of —
// would sit at MISS/MISS and read as a broken cache. Every test below therefore
// calls `registerCaller()`, which registers through the normal flow and returns
// a `usr_` id Users resolves by construction, and creates its OWN tracking.
// Do not swap that for a fixed id.
//
// (History, so it is not re-diagnosed: these specs were briefly `fixme`d for a
// real defect — an identity-cache HIT skipped the loader that populated
// `CurrentCaller._resolved`, so the key collapsed to None even for a resolvable
// caller. Fixed by `seed_resolved_internal_user_id()`; verified live MISS→HIT
// on both routes.)
test("GET /v1/trackings/{order_id}: MISS then HIT", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const orderId = await createTracking(api, userId);

  const first = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expect(first.status()).toBe(200);
  expectMiss(first, `first GET /v1/trackings/${orderId}`);
  const second = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expectHit(second, `second GET /v1/trackings/${orderId}`, TTL.tracking);
  expect(await second.json()).toEqual(await first.json());
});

test("the carrier PUT invalidates the tracking key: the next read is a MISS with the new status", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const orderId = await createTracking(api, userId);

  expectMiss(
    await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } }),
    "first read",
  );
  expectHit(
    await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } }),
    "second read",
    TTL.tracking,
  );

  // The carrier arrives with an API key and NO x-user-id — it does not know
  // the owner, so the invalidator must resolve `cognito_sub` from the tracking
  // row before deleting a key that carries `{sub}:{user_id}`. This assertion is
  // the one that fails if that resolution was skipped.
  const advanced = await api.put(`/v1/trackings/${orderId}/status`, {
    headers: carrierHeaders(),
    data: { status: "PROCESSING" },
  });
  expect(advanced.status(), `carrier PUT failed: ${await advanced.text()}`).toBe(200);

  const after = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expect(after.status()).toBe(200);
  expectMiss(after, "GET tracking after the carrier PUT");
  expect((await after.json()).status).toBe("PROCESSING");
});

test("GET /v1/trackings (batch): MISS then HIT for the same order_ids", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const orderId = await createTracking(api, userId);

  // The key is `tracking:list:v1:{sub}:{user_id}:{hash(order_ids)}` — the list
  // is normalized (sorted + deduped) then hashed, so the same set in a
  // different order is the SAME key. That property gets its own test below.
  const first = await api.get(`/v1/trackings?order_ids=${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expect(first.status()).toBe(200);
  expectMiss(first, "first GET /v1/trackings (batch)");
  const second = await api.get(`/v1/trackings?order_ids=${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expectHit(second, "second GET /v1/trackings (batch)", TTL.trackingList);
  expect(await second.json()).toEqual(await first.json());
});

test("GET /v1/trackings (batch): the order_ids list is normalized, so a reordered list HITs the same key", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const a = await createTracking(api, userId);
  const b = await createTracking(api, userId);

  expectMiss(
    await api.get(`/v1/trackings?order_ids=${a},${b}`, {
      headers: { "x-user-id": userId },
    }),
    "first batch read (a,b)",
  );
  // Reversed, and with a duplicate — normalization (sort + dedup) must fold
  // this onto the same key. A MISS here would mean the key is built from the
  // raw string, which multiplies cardinality by the number of orderings a
  // client happens to send.
  const reordered = await api.get(`/v1/trackings?order_ids=${b},${a},${b}`, {
    headers: { "x-user-id": userId },
  });
  expect(reordered.status()).toBe(200);
  expectHit(reordered, "reordered + deduplicated batch read", TTL.trackingList);
});

test("the carrier PUT invalidates the owner's batch list key too", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const orderId = await createTracking(api, userId);

  expectMiss(
    await api.get(`/v1/trackings?order_ids=${orderId}`, {
      headers: { "x-user-id": userId },
    }),
    "first batch read",
  );
  expectHit(
    await api.get(`/v1/trackings?order_ids=${orderId}`, {
      headers: { "x-user-id": userId },
    }),
    "second batch read",
    TTL.trackingList,
  );

  const advanced = await api.put(`/v1/trackings/${orderId}/status`, {
    headers: carrierHeaders(),
    data: { status: "SHIPPED" },
  });
  expect(advanced.status()).toBe(200);

  const after = await api.get(`/v1/trackings?order_ids=${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expect(after.status()).toBe(200);
  expectMiss(after, "batch read after the carrier PUT");
  // The batch body is an ENVELOPE — `{"trackings": [...]}`, not a bare array.
  // Verified live against the running service; the openapi schema at
  // services/tracking/openapi.yaml agrees.
  expect((await after.json()).trackings[0].status).toBe("SHIPPED");
});

// Cross-user isolation for Tracking, the same assertion Orders and Users each
// carry. It is worth stating separately here because Tracking's key is built
// from a gRPC-resolved id rather than from the header directly, so a bug that
// resolved every caller to the same user would show up ONLY at this layer.
test("GET /v1/trackings/{order_id}: user B never gets a HIT on user A's warm tracking", async () => {
  const api = await trackingClient();
  const userA = await registerCaller();
  const userB = await registerCaller();
  const orderId = await createTracking(api, userA);

  expectMiss(
    await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userA } }),
    "user A first read",
  );
  expectHit(
    await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userA } }),
    "user A second read",
    TTL.tracking,
  );

  // B does not own it, so the ownership 404 — never A's cached 200. Only 200s
  // are cached, so this also proves the non-200 exclusion holds on this route.
  const asB = await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userB } });
  expect(asB.status(), "another caller must never be served the owner's cached tracking").toBe(404);
  expect(cacheHeaderOf(asB), "a 404 must never be served as a cache HIT").not.toBe("HIT");
});

// ------------------------------------------------------------------- users

test("GET /v1/users/me: MISS then HIT", async () => {
  const api = await apiClient();
  const userId = await registerCaller();

  const first = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
  expect(first.status()).toBe(200);
  expectMiss(first, "first GET /v1/users/me");
  const second = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
  expectHit(second, "second GET /v1/users/me", TTL.me);
  expect(await second.json()).toEqual(await first.json());
});

test("PATCH /v1/users/me invalidates the profile key: the next GET is a MISS with the new name", async () => {
  const api = await apiClient();
  const userId = await registerCaller();

  expectMiss(await api.get("/v1/users/me", { headers: { "x-user-id": userId } }), "first read");
  expectHit(
    await api.get("/v1/users/me", { headers: { "x-user-id": userId } }),
    "second read",
    TTL.me,
  );

  const newFullName = "Cache Invalidation Test";
  const patch = await api.patch("/v1/users/me", {
    headers: { "x-user-id": userId },
    data: { fullName: newFullName },
  });
  expect(patch.status()).toBe(200);
  expectNoCacheHeaderOnWrite(patch, "PATCH /v1/users/me");

  const after = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
  expect(after.status()).toBe(200);
  expectMiss(after, "GET /v1/users/me after PATCH");
  expect((await after.json()).fullName).toBe(newFullName);
});

test("PATCH /v1/users/me/password invalidates the profile key (mustChangePassword is in the body)", async () => {
  const api = await apiClient();
  const users = await apiClient();
  const user = makeUser();
  const registered = await users.post("/v1/users/register", { data: user });
  expect(registered.status()).toBe(201);
  const userId = (await registered.json()).id as string;

  expectMiss(await api.get("/v1/users/me", { headers: { "x-user-id": userId } }), "first read");
  expectHit(
    await api.get("/v1/users/me", { headers: { "x-user-id": userId } }),
    "second read",
    TTL.me,
  );

  // The password change also mutates `mustChangePassword`, which is part of the
  // cached GET /v1/users/me body — so it must invalidate the profile key even
  // though nothing password-related is ever cached.
  const changed = await api.patch("/v1/users/me/password", {
    headers: { "x-user-id": userId },
    data: { newPassword: `Zz9!${user.password.slice(4)}` },
  });
  expect(changed.status(), `password change failed: ${await changed.text()}`).toBe(200);

  const after = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
  expect(after.status()).toBe(200);
  expectMiss(after, "GET /v1/users/me after PATCH /v1/users/me/password");
});

test("GET /v1/users/me: user B never gets a HIT on user A's warm profile", async () => {
  const api = await apiClient();
  const userA = await registerCaller();
  const userB = await registerCaller();

  expectMiss(
    await api.get("/v1/users/me", { headers: { "x-user-id": userA } }),
    "user A first read",
  );
  expectHit(
    await api.get("/v1/users/me", { headers: { "x-user-id": userA } }),
    "user A second read",
    TTL.me,
  );

  const asB = await api.get("/v1/users/me", { headers: { "x-user-id": userB } });
  expect(asB.status()).toBe(200);
  expectMiss(asB, "user B's first read must not hit user A's entry");
  expect((await asB.json()).id).toBe(userB);
});

// Non-200s are never cached (spec: "Only 200 responses populate the cache").
// A 401 that ended up in Redis would be catastrophic — it would be served to
// an authenticated caller — so this asserts the exclusion directly rather than
// trusting it.
test("a 401 is never cached: two unauthenticated reads both carry no HIT", async () => {
  const api = await apiClient();
  const first = await api.get("/v1/users/me");
  expect(first.status()).toBe(401);
  expect(cacheHeaderOf(first), "a 401 must never be served as a cache HIT").not.toBe("HIT");
  const second = await api.get("/v1/users/me");
  expect(second.status()).toBe(401);
  expect(cacheHeaderOf(second), "a 401 must never be served as a cache HIT").not.toBe("HIT");
});
