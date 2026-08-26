import { exec } from "@gatling.io/core";
import { header, http, status } from "@gatling.io/http";

/**
 * Cache-focused read steps for the A/B simulation.
 *
 * Each cached endpoint is read TWICE per virtual user, under two DIFFERENT
 * request names — `(cold)` and `(warm)`. That split is the whole measurement:
 * Gatling reports percentiles per request name, so `(warm)` is the row that
 * carries the cache's actual effect, while a single averaged row would blend a
 * database read and a Redis read into one meaningless number.
 *
 * The X-Cache header is captured with `header("X-Cache")` — verified present in
 * the installed SDK at `@gatling.io/http/target/checks.d.ts:48`
 * (`export declare const header: HeaderFunction`), NOT in `@gatling.io/core`
 * where `jsonPath` lives. The chain `header(...).optional().saveAs(...)` is
 * likewise verified against the type definitions: `optional()` is declared on
 * `CheckBuilderValidate` (core/target/checks/validate.d.ts:125) and returns a
 * `CheckBuilderFinal`, which is where `saveAs` lives
 * (core/target/checks/final.d.ts:29).
 *
 * `.optional()` matters twice over: on the `CACHE_ENABLED=false` leg of the A/B
 * there is no header at all, and on the ON leg a BYPASS is a legitimate (if
 * unwanted) outcome. A REQUIRED check would fail the entire run for precisely
 * the condition being measured — which would make the control leg unrunnable
 * and destroy the comparison.
 *
 * Header NAME is sent as `X-Cache` here, and the lookup is case-insensitive on
 * Gatling's side. Worth stating because the services genuinely disagree on the
 * spelling they emit — Orders sends `X-Cache`, Users and Tracking send
 * `x-cache` — so anything doing its own case-sensitive comparison would silently
 * capture half the traffic.
 *
 * ## Deliberately NO x-e2e-source and NO x-test-mode
 *
 * Per e2e/CLAUDE.md §4: this data persists like real data (nothing cleans it
 * up — reset with `make clean && make bootstrap`), and a tracking only advances
 * through the carrier webhook, the way a real carrier moves one.
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
 * my-orders, t1 — a SEPARATE cache key and a different body.
 *
 * Kept as its own request pair rather than folded into the t0 rows: it fans out
 * to Tracking's batch endpoint on a miss, so its cold cost is structurally
 * higher and averaging the two variants would understate exactly the saving
 * this simulation exists to measure.
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
 * One tracking by order id — 60s TTL.
 *
 * Accepts 200 OR 404: Orders calls init-tracking asynchronously after its
 * transaction commits, so under load a read can legitimately arrive first.
 * Asserting 200 only would paint the run red for a race that is by design.
 *
 * > **Note:** a 404 is never cached and carries NO `X-Cache` header, so the 404s
 * > in this row contribute nothing to its hit-rate — the denominator is the 200s.
 * > Separately, a caller whose `cognito_sub` Users cannot resolve gets no cache
 * > key at all (by design), and reads MISS forever. These virtual users register
 * > through the normal flow, so they are always resolvable.
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
