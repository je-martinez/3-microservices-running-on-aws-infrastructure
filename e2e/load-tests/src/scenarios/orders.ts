import { exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

/**
 * The Orders journey: browse the catalogue → create an order → read it back.
 *
 * Shapes come from services/orders/openapi.yaml: CreateOrderRequest is
 * `{ lines: [{ productId, quantity }] }`. Guessing here would produce 400s that
 * read as a service defect in the dashboards.
 *
 * Every request needs the caller's token, so these steps assume a session that
 * already ran the Users login — the journeys compose rather than each
 * registering their own user.
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/**
 * List the catalogue and keep a RANDOM product id.
 *
 * Random rather than `[0]`, and this was measured rather than assumed: pinning
 * every virtual user to the first product drained its stock and produced a
 * `409 insufficient_stock` under a load this small. Spreading across the
 * catalogue both models real shopping and keeps the failure out of the results.
 *
 * `.random()` on the jsonPath check is what does it — the SDK picks one match
 * per virtual user rather than always the first.
 */
export const listProducts = exec(
  http("GET /v1/products")
    .get("v1/products")
    .header("Authorization", authHeader)
    .check(status().is(200), jsonPath("$[*].id").findRandom().saveAs("productId")),
);

/**
 * Create an order for one unit of that product.
 *
 * Accepts 201 **or 409**, and that is a deliberate modelling decision rather
 * than a loosened assertion. Order creation locks each product row `FOR UPDATE`
 * to decrement stock, so concurrent buyers picking the same product genuinely
 * contend — under load a share of them lose the race and get
 * `409 insufficient_stock`. Measured here: with the catalogue holding 20-98
 * units per item, roughly 1% of creates 409 at only 0.5 users/sec.
 *
 * Asserting 201 only would paint the run red for the system behaving exactly as
 * designed, and would hide a real regression behind an expected failure. The
 * 409s remain visible in the report and in `http_errors_total`, which is where
 * a rising contention rate should be read.
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
