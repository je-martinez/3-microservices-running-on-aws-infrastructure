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
import {
  seedIdentity,
  register,
  login,
  readProfile,
  updateProfile,
  unauthorizedProfileRead,
} from "./scenarios/users.js";

/**
 * Users traffic: register → login → read profile → update profile, plus a
 * deliberate 401.
 *
 *   npx gatling run --typescript --simulation usersJourney
 *   npx gatling run --typescript --simulation usersJourney usersPerSec=5 duration=300
 */
export default simulation((setUp) => {
  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    // A plain client user-agent, not an E2E marker: this traffic is meant to be
    // indistinguishable from a real client in the logs.
    .userAgentHeader("3mrai-load-tests/0.1");

  const journey = scenario("Users journey")
    // exec() takes a session function OR request builders, never both in one
    // call — hence the chain rather than a single exec(...).
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    .pause(1)
    .exec(readProfile)
    .pause(2)
    .exec(updateProfile)
    .pause(1)
    .exec(readProfile);

  const errors = scenario("Users errors").exec(unauthorizedProfileRead);

  setUp(
    journey.injectOpen(
      // Let the stack settle so startup noise is not attributed to the run.
      nothingFor(5),
      // Warm-up: cold connection pools, an unwarmed JIT and empty caches make
      // the first seconds unrepresentative.
      rampUsers(profile.rampUsers).during(profile.rampDuration),
      constantUsersPerSec(profile.usersPerSec).during(profile.duration),
    ),
    // A thin, constant trickle of failures — enough for http_errors_total to
    // have a shape, not enough to drown the healthy traffic.
    errors.injectOpen(constantUsersPerSec(0.2).during(profile.duration)),
  )
    .protocols(httpProtocol)
    .assertions(
      // The deliberate 401s are checked as `is(401)`, so they count as
      // SUCCESSFUL requests here — this threshold is about real failures.
      global().successfulRequests().percent().gt(99),
      // details() takes a stats PATH: the request name alone, or group/request.
      // Passing the scenario name fails every run with "Could not find stats
      // matching assertion path".
      details("POST /v1/users/register").responseTime().percentile3().lt(3000),
      details("GET /v1/users/me").responseTime().percentile3().lt(1500),
    );
});
