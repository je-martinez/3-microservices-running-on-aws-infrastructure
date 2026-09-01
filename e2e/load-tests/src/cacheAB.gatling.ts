import {
  simulation,
  scenario,
  exec,
  nothingFor,
  rampUsers,
  constantUsersPerSec,
  global,
  details,
  getParameter,
} from "@gatling.io/core";
import { http } from "@gatling.io/http";
import { baseUrl, profile } from "./support/config.js";
import { seedIdentity, register, login } from "./scenarios/users.js";
import { listProducts, createOrder } from "./scenarios/orders.js";
import { putCart } from "./scenarios/cart.js";
import {
  readCartCold,
  readCartWarm,
  readMyOrdersCold,
  readMyOrdersWarm,
  readMyOrdersWithTrackingCold,
  readMyOrdersWithTrackingWarm,
  readOrderCold,
  readOrderWarm,
  readProductsCold,
  readProductsWarm,
  readProfileCold,
  readProfileWarm,
  readTrackingCold,
  readTrackingWarm,
  readTrackingsBatchCold,
  readTrackingsBatchWarm,
} from "./scenarios/cache.js";

/**
 * Cache A/B: same traffic profile run twice (CACHE_ENABLED on vs off via Makefile).
 *
 * CONTRACT: (cold)/(warm) request names split Gatling rows; identity hit-rate is separate.
 * Virtual users register normally; no x-e2e-source or x-test-mode.
 * See [[testing]]
 */
export default simulation((setUp) => {
  // Recorded into the run so the two HTML reports are distinguishable at a
  // glance rather than by their timestamps. Set by the Makefile targets.
  const leg = getParameter("leg", "unspecified");

  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    .userAgentHeader("3mrai-load-tests/0.1");

  // One virtual user: sign up, create the state each cached read needs, then
  // read every cached endpoint twice. Setup is done ONCE, up front, so the
  // cold/warm pairs are adjacent — the 60s cart and tracking TTLs make that
  // ordering load-bearing here for the same reason it is in the E2E specs.
  const reader = scenario(`Cache reader (${leg})`)
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    .pause(1)
    .exec(listProducts)
    .exec(createOrder)
    .exec(putCart)
    .pause(1)
    // Users.
    .exec(readProfileCold)
    .exec(readProfileWarm)
    // Orders — catalogue and cart.
    .exec(readProductsCold)
    .exec(readProductsWarm)
    .exec(readCartCold)
    .exec(readCartWarm)
    // Orders — both my-orders variants, separate keys, separate rows.
    .exec(readMyOrdersCold)
    .exec(readMyOrdersWarm)
    .exec(readMyOrdersWithTrackingCold)
    .exec(readMyOrdersWithTrackingWarm)
    // CONTRACT: session.get("orderId") != null — Gatling returns null for unset, not undefined.
    .doIf((session) => session.get("orderId") != null)
    .then(
      exec(readOrderCold)
        .exec(readOrderWarm)
        .exec(readTrackingCold)
        .exec(readTrackingWarm)
        .exec(readTrackingsBatchCold)
        .exec(readTrackingsBatchWarm),
    );

  setUp(
    reader.injectOpen(
      // Let the stack settle so startup noise is not attributed to the run.
      nothingFor(5),
      // Warm-up: cold connection pools and an unwarmed JIT make the first
      // seconds unrepresentative — and in an A/B that noise lands unevenly
      // across the two legs, which is worse than it being merely inaccurate.
      rampUsers(profile.rampUsers).during(profile.rampDuration),
      constantUsersPerSec(profile.usersPerSec).during(profile.duration),
    ),
  )
    .protocols(httpProtocol)
    .assertions(
      // Deliberately LOOSE, and deliberately not a latency budget. This
      // simulation's job is to MEASURE a difference between two runs, not to
      // gate one of them: a p95 threshold tuned for the cached leg would fail
      // the uncached leg by design and destroy the comparison. The only
      // assertion is that the traffic was actually healthy enough for its
      // numbers to mean anything.
      global().successfulRequests().percent().gt(99),
      // details() takes a stats PATH — the request name alone, never the
      // scenario name. Passing the scenario fails every run with "Could not
      // find stats matching assertion path".
      details("GET /v1/users/me (warm)").responseTime().percentile3().lt(5000),
    );
});
