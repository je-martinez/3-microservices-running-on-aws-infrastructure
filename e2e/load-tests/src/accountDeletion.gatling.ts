import {
  simulation,
  scenario,
  nothingFor,
  rampUsers,
  constantUsersPerSec,
  global,
  details,
} from "@gatling.io/core";
import { http } from "@gatling.io/http";
import { baseUrl, profile } from "./support/config.js";
import { seedIdentity, register, login, readProfile } from "./scenarios/users.js";
import { listProducts, createOrder } from "./scenarios/orders.js";
import {
  deleteAccount,
  readProfileAfterDeletion,
  deleteAccountAgain,
} from "./scenarios/account-deletion.js";

/**
 * Account deletion under sustained concurrency.
 *
 *   pnpm run delete-account
 *   pnpm exec gatling run --typescript --simulation accountDeletion \
 *     usersPerSec=2 duration=180
 *
 * ## What this measures, and what it deliberately does not
 *
 * NOT throughput. Account deletion is a low-frequency, destructive, terminal
 * operation — a person performs it once, if ever, and no realistic system sees a
 * sustained deletion rate. Injecting hundreds per second would measure a traffic
 * pattern that cannot occur and would fill the dashboards with a shape nobody
 * should ever read as normal.
 *
 * What it measures is the CASCADE's cost under concurrency. `DELETE /v1/users/me`
 * is the only user-facing request in 3MRAI that synchronously fans out to two
 * other services and an external identity provider before it answers (see
 * `scenarios/account-deletion.ts` for the four legs). Three things about that are
 * only observable under load:
 *
 *   - **The tail is a sum, not a max.** Four sequential dependencies means the
 *     p95 compounds; each leg can look healthy while the whole is not.
 *   - **The cascade legs are WRITES on two databases**, competing with the same
 *     services' ordinary read traffic for connections. A pool starved by the
 *     cascade shows up as slower ORDER reads, not as a slower delete — which is
 *     why this simulation keeps a small population of ordinary buyers running
 *     alongside (below), rather than measuring deletions in isolation.
 *   - **Cognito is in the request path.** `AdminDeleteUser` is the one leg we do
 *     not own; it is the likeliest source of a fat tail and, unlike the others,
 *     it will not appear in our own service latency.
 *
 * ## Why the injection profile is deliberately modest
 *
 * `usersPerSec` defaults to **1** and the ramp to 5, against `fullJourney`'s
 * larger populations. Three reasons, in order of how much they cost if ignored:
 *
 *   1. **Every virtual user here is destructive and single-use.** It registers,
 *      buys, and then permanently removes itself along with its data. There is no
 *      steady-state population to reach — raising the rate just burns accounts
 *      faster, it does not find a different regime.
 *   2. **Each user costs a Cognito CREATE and a Cognito DELETE** on the local
 *      Floci emulator, which is not a performance-engineered service. Past some
 *      rate the emulator, not our cascade, becomes the bottleneck, and the run
 *      then measures Floci. The numbers would still print, which is what makes
 *      this worth stating rather than discovering.
 *   3. **Nothing cleans this up.** Load data carries no `x-e2e-source` on purpose
 *      (see the README), so every run leaves orphaned Cognito users behind. A
 *      modest rate keeps that bounded.
 *
 * Raise it deliberately, with the CLI parameter, when the question is
 * specifically "where does the cascade break?" — and read the result knowing
 * points 2 and 3.
 */
