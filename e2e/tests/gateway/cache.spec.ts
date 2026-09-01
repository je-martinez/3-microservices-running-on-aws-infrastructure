import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { carrierHeaders } from "../../support/tracking-carrier-key.js";
import {
  cacheHeaderOf,
  expectHit,
  expectMiss,
  expectMissOrHit,
  expectNoCacheHeaderOnWrite,
} from "../../support/cache-headers.js";
import {
  settleAfterTrackingBurst,
  waitForMyOrdersTrackingReadable,
  waitForOrderTrackingReadable,
} from "../../support/tracking-readiness.js";

// CONTRACT: Gateway layer-3 — assert X-Cache survives API Gateway + nginx, not just
// that the cache works on the service port (layer 2 in tests/cache.spec.ts).
// WHY: All paths are RELATIVE — leading slash replaces gateway baseURL path.
// MISS/HIT pairs are back-to-back with setup first; no waitForTimeout (60s TTLs).
// See [[testing]]

const TTL = {
  products: 600,
  cart: 60,
  myOrders: 120,
  order: 120,
  tracking: 60,
  trackingList: 60,
  me: 300,
} as const;

async function newAuthedClient(): Promise<
  Awaited<ReturnType<typeof gatewayClient>>
> {
  const { token } = await getGatewayToken();
  return gatewayClient(token);
}

async function firstProductWithStock(
  api: Awaited<ReturnType<typeof gatewayClient>>,
): Promise<{ id: string; unitsInStock: number }> {
  const products = await api.get("v1/products");
  expect(
    products.status(),
    `GET v1/products failed: ${await products.text()}`,
  ).toBe(200);
  const product = (
    (await products.json()) as Array<{ id: string; unitsInStock: number }>
  )
    .filter((p) => p.unitsInStock > 0)
    .sort((a, b) => b.unitsInStock - a.unitsInStock)[0];
  expect(product, "no product with stock in the catalogue").toBeTruthy();
  return product;
}

async function createOrderWithAvailableProduct(
  api: Awaited<ReturnType<typeof gatewayClient>>,
): Promise<{ orderId: string; product: { id: string; unitsInStock: number } }> {
  const products = await api.get("v1/products");
  expect(
    products.status(),
    `GET v1/products failed: ${await products.text()}`,
  ).toBe(200);
  const candidates = (
    (await products.json()) as Array<{ id: string; unitsInStock: number }>
  )
    .filter((p) => p.unitsInStock > 0)
    .sort((a, b) => b.unitsInStock - a.unitsInStock);
  expect(candidates, "no product with stock in the catalogue").not.toHaveLength(
    0,
  );

  const depleted: string[] = [];
  for (const product of candidates) {
    const created = await api.post("v1/orders", {
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    const body = await created.text();
    if (created.status() === 201) {
      return { orderId: (JSON.parse(body) as { id: string }).id, product };
    }

    // Product stock is shared across all Playwright workers, while the
    // catalogue response itself may have been cached just before another order
    // consumed the final unit. Only that expected setup race moves to the next
    // candidate; every other response still fails immediately.
    let error: string | undefined;
    try {
      error = (JSON.parse(body) as { error?: string }).error;
    } catch {
      // The status assertion below reports the original body.
    }
    if (created.status() === 409 && error === "insufficient_stock") {
      depleted.push(product.id);
      continue;
    }

    expect(created.status(), `POST v1/orders failed: ${body}`).toBe(201);
  }

  throw new Error(
    `Every product reported with stock was depleted by another worker before POST v1/orders ` +
      `could lock it (tried: ${depleted.join(", ")}).`,
  );
}

test("X-Cache survives the gateway on GET v1/users/me (nginx default `/` location)", async () => {
  const api = await newAuthedClient();

  const first = await api.get("v1/users/me");
  expect(first.status(), `GET v1/users/me failed: ${await first.text()}`).toBe(
    200,
  );
  expectMiss(first, "first GET v1/users/me through the gateway");

  const second = await api.get("v1/users/me");
  expect(second.status()).toBe(200);
  // The whole point: HIT *and* X-Cache-TTL both arrived intact after the JWT
  // authorizer, njs sub-extraction and nginx's catch-all `location /` proxy.
  expectHit(second, "second GET v1/users/me through the gateway", TTL.me);
});

// CONTRACT: orders:products:v1 is ownerless — concurrent POST /v1/orders invalidates
// it between reads. Retry bounded; each attempt still demands real MISS/HIT.
test("X-Cache survives the gateway on GET v1/products (nginx `location /v1/products`)", async () => {
  const api = await newAuthedClient();
  const attempts = 4;
  let lastSecond: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const first = await api.get("v1/products");
    expect(first.status()).toBe(200);
    // The catalogue key is shared and ownerless, so it may legitimately be warm
    // from an earlier test — the pair relationship is the assertion, not the
    // first read's value. It must still carry the header, and must not be BYPASS.
    expectMissOrHit(
      first,
      `first GET v1/products through the gateway (attempt ${attempt})`,
    );

    const second = await api.get("v1/products");
    expect(second.status()).toBe(200);
    lastSecond = cacheHeaderOf(second);
    if (lastSecond === "HIT") {
      // The real assertion, including the TTL bound.
      expectHit(
        second,
        "second GET v1/products through the gateway",
        TTL.products,
      );
      return;
    }
  }

  throw new Error(
    `second GET v1/products through the gateway was never a HIT in ${attempts} attempts ` +
      `(last: ${lastSecond ?? "no X-Cache header at all"}). One MISS is explainable — a ` +
      "concurrent POST /v1/orders invalidates the shared catalogue key — but four in a row " +
      "means the catalogue is not being cached at all.",
  );
});

test("X-Cache survives the gateway on GET v1/cart, and PUT v1/cart returns it to MISS", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);

  const put = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(put.status(), `PUT v1/cart failed: ${await put.text()}`).toBe(200);
  // A WRITE must never carry a cache header — only GETs are cached.
  expectNoCacheHeaderOnWrite(put, "PUT v1/cart through the gateway");

  const first = await api.get("v1/cart");
  expectMiss(first, "first GET v1/cart through the gateway");
  const second = await api.get("v1/cart");
  expectHit(second, "second GET v1/cart through the gateway", TTL.cart);

  const update = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 2 }] },
  });
  expect(update.status()).toBe(200);

  const after = await api.get("v1/cart");
  expectMiss(after, "GET v1/cart after PUT, through the gateway");
  expect((await after.json()).items[0].quantity).toBe(2);
});

