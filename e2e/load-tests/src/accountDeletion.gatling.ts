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
 * Account deletion cascade under concurrency (Users + Orders + Tracking + Cognito).
 * WHY: Modest usersPerSec — destructive users, Floci Cognito limits, no cleanup.
 */
export default simulation((setUp) => {
  // CONTRACT: Do NOT set protocol-level Content-Type: application/json — Fastify
  // rejects DELETE with no body (FST_ERR_CTP_EMPTY_JSON_BODY). Per-request .asJson()
  // on body-carrying steps only; empty header override sends 415 instead.
  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    // Indistinguishable from a real client in the logs — no E2E marker.
    .userAgentHeader("3mrai-load-tests/0.1");

  /** Departing user: register, order (cascade data), delete. */
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

  /** Bystander read traffic at 2× rate — control for pool contention during deletes. */
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
