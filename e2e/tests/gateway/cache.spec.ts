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

// Gateway E2E for the response cache — real Cognito JWT through
// API_GATEWAY_URL, the URL a person actually hits.
//
// ## This layer exists for exactly ONE reason
//
// An API Gateway, or an nginx `location` block, can silently STRIP a response
// header it does not know about — and that failure is completely invisible from
// the service port. The internal specs in tests/cache.spec.ts would stay green
// while every real client received a response with no `X-Cache` at all, which
// is indistinguishable from the cache being off. Nothing else in the suite can
// see that, which is why this file duplicates the MISS/HIT shape rather than
// being folded into the internal spec: the assertion is not "does the cache
// work" — layer 2 answered that — it is "does the header SURVIVE the full
// path". Required by docs/shared/conventions/testing.md and each service's
// CLAUDE.md §2b.
//
// **Answered, 2026-08-26: it survives.** Verified by hand against the running
// Floci stack before these specs were written — `X-Cache` and `X-Cache-TTL`
// both arrive intact through the API Gateway, the JWT authorizer, njs
// sub-extraction and nginx, for Users (`location /`), Orders (`/v1/products`,
// `/v1/cart`, `/v1/orders`) and Tracking (`/v1/trackings`). That is a finding
// with a short shelf life, which is precisely why it is a test and not a note:
// the next proxy config change is free to break it silently.
//
// Every route these specs touch already has both its API Gateway route entry
// (infra/modules/api-gateway/main.tf) and its nginx `location` block
// (infra/modules/compute/nginx/nginx.conf: /v1/orders, /v1/products, /v1/cart,
// /v1/trackings, and the default `/` for Users) — caching adds no new routes.
// A 404 carrying the gateway's own `{"message":"Not Found"}` body rather than a
// service's `{error: …}` shape would mean the request never reached nginx.
//
// ## All request paths are RELATIVE
//
// gatewayClient() normalizes baseURL to a trailing slash, and Playwright joins
// with the WHATWG URL algorithm where a LEADING slash REPLACES the whole
// baseURL path — dropping the request onto Floci's S3 root instead of the
// gateway integration. See support/gateway-client.ts.
//
// ## Same TTL discipline as the internal spec
//
// MISS/HIT pairs are issued back to back with all setup done first, and there
// is no waitForTimeout anywhere: the cart and tracking TTLs are 60 seconds, and
// a sleep between the two reads is what turns a correct spec into an
// intermittent one. This layer is SLOWER per request (JWT authorizer + nginx
// hop), which makes the discipline matter more here, not less — so the coverage
// is deliberately narrower than the internal spec's: one pair per endpoint,
// plus the CACHE_ENABLED=false assertion. The exhaustive invalidation and
// cross-user matrix stays in layer 2 where it is cheap.

const TTL = {
  products: 600,
  cart: 60,
  myOrders: 120,
  order: 120,
  tracking: 60,
  trackingList: 60,
  me: 300,
} as const;

async function newAuthedClient(): Promise<Awaited<ReturnType<typeof gatewayClient>>> {
  const { token } = await getGatewayToken();
  return gatewayClient(token);
}

async function firstProductWithStock(
  api: Awaited<ReturnType<typeof gatewayClient>>,
): Promise<{ id: string; unitsInStock: number }> {
  const products = await api.get("v1/products");
  expect(products.status(), `GET v1/products failed: ${await products.text()}`).toBe(200);
  const product = (await products.json()).find(
    (p: { unitsInStock: number }) => p.unitsInStock > 0,
  );
  expect(product, "no product with stock in the catalogue").toBeTruthy();
  return product;
}

test("X-Cache survives the gateway on GET v1/users/me (nginx default `/` location)", async () => {
  const api = await newAuthedClient();

  const first = await api.get("v1/users/me");
  expect(first.status(), `GET v1/users/me failed: ${await first.text()}`).toBe(200);
  expectMiss(first, "first GET v1/users/me through the gateway");

  const second = await api.get("v1/users/me");
  expect(second.status()).toBe(200);
  // The whole point: HIT *and* X-Cache-TTL both arrived intact after the JWT
  // authorizer, njs sub-extraction and nginx's catch-all `location /` proxy.
  expectHit(second, "second GET v1/users/me through the gateway", TTL.me);
});

