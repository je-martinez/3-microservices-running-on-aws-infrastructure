import { exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

/**
 * The Orders journey: browse the catalogue → create an order → read it back. Shapes
 * come from services/orders/openapi.yaml (`{ lines: [{ productId, quantity }] }`);
 * guessing produces 400s that read as a service defect in the dashboards. Steps assume
 * a session that already ran the Users login — the journeys compose.
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/**
 * CONTRACT: Keep a RANDOM product id, never `[0]`. Pinning every virtual user to the
 * first product drains its stock and yields `409 insufficient_stock` under even a small
 * load. `.random()` on the jsonPath check is what spreads them across the catalogue.
 */
export const listProducts = exec(
  http("GET /v1/products")
    .get("v1/products")
    .header("Authorization", authHeader)
    .check(
      status().is(200),
      jsonPath("$[*].id").findRandom().saveAs("productId"),
      // Three DISTINCT ids for the multi-line order below. findRandom(n) draws
      // without replacement, which matters: the same product twice in one order
      // is a different code path (and a 400 in some services), not the
      // multi-line case this is meant to exercise.
      jsonPath("$[*].id").findRandom(3).saveAs("productIds"),
    ),
);

/**
 * CONTRACT: Accept 201 OR 409 — modelling, not a loosened assertion. Creation locks
 * each product row `FOR UPDATE`, so concurrent buyers contend and ~1% of creates 409
 * at only 0.5 users/sec. Asserting 201 only paints the run red for the system working
 * as designed; the 409s stay visible in `http_errors_total`.
 */
export const createOrder = exec(
  http("POST /v1/orders")
    .post("v1/orders")
    .header("Authorization", authHeader)
    .body(
      StringBody((session) =>
        JSON.stringify({
          lines: [{ productId: session.get("productId"), quantity: 1 }],
        }),
      ),
    )
    .asJson()
    .check(
      status().in(201, 409),
      // Only present on a 201 — `optional()` keeps a 409 from failing the check.
      jsonPath("$.id").optional().saveAs("orderId"),
    ),
);

/**
 * A basket: three different products, varying quantities. A genuinely different path —
 * creation locks EVERY line's product row `FOR UPDATE` in one transaction, so this
 * holds three locks at once and exercises subtotal arithmetic a one-line order never
 * does. Accepts 409 for the same reason, and more so: three chances to lose the race.
 */
export const createMultiLineOrder = exec(
  http("POST /v1/orders (multi-line)")
    .post("v1/orders")
    .header("Authorization", authHeader)
    .body(
      StringBody((session) => {
        const ids = session.get("productIds") as string[];
        return JSON.stringify({
          lines: ids.map((productId, i) => ({
            productId,
            // 1, 2, 3 — a mix rather than a uniform quantity, so the subtotal
            // arithmetic is actually exercised.
            quantity: i + 1,
          })),
        });
      }),
    )
    .asJson()
    .check(
      status().in(201, 409),
      jsonPath("$.id").optional().saveAs("orderId"),
    ),
);

/** The caller's own orders — the read a user actually performs most often. */
export const listMyOrders = exec(
  http("GET /v1/orders/my-orders")
    .get("v1/orders/my-orders")
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/**
 * The same read with tracking joined in.
 *
 * Worth exercising separately: it fans out to Tracking's batch endpoint, so it
 * is the one read whose cost depends on another service being healthy.
 */
export const listMyOrdersWithTracking = exec(
  http("GET /v1/orders/my-orders?includeTracking=true")
    .get("v1/orders/my-orders")
    .queryParam("includeTracking", "true")
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/** Read one order by id. */
export const readOrder = exec(
  http("GET /v1/orders/{id}")
    .get((session) => `v1/orders/${session.get("orderId")}`)
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/** A 404 on purpose — an id that cannot exist, for the error panels. */
export const readMissingOrder = exec(
  http("GET /v1/orders/{id} (missing)")
    .get("v1/orders/ord_doesnotexist000")
    .header("Authorization", authHeader)
    .check(status().is(404)),
);