test("X-Cache survives the gateway on both my-orders variants and on GET v1/orders/{orderId}", async () => {
  // Above the 30s default: this test legitimately waits for an asynchronously
  // created tracking to become readable through Orders, and may re-sweep and retry
  // the t1 pair when Tracking's single dev worker is slow (see the t1 block below).
  // Each gateway request also pays the JWT authorizer and nginx hop. The budget is
  // still BOUNDED — a genuinely stuck tracking fails rather than hanging the suite.
  test.setTimeout(120_000);

  const api = await newAuthedClient();
  const { orderId, product } = await createOrderWithAvailableProduct(api);

  // WHY: Wait for tracking, sweep cart keys cold, then settle before t1 MISS/HIT pair.
  await waitForOrderTrackingReadable(
    api,
    `v1/orders/${orderId}?includeTracking=true`,
  );
  await waitForMyOrdersTrackingReadable(
    api,
    "v1/orders/my-orders?includeTracking=true",
  );
  const sweep = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(
    sweep.status(),
    `PUT v1/cart (cold-start sweep) failed: ${await sweep.text()}`,
  ).toBe(200);
  // Let Tracking's single dev-mode worker drain before the reads below burst at it,
  // or Orders' 2s read budget expires and the t1 MISS stores nothing — see
  // support/tracking-readiness.ts for the measurements behind this.
  await settleAfterTrackingBurst();

  // t0 — no wait of its own: it carries no tracking and caches unconditionally.
  expectMiss(
    await api.get("v1/orders/my-orders"),
    "first GET v1/orders/my-orders (t0)",
  );
  expectHit(
    await api.get("v1/orders/my-orders"),
    "second GET v1/orders/my-orders (t0)",
    TTL.myOrders,
  );

  // CONTRACT: t1 pair retries when Orders' 2s Tracking budget overruns — bounded;
  // each attempt still demands real MISS then HIT, not MISS/MISS.
  const t1Attempts = 4;
  let t1Second: string | undefined;
  for (let attempt = 1; attempt <= t1Attempts; attempt++) {
    const first = await api.get("v1/orders/my-orders?includeTracking=true");
    expectMiss(
      first,
      `first GET v1/orders/my-orders?includeTracking=true (t0 is warm — this must still MISS, attempt ${attempt})`,
    );

    const second = await api.get("v1/orders/my-orders?includeTracking=true");
    t1Second = cacheHeaderOf(second);
    if (t1Second === "HIT") {
      expectHit(
        second,
        "second GET v1/orders/my-orders?includeTracking=true",
        TTL.myOrders,
      );
      break;
    }

    // Not stored: Orders' read to Tracking overran its budget, so this attempt saw
    // `tracking: null`. Re-sweep so the next attempt starts cold again, and let the
    // single worker drain before retrying.
    if (attempt < t1Attempts) {
      const resweep = await api.put("v1/cart", {
        data: { items: [{ productId: product.id, quantity: 1 }] },
      });
      expect(resweep.status()).toBe(200);
      await settleAfterTrackingBurst();
    }
  }
  expect(
    t1Second,
    `second GET v1/orders/my-orders?includeTracking=true was never a HIT in ${t1Attempts} ` +
      "attempts. Each attempt did observe a real MISS first, so the key is being keyed and " +
      "served correctly — what is failing is STORAGE: Orders declines to cache a t1 list whose " +
      "tracking is missing, and its read to Tracking keeps overrunning the 2s " +
      "TrackingHttpClient.ReadTimeout. Check the Orders logs for `tracking_read_failed " +
      'reason="unreachable"` and Tracking\'s own duration_ms on GET /v1/trackings — if that ' +
      "route is answering in seconds, this is a Tracking performance problem, not a cache defect.",
  ).toBe("HIT");

  // The param route — the one that historically dropped its path segment at
  // the gateway, so a header assertion on it is worth its own pair.
  expectMiss(
    await api.get(`v1/orders/${orderId}`),
    `first GET v1/orders/${orderId}`,
  );
  expectHit(
    await api.get(`v1/orders/${orderId}`),
    `second GET v1/orders/${orderId}`,
    TTL.order,
  );
});

