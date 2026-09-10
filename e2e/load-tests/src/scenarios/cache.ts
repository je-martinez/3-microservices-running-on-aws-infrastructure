import { exec } from "@gatling.io/core";
import { header, http, status } from "@gatling.io/http";

/**
 * Cache-focused read steps for the A/B simulation.
 *
 * CONTRACT: Read each cached endpoint TWICE under DIFFERENT request names, `(cold)` and
 * `(warm)`. Gatling reports percentiles per request name, so `(warm)` carries the
 * cache's effect; one averaged row blends a database read and a Redis read together.
 * CONTRACT: Keep the X-Cache check `.optional()`. The `CACHE_ENABLED=false` leg sends no
 * header and a BYPASS is legitimate on the ON leg, so a REQUIRED check fails the run for
 * exactly the condition being measured and makes the control leg unrunnable.
 * CONTRACT: Send neither `x-e2e-source` nor `x-test-mode` — this data persists like real
 * data and a tracking advances only through the carrier webhook. See [[testing]]
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/** Saves the X-Cache outcome into the session so a hit-rate can be tallied. */
const captureCache = (attribute: string) =>
  header("X-Cache").optional().saveAs(attribute);

/** The catalogue — the highest read/write ratio in the repo, 10-minute TTL. */
export const readProductsCold = exec(
  http("GET /v1/products (cold)")
    .get("v1/products")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheProductsCold")),
);

export const readProductsWarm = exec(
  http("GET /v1/products (warm)")
    .get("v1/products")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheProductsWarm")),
);

/** The profile — 5-minute TTL, and the one Users endpoint that is cached. */
export const readProfileCold = exec(
  http("GET /v1/users/me (cold)")
    .get("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheMeCold")),
);

export const readProfileWarm = exec(
  http("GET /v1/users/me (warm)")
    .get("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheMeWarm")),
);

/** The cart — 60s TTL, the busiest cart operation under real use. */
export const readCartCold = exec(
  http("GET /v1/cart (cold)")
    .get("v1/cart")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheCartCold")),
);

export const readCartWarm = exec(
  http("GET /v1/cart (warm)")
    .get("v1/cart")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheCartWarm")),
);

/** my-orders, t0 — the default variant. */
export const readMyOrdersCold = exec(
  http("GET /v1/orders/my-orders (cold)")
    .get("v1/orders/my-orders")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheMyOrdersCold")),
);

export const readMyOrdersWarm = exec(
  http("GET /v1/orders/my-orders (warm)")
    .get("v1/orders/my-orders")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheMyOrdersWarm")),
);

/**
 * my-orders, t1 — a SEPARATE cache key and a different body. Kept as its own request
 * pair: it fans out to Tracking's batch endpoint on a miss, so its cold cost is
 * structurally higher and averaging the variants would understate the very saving this
 * simulation measures.
 */
export const readMyOrdersWithTrackingCold = exec(
  http("GET /v1/orders/my-orders?includeTracking=true (cold)")
    .get("v1/orders/my-orders")
    .queryParam("includeTracking", "true")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheMyOrdersTrackingCold")),
);

export const readMyOrdersWithTrackingWarm = exec(
  http("GET /v1/orders/my-orders?includeTracking=true (warm)")
    .get("v1/orders/my-orders")
    .queryParam("includeTracking", "true")
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheMyOrdersTrackingWarm")),
);

/** One order by id — 2-minute TTL. Guarded by the caller: needs an orderId. */
export const readOrderCold = exec(
  http("GET /v1/orders/{id} (cold)")
    .get((session) => `v1/orders/${session.get("orderId")}`)
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheOrderCold")),
);

export const readOrderWarm = exec(
  http("GET /v1/orders/{id} (warm)")
    .get((session) => `v1/orders/${session.get("orderId")}`)
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheOrderWarm")),
);

/**
 * One tracking by order id — 60s TTL. Accepts 200 OR 404, because Orders calls
 * init-tracking asynchronously after its transaction commits and a read can
 * legitimately arrive first. A 404 is never cached and carries no `X-Cache`, so it
 * contributes nothing to the hit-rate; the denominator is the 200s.
 */
export const readTrackingCold = exec(
  http("GET /v1/trackings/{orderId} (cold)")
    .get((session) => `v1/trackings/${session.get("orderId")}`)
    .header("Authorization", authHeader)
    .check(status().in(200, 404), captureCache("cacheTrackingCold")),
);

export const readTrackingWarm = exec(
  http("GET /v1/trackings/{orderId} (warm)")
    .get((session) => `v1/trackings/${session.get("orderId")}`)
    .header("Authorization", authHeader)
    .check(status().in(200, 404), captureCache("cacheTrackingWarm")),
);

/** The batch read — 60s TTL, key is hash(sorted, deduped order_ids). */
export const readTrackingsBatchCold = exec(
  http("GET /v1/trackings?order_ids= (cold)")
    .get("v1/trackings")
    .queryParam("order_ids", (session: { get: (k: string) => unknown }) =>
      `${session.get("orderId")}`,
    )
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheTrackingsBatchCold")),
);

export const readTrackingsBatchWarm = exec(
  http("GET /v1/trackings?order_ids= (warm)")
    .get("v1/trackings")
    .queryParam("order_ids", (session: { get: (k: string) => unknown }) =>
      `${session.get("orderId")}`,
    )
    .header("Authorization", authHeader)
    .check(status().is(200), captureCache("cacheTrackingsBatchWarm")),
);