// ## Why this one test retries, and why that is not papering over a flake
//
// `orders:products:v1` is the ONE cache key with no owner in it — a single
// shared catalogue entry for the whole service. Every `POST /v1/orders` in the
// suite decrements stock and therefore INVALIDATES it, and the gateway project
// runs specs that create orders (orders.spec.ts, tracking-flow.spec.ts,
// delivered-emails.spec.ts, and this file's own later tests). So a foreign
// order landing between this test's two reads legitimately turns the second one
// into a MISS.
//
// That is not a cache defect and not a race in the service — it is this test
// asserting exclusivity it does not have. Measured: the pair passes every time
// in isolation and failed once in a full `--project=gateway` run.
//
// The retry is BOUNDED and the assertion is NOT weakened: each attempt still
// demands a real MISS/HIT (or HIT/HIT) pair, and exhausting the attempts fails
// the test. Accepting "MISS then MISS" instead would have been the weakening —
// it would pass against a cache that never stores anything at all, which is
// precisely the vacuous green this milestone keeps producing.
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
    expectMissOrHit(first, `first GET v1/products through the gateway (attempt ${attempt})`);

    const second = await api.get("v1/products");
    expect(second.status()).toBe(200);
    lastSecond = cacheHeaderOf(second);
    if (lastSecond === "HIT") {
      // The real assertion, including the TTL bound.
      expectHit(second, "second GET v1/products through the gateway", TTL.products);
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
  const product = await firstProductWithStock(api);
  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `POST v1/orders failed: ${await created.text()}`).toBe(201);
  const orderId = (await created.json()).id as string;

  // ## The tracking window, and why the setup ends with a WRITE
  //
  // Orders declines to STORE a `t1` response whose tracking has not arrived yet
  // (TrackingCacheRules) — a tracking is created asynchronously, and freezing its
  // momentary absence into a 2-minute entry would serve a stale `tracking: null`
  // long after Tracking has the record. So a `t1` pair taken inside that window
  // MISSes twice, and the window has to be left before the pair is issued.
  //
  // The wait's own final read stores the entry, which would leave `t1` warm and
  // turn the pair into HIT/HIT. A `PUT v1/cart` sweeps the caller's whole key index
  // — broader than its name, it removes every my-orders and order-by-id entry too
  // (see CacheInvalidator) — returning all three keys below to genuinely cold
  // without disturbing the order or its tracking. Relaxing the MISS assertions
  // instead would pass against a cache that stores nothing at all.
  //
  // Polling BEFORE the pairs rather than between their reads is what keeps the
  // 2-minute TTL from biting, exactly as the tracking test below does.
  await waitForOrderTrackingReadable(api, `v1/orders/${orderId}?includeTracking=true`);
  await waitForMyOrdersTrackingReadable(api, "v1/orders/my-orders?includeTracking=true");
  const sweep = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(sweep.status(), `PUT v1/cart (cold-start sweep) failed: ${await sweep.text()}`).toBe(200);
  // Let Tracking's single dev-mode worker drain before the reads below burst at it,
  // or Orders' 2s read budget expires and the t1 MISS stores nothing — see
  // support/tracking-readiness.ts for the measurements behind this.
  await settleAfterTrackingBurst();

  // t0 — no wait of its own: it carries no tracking and caches unconditionally.
  expectMiss(await api.get("v1/orders/my-orders"), "first GET v1/orders/my-orders (t0)");
  expectHit(
    await api.get("v1/orders/my-orders"),
    "second GET v1/orders/my-orders (t0)",
    TTL.myOrders,
  );

  // t1 — a DIFFERENT key with a different body. Asserting a HIT here off the
  // warm t0 would be asserting a bug: it would only pass if the query
  // parameter were absent from the key.
  //
  // ## Why this pair retries, and why the assertion is NOT weakened
  //
  // Storing a `t1` entry requires Orders to actually HAVE the tracking, and Orders
  // fetches it from Tracking under a hard 2s budget
  // (`TrackingHttpClient.ReadTimeout`), degrading to `tracking: null` when it
  // overruns — which the cache then correctly declines to store, so the pair MISSes
  // twice. Tracking serves this batch route from a SINGLE uvicorn dev worker, and
  // measured during a full run of this file its latency is p50 1546ms but p90
  // 4792ms (max 6726ms): 11 of 29 reads overran the budget, purely because the rest
  // of the suite keeps that one worker busy. In isolation the same pair was
  // MISS→HIT 5 times out of 5.
  //
  // So this is the same hazard as the `v1/products` test above — a pair asserting
  // exclusivity over a shared resource it does not have — and it takes the same
  // remedy, already established in this file. Each attempt re-sweeps to get a
  // genuinely cold key and still demands a REAL MISS followed by a REAL HIT; only
  // a run of consecutive slow reads is retried. Accepting "MISS then MISS", or
  // relaxing either assertion to `/MISS|HIT/`, would be the weakening — it would
  // pass against a cache that stores nothing at all, which is exactly the vacuous
  // green this milestone keeps producing. Exhausting the attempts FAILS the test,
  // and the message names the service-side cause so it is not misread as a cache
  // defect.
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
      expectHit(second, "second GET v1/orders/my-orders?includeTracking=true", TTL.myOrders);
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
  expectMiss(await api.get(`v1/orders/${orderId}`), `first GET v1/orders/${orderId}`);
  expectHit(await api.get(`v1/orders/${orderId}`), `second GET v1/orders/${orderId}`, TTL.order);
});

