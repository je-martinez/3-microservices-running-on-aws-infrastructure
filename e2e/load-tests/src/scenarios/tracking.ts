import { exec, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";
import { carrierApiKey } from "../support/config.js";

/**
 * Tracking: the user's own reads, plus the carrier webhook that moves a delivery
 * forward.
 *
 * CONTRACT: Send NO `x-test-mode` here. Omitting it means a tracking reaches DELIVERED
 * only the way a real carrier does — PUT /v1/trackings/{orderId}/status, authenticated
 * with the carrier API key.
 * CONTRACT: The carrier key is a DIFFERENT secret from the internal gRPC key, issued to
 * an outside vendor. Never substitute one for the other. See [[testing]]
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/** The user-scoped read: one tracking by order id. */
export const readTracking = exec(
  http("GET /v1/trackings/{orderId}")
    .get((session) => `v1/trackings/${session.get("orderId")}`)
    .header("Authorization", authHeader)
    .check(status().in(200, 404)),
);

/**
 * The batch read, using the one id the session holds — repeating the same id would be
 * pointless, and the shape (`?order_ids=<csv>`) is what matters for the route to
 * register in the dashboards.
 */
export const readTrackingsBatch = exec(
  http("GET /v1/trackings?order_ids=")
    .get("v1/trackings")
    .queryParam(
      "order_ids",
      (session: { get: (k: string) => unknown }) => `${session.get("orderId")}`,
    )
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/**
 * One carrier status update. The state machine is forward-only and DELIVERED terminal,
 * so an out-of-order transition is rejected with 400 — expected under load, not a
 * defect, hence `in(200, 400, 404)`. Asserting 200 only would paint the run red for
 * behaving exactly as designed.
 */
const advanceTo = (newStatus: string) =>
  exec(
    http(`PUT /v1/trackings/{orderId}/status (${newStatus})`)
      .put((session) => `v1/trackings/${session.get("orderId")}/status`)
      // The carrier authenticates with its own key and receives NO x-user-id —
      // it has no user identity at all.
      .header("x-api-key", carrierApiKey())
      .body(StringBody(JSON.stringify({ status: newStatus })))
      .asJson()
      .check(status().in(200, 400, 404)),
  );

/** Walk a delivery the whole way, as a carrier would over hours. */
export const driveDeliveryToCompletion = exec(
  advanceTo("PROCESSING"),
  advanceTo("SHIPPED"),
  advanceTo("OUT_FOR_DELIVERY"),
  advanceTo("DELIVERED"),
);

/** A rejected transition on purpose: DELIVERED is terminal, so this 400s. */
export const rejectedTransition = exec(
  http("PUT /v1/trackings/{orderId}/status (after DELIVERED)")
    .put((session) => `v1/trackings/${session.get("orderId")}/status`)
    .header("x-api-key", carrierApiKey())
    .body(StringBody(JSON.stringify({ status: "PLACED" })))
    .asJson()
    .check(status().in(400, 404)),
);