// CONTRACT: Gateway X-Cache on both Tracking routes; real Cognito user resolves cache key.
test("X-Cache survives the gateway on both Tracking read routes, and both serve a HIT", async () => {
  const api = await newAuthedClient();
  // No `x-test-mode`, so the tracking parks at PLACED and cannot advance —
  // and therefore cannot invalidate its own key — mid-test.
  const { orderId } = await createOrderWithAvailableProduct(api);

  // Poll tracking exists before cache assertions (async init-tracking; 60s TTL).
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    const probe = await api.get(`v1/trackings/${orderId}`);
    if (probe.status() === 200) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(
    ready,
    `No tracking appeared for ${orderId} within 20s — Orders' call to ` +
      "POST /v1/trackings/init-tracking did not land. Check the Orders logs.",
  ).toBe(true);

  // Poll warmed single-read key — assert HIT (stronger than MISS/HIT after poll).
  const single = await api.get(`v1/trackings/${orderId}`);
  expect(single.status()).toBe(200);
  expectHit(
    single,
    `GET v1/trackings/${orderId} through the gateway (warmed by the poll above). A MISS ` +
      "here with the internal spec green on :3002 would mean the gateway stripped the header",
    TTL.tracking,
  );

  // Batch route is a separate cache key — cold MISS/HIT pair.
  expectMiss(
    await api.get(`v1/trackings?order_ids=${orderId}`),
    "first batch read through the gateway",
  );
  const batchWarm = await api.get(`v1/trackings?order_ids=${orderId}`);
  expect(batchWarm.status()).toBe(200);
  expectHit(
    batchWarm,
    "second batch read through the gateway",
    TTL.trackingList,
  );
  // Envelope, not a bare array — verified live against the running service.
  expect(Array.isArray((await batchWarm.json()).trackings)).toBe(true);

  // Carrier route: API key only (auth=false at gateway); write invalidates cache.
  const carrier = await gatewayClient();
  const advanced = await carrier.put(`v1/trackings/${orderId}/status`, {
    headers: carrierHeaders(),
    data: { status: "PROCESSING" },
  });
  expect(
    advanced.status(),
    `carrier PUT failed: ${await advanced.text()}`,
  ).toBe(200);
  expectNoCacheHeaderOnWrite(advanced, "carrier PUT through the gateway");

  const after = await api.get(`v1/trackings/${orderId}`);
  expect(after.status()).toBe(200);
  expectMiss(after, "GET tracking after the carrier PUT, through the gateway");
  expect((await after.json()).status).toBe("PROCESSING");
});

// CONTRACT: CACHE_ENABLED=false means no X-Cache at all — distinct from gateway stripping.
// Guarded by E2E_EXPECT_CACHE_DISABLED=1 during the A/B load run OFF leg.
test("with CACHE_ENABLED=false the gateway returns NO X-Cache header at all", async () => {
  test.skip(
    process.env.E2E_EXPECT_CACHE_DISABLED !== "1",
    "Only meaningful while the services run with CACHE_ENABLED=false — set " +
      "E2E_EXPECT_CACHE_DISABLED=1 during the A/B run's OFF leg.",
  );
  const api = await newAuthedClient();

  const first = await api.get("v1/users/me");
  expect(first.status()).toBe(200);
  expect(
    cacheHeaderOf(first),
    "X-Cache must be absent when caching is off",
  ).toBeUndefined();

  const second = await api.get("v1/users/me");
  expect(second.status()).toBe(200);
  expect(
    cacheHeaderOf(second),
    "X-Cache must be absent when caching is off",
  ).toBeUndefined();
  expect(second.headers()["x-cache-ttl"]).toBeUndefined();
});
