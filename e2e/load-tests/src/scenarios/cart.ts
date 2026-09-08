import { exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

/**
 * The Cart journey: build a cart, read it, update it, tear it down. Shapes come from
 * services/orders/openapi.yaml — `{ items: [{ productId, quantity }] }`, camelCase
 * throughout; guessing produces 400s that read as a service defect. Steps assume a
 * session that already ran the Users login and Orders' `listProducts`.
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/**
 * Build a cart with one line, from the product id `listProducts` saved. A write with a
 * transaction and a unique-index insert (one active cart per caller), worth measuring
 * on its own rather than only through the purchase journey.
 */
export const putCart = exec(
  http("PUT /v1/cart")
    .put("v1/cart")
    .header("Authorization", authHeader)
    .body(
      StringBody((session) =>
        JSON.stringify({
          items: [{ productId: session.get("productId"), quantity: 1 }],
        }),
      ),
    )
    .asJson()
    .check(status().is(200), jsonPath("$.id").saveAs("cartId")),
);

/**
 * Read the cart back — the busiest cart operation by far, since page loads and badge
 * refreshes outnumber writes. Each read costs a catalogue query (every line is
 * re-priced and re-checked against current product rows), which is the new load
 * pattern the cart introduces and the main thing worth measuring.
 */
export const getCart = exec(
  http("GET /v1/cart")
    .get("v1/cart")
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/**
 * Replace the line set on an existing cart with a different quantity — the sync path
 * (insert/update/soft-delete of lines) rather than creation, since a cart already
 * exists for this caller and the PUT reconciles against it.
 */
export const updateCartQuantity = exec(
  http("PUT /v1/cart (update quantity)")
    .put("v1/cart")
    .header("Authorization", authHeader)
    .body(
      StringBody((session) =>
        JSON.stringify({
          items: [{ productId: session.get("productId"), quantity: 3 }],
        }),
      ),
    )
    .asJson()
    .check(status().is(200)),
);

/**
 * Delete the cart.
 *
 * Cheap, but it exercises the shared deletion path — the same one an
 * items: [] PUT and an order-consuming-the-cart flow both go through.
 */
export const deleteCart = exec(
  http("DELETE /v1/cart")
    .delete("v1/cart")
    .header("Authorization", authHeader)
    .check(status().is(204)),
);
