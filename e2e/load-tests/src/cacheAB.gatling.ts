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
 * The cache A/B: the SAME traffic profile, run twice.
 *
 *   # leg A — caching on
 *   make load-test-cache-ab-on
 *   # leg B — caching off
 *   make load-test-cache-ab-off
 *
 * The comparison is made between the two HTML reports, per request name. This
 * simulation deliberately does NOT try to run both legs itself: `CACHE_ENABLED`
 * is a service-level environment variable read at process start, so flipping it
 * mid-run is impossible without restarting the services — and a restart inside a
 * measurement window would poison both halves of the result with cold pools and
 * an unwarmed JIT.
 *
 * ## What the request-name split buys
 *
 * Every cached endpoint appears as TWO rows, `(cold)` and `(warm)`. Gatling
 * reports p50/p95/p99 per request name, so the `(warm)` row IS the cached-read
 * latency and the `(cold)` row is the database read. On the OFF leg both rows
 * are database reads and should converge — that convergence is itself a check
 * that the A/B was actually performed rather than the same leg run twice.
 *
 * ## The identity-cache hit-rate is reported SEPARATELY, and that is mandatory
 *
 * `identity:sub-to-user:v1:{cognito_sub}` has a 1h TTL over an effectively
 * immutable mapping, so its hit-rate sits near 100%. Averaging it into the
 * response-cache hit-rates would drag every response prefix's number toward
 * 100% and make BOTH figures meaningless — the design spec says so explicitly.
 * It is therefore NOT visible in this simulation's own report at all (the
 * simulation only ever sees the response cache's X-Cache header): it is read
 * from OpenObserve, per KeyPrefix, using the query in
 * e2e/load-tests/README.md. Do not add an averaged "overall cache hit rate"
 * row here.
 *
 * ## Every virtual user must be resolvable by Users, or Tracking measures nothing
 *
 * Tracking's response key embeds the internal `usr_` id, resolved from the
 * `cognito_sub` over gRPC. A caller Users cannot resolve gets NO key at all —
 * by design — and reads MISS forever, which would look like a broken cache in
 * the report. These virtual users register through the normal flow, so they are
 * resolvable by construction. Do not swap that for a fixed or seeded sub.
 *
 * ## No x-e2e-source, no x-test-mode
 *
 * Same as every other simulation here (e2e/CLAUDE.md §4): the data persists like
 * real data, and a tracking only moves through the carrier webhook. This
 * simulation does not drive deliveries at all — it measures reads.
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
    // Everything below needs an orderId. `createOrder` accepts 201 OR 409 —
    // order creation locks the product row FOR UPDATE, so concurrent buyers
    // genuinely contend — and a 409 saves no id. `!= null` (loose), NOT
    // `!== undefined`: Gatling's Session.get returns **null** for an unset
    // attribute, so a strict check never blocks and the guard is inert. That
    // exact bug shipped in fullJourney and sent hundreds of requests to
    // `/v1/orders/null`.
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
