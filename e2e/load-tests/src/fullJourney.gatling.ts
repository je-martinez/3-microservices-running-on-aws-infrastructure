import {
  simulation,
  scenario,
  exec,
  nothingFor,
  rampUsers,
  constantUsersPerSec,
  percent,
  global,
  details,
} from "@gatling.io/core";
import { http } from "@gatling.io/http";
import { baseUrl, profile } from "./support/config.js";
import {
  seedIdentity,
  register,
  login,
  refreshToken,
  changePassword,
  readProfile,
  updateProfile,
  unauthorizedProfileRead,
} from "./scenarios/users.js";
import {
  listProducts,
  createOrder,
  createMultiLineOrder,
  listMyOrders,
  listMyOrdersWithTracking,
  readOrder,
  readMissingOrder,
} from "./scenarios/orders.js";
import {
  readTracking,
  readTrackingsBatch,
  driveDeliveryToCompletion,
  rejectedTransition,
} from "./scenarios/tracking.js";

/**
 * The whole system under load: users, orders, products and tracking.
 *
 *   npx gatling run --typescript --simulation fullJourney
 *   npx gatling run --typescript --simulation fullJourney usersPerSec=5 duration=600
 *
 * Three populations run together rather than one uniform journey, because real
 * traffic is not uniform: most sessions browse, fewer buy, and deliveries are
 * driven by a carrier on its own schedule. A single averaged scenario would
 * produce a flat, unrealistic shape in every panel.
 */
export default simulation((setUp) => {
  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    .userAgentHeader("3mrai-load-tests/0.1");

  // The full purchase path: sign up, shop, buy, then watch the delivery move.
  const buyer = scenario("Buyer journey")
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    .pause(1)
    .exec(readProfile)
    .exec(updateProfile)
    // A real client refreshes its access token as it expires; under sustained
    // load this is one of the busiest auth endpoints.
    .exec(refreshToken)
    .pause(2)
    .exec(listProducts)
    .pause(2)
    // Most baskets hold one item; a third are multi-line. Modelling the split
    // rather than picking one keeps both code paths under load — the multi-line
    // order locks three product rows in a single transaction.
    .randomSwitch()
    .on(
      percent(70).then(createOrder),
      percent(30).then(createMultiLineOrder),
    )
    .pause(1)
    .exec(listMyOrders)
    // Everything below needs an order id, and a create that lost the stock race
    // (409) never set one. Guarding here keeps ONE contention event from
    // cascading into five derived failures that would misreport the run —
    // the 409 itself is already visible in the report and in http_errors_total.
    .doIf((session) => session.get("orderId") !== undefined)
    .then(
      exec(readOrder)
        .pause(1)
        // No x-test-mode, so nothing advances on its own — the carrier does it.
        .exec(driveDeliveryToCompletion)
        .pause(1)
        .exec(readTracking)
        .exec(readTrackingsBatch)
        .exec(listMyOrdersWithTracking),
    );

  // Browsers outnumber buyers: sign in, look around, leave without ordering.
  const browser = scenario("Browser journey")
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    .pause(1)
    .exec(listProducts)
    .pause(2)
    .exec(listMyOrders)
    .exec(readProfile)
    // Authenticated password change — no email, no code, unlike the reset flow.
    .exec(changePassword);

  // Deliberate failures, so the error panels have a shape. Each is checked for
  // the status it should return, so they count as successful requests here —
  // the global assertion below is about unexpected failures.
  const errors = scenario("Error traffic")
    .exec(unauthorizedProfileRead)
    .pause(1)
    .exec(seedIdentity)
    .exec(register)
    .exec(login)
    .exec(readMissingOrder)
    .exec(rejectedTransition);

  setUp(
    buyer.injectOpen(
      nothingFor(5),
      rampUsers(profile.rampUsers).during(profile.rampDuration),
      constantUsersPerSec(profile.usersPerSec).during(profile.duration),
    ),
    browser.injectOpen(
      nothingFor(5),
      // Roughly three browsers per buyer — the usual shape of retail traffic.
      constantUsersPerSec(profile.usersPerSec * 3).during(profile.duration),
    ),
    errors.injectOpen(constantUsersPerSec(0.2).during(profile.duration)),
  )
    .protocols(httpProtocol)
    .assertions(
      global().successfulRequests().percent().gt(99),
      // details() takes a stats path — the request name, never the scenario.
      details("POST /v1/orders").responseTime().percentile3().lt(5000),
      details("GET /v1/products").responseTime().percentile3().lt(3000),
    );
});