// ## Tracking through the gateway
//
// Two things at once, and only the first is unique to this layer: that
// `X-Cache`/`X-Cache-TTL` survive the gateway and nginx's
// `location /v1/trackings` for BOTH tracking routes, and that the cache really
// serves a HIT through the full path.
//
// The gateway user is a real Cognito registration, so Users resolves its sub and
// the response key builds — see the note in tests/cache.spec.ts for why a caller
// Users cannot resolve would sit at MISS forever by design.
test("X-Cache survives the gateway on both Tracking read routes, and both serve a HIT", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);
  // No `x-test-mode`, so the tracking parks at PLACED and cannot advance —
  // and therefore cannot invalidate its own key — mid-test.
  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `POST v1/orders failed: ${await created.text()}`).toBe(201);
  const orderId = (await created.json()).id as string;

  // Tracking rows are created by ORDERS, asynchronously, after its transaction
  // commits — there is no gateway route to init-tracking for an end user. Poll
  // for the row FIRST (bounded, never unbounded), and only then assert. Polling
  // BEFORE the pair rather than between its two reads is what keeps the 60s TTL
  // from biting.
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

  // The successful poll already warmed the single-read key, so this is asserted
  // as a HIT rather than as a MISS/HIT pair — claiming the first read is cold
  // after polling would be writing an assertion the test itself made false.
  // A HIT is the STRONGER assertion anyway: it proves the header AND the TTL
  // survived the gateway, which a MISS could not.
  const single = await api.get(`v1/trackings/${orderId}`);
  expect(single.status()).toBe(200);
  expectHit(
    single,
    `GET v1/trackings/${orderId} through the gateway (warmed by the poll above). A MISS ` +
      "here with the internal spec green on :3002 would mean the gateway stripped the header",
    TTL.tracking,
  );

  // The batch read is a DIFFERENT key and a different nginx match (query string,
  // no path param), and the poll never touched it — so it is a genuine cold pair.
  expectMiss(
    await api.get(`v1/trackings?order_ids=${orderId}`),
    "first batch read through the gateway",
  );
  const batchWarm = await api.get(`v1/trackings?order_ids=${orderId}`);
  expect(batchWarm.status()).toBe(200);
  expectHit(batchWarm, "second batch read through the gateway", TTL.trackingList);
  // Envelope, not a bare array — verified live against the running service.
  expect(Array.isArray((await batchWarm.json()).trackings)).toBe(true);

  // The carrier route is declared `auth = false` at the gateway: no Bearer
  // token, only the API key. It must still reach the service through the full
  // path AND invalidate — a write, so it carries no cache header of its own.
  const carrier = await gatewayClient();
  const advanced = await carrier.put(`v1/trackings/${orderId}/status`, {
    headers: carrierHeaders(),
    data: { status: "PROCESSING" },
  });
  expect(advanced.status(), `carrier PUT failed: ${await advanced.text()}`).toBe(200);
  expectNoCacheHeaderOnWrite(advanced, "carrier PUT through the gateway");

  const after = await api.get(`v1/trackings/${orderId}`);
  expect(after.status()).toBe(200);
  expectMiss(after, "GET tracking after the carrier PUT, through the gateway");
  expect((await after.json()).status).toBe("PROCESSING");
});

// With CACHE_ENABLED=false there is NO X-Cache header at all — not MISS, not
// BYPASS, nothing. That absence is worth its own gateway assertion for the same
// reason the presence is: it is the observable difference between "the cache is
// off" and "the gateway stripped the header", and confusing those two is
// exactly the mistake this file exists to prevent.
//
// Guarded rather than skipped-by-default-forever: the ordinary suite runs with
// caching ON, where this test would legitimately fail. The A/B load run's OFF
// leg (see e2e/load-tests/README.md) is when it is meaningful, and
// `E2E_EXPECT_CACHE_DISABLED=1` is how the operator says so.
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