export default simulation((setUp) => {
  // ## No protocol-level `.contentTypeHeader(...)`, unlike the other simulations
  //
  // The others set it, which stamps `Content-Type: application/json` onto EVERY
  // request — including body-less ones. That is harmless for the requests they
  // make and fatal for this one: Users runs Fastify, whose content-type parser
  // rejects a JSON content-type with no body outright, and `DELETE /v1/users/me`
  // sends no body. Measured, not reasoned about — the first run of this
  // simulation had **100% of deletions fail**:
  //
  //     400 FST_ERR_CTP_EMPTY_JSON_BODY
  //     "Body cannot be empty when content-type is set to 'application/json'"
  //
  // The obvious repair — overriding the header per-request with `""` — does NOT
  // work and is worth recording so nobody retries it: Gatling sends the empty
  // value as a literal empty `Content-Type`, and the 400 simply became a **415
  // Unsupported Media Type** (second measured run, same 100% failure). There is
  // no per-request "unset this header" in the SDK; the only fix is not to set it
  // at the protocol level.
  //
  // Dropping it costs nothing, because it was redundant: every body-carrying
  // step in `scenarios/` already calls `.asJson()`, which sets the content-type
  // on that request itself. Verified — register, login and order creation all
  // still return 201/200 under this protocol.
  //
  // A real client behaves the same way: browser `fetch`, `curl -X DELETE` and
  // every HTTP library omit the header when there is no body. So the 400 was an
  // artefact of the harness, not a defect a user can reach — but the ASYMMETRY it
  // exposed is real and is reported with this work: Orders (.NET) answers 204 to
  // the identical header-without-body request that Users 400s.
  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    // Indistinguishable from a real client in the logs — no E2E marker.
    .userAgentHeader("3mrai-load-tests/0.1");

  /**
   * The subject: a user who signs up, places one order (so the cascade has
   * something on BOTH downstream services to sweep), then deletes themselves.
   *
   * The order is not decoration. A deletion with nothing to cascade is a cheap
   * request that measures almost nothing — the two `by-user` calls return
   * `deleted: 0` after touching no rows, and the fan-out cost this simulation
   * exists to measure disappears. Every virtual user must own data at the moment
   * it deletes itself, or the run is green and meaningless.
   */
  const departingUser = scenario("Departing user")
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    .pause(1)
    .exec(listProducts)
    .exec(createOrder)
    // Think time before the destructive act — a real person confirms a dialog.
    // It also spaces the deletion away from the order's own write, so the two
    // are not artificially contending within a single virtual user.
    .pause(2)
    .exec(deleteAccount)
    .exec(readProfileAfterDeletion)
    .exec(deleteAccountAgain);

  /**
   * Ordinary traffic running CONCURRENTLY with the deletions.
   *
   * This is what turns the run from a latency measurement into a contention
   * measurement. The cascade issues write transactions against Orders' and
   * Tracking's MySQL while these users are reading from the same pools; whether
   * the deletions degrade ordinary browsing is a question that cannot be asked by
   * a simulation containing only deletions.
   *
   * Kept read-heavy and cheap on purpose: it is the CONTROL, not the subject. Its
   * latency is what should stay flat.
   */
  const bystander = scenario("Bystander traffic")
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    .pause(1)
    .exec(listProducts)
    .pause(1)
    .exec(readProfile);

  setUp(
    departingUser.injectOpen(
      // Let the stack settle so startup noise is not attributed to the run.
      nothingFor(5),
      // Warm-up: cold pools and an unwarmed JIT make the first seconds
      // unrepresentative, and with a request this expensive they would drag the
      // percentiles noticeably.
      rampUsers(profile.rampUsers).during(profile.rampDuration),
      constantUsersPerSec(profile.usersPerSec).during(profile.duration),
    ),
    // Twice the deletion rate: enough of a control population for its own
    // percentiles to be readable, without making the run about browsing.
    bystander.injectOpen(
      nothingFor(5),
      constantUsersPerSec(profile.usersPerSec * 2).during(profile.duration),
    ),
  )
    .protocols(httpProtocol)
    .assertions(
      global().successfulRequests().percent().gt(99),
      // The headline budget. 8s is generous ON PURPOSE and is not a target: it
      // is four sequential dependencies including an external IdP, so a budget
      // tight enough to be aspirational would fail the run on the local
      // emulator's variance rather than on a regression. It exists to catch the
      // cascade going badly wrong (a leg retrying, a pool exhausted), not to
      // certify a number.
      details("DELETE /v1/users/me").responseTime().percentile3().lt(8000),
      // The CONTROL assertion, and arguably the more informative of the two: if
      // ordinary catalogue reads slow down while deletions run, the cascade is
      // taking resources from the rest of the system. That is the regression
      // this simulation is most likely to catch, and it would be invisible in
      // the delete's own latency.
      details("GET /v1/products").responseTime().percentile3().lt(3000),
      // details() takes a stats PATH — the REQUEST name, never the scenario
      // name. `details("Departing user", "DELETE /v1/users/me")` type-checks
      // (the signature is variadic) and then fails EVERY run with "Could not
      // find stats matching assertion path".
      details("GET /v1/users/me (after deletion)").responseTime().percentile3().lt(3000),
    );
});
