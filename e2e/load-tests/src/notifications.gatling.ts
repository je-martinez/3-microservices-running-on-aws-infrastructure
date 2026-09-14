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
import { seedIdentity, register, login } from "./scenarios/users.js";
import {
  readUnreadCount,
  openNotificationsPanel,
  openUnreadTab,
  markNotificationsRead,
  unauthorizedUnreadCount,
} from "./scenarios/notifications.js";

/**
 * Sustained notification-inbox traffic: sign in, poll the badge as the bell does, then
 * open the panel and mark what was read.
 *
 *   npx gatling run --typescript --simulation notifications usersPerSec=5 duration=300
 */

// A user who also places an order accrues FIVE notifications over that order's
// lifecycle, not the four the tracking WebSocket frames suggest — ORDER_CREATED
// contributes the PLACED one. This simulation places no orders.
// See [[2026-09-10-in-app-notifications-design]]
export default simulation((setUp) => {
  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    // A plain client user-agent, not an E2E marker: this traffic is meant to be
    // indistinguishable from a real client in the logs.
    .userAgentHeader("3mrai-load-tests/0.1");

  const journey = scenario("Notifications inbox")
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(login)
    // The badge poll a client issues on landing, before anything is opened.
    .pause(1)
    .exec(readUnreadCount)
    .pause(2)
    .exec(readUnreadCount)
    // Panel open → mark-on-enter → the badge reflecting the drop, which is the
    // sequence the web actually performs.
    .pause(1)
    .exec(openNotificationsPanel)
    .exec(markNotificationsRead)
    .pause(1)
    .exec(readUnreadCount)
    .pause(2)
    .exec(openUnreadTab)
    .pause(1)
    .exec(readUnreadCount);

  const errors = scenario("Notifications errors").exec(unauthorizedUnreadCount);

  setUp(
    journey.injectOpen(
      // Let the stack settle so startup noise is not attributed to the run.
      nothingFor(5),
      // Warm-up: cold pools, an unwarmed JIT and empty caches make the first
      // seconds unrepresentative, and averaging them in makes a healthy service
      // look slow.
      rampUsers(profile.rampUsers).during(profile.rampDuration),
      constantUsersPerSec(profile.usersPerSec).during(profile.duration),
    ),
    // A thin, constant trickle of failures — enough for http_errors_total to have a
    // shape, not enough to drown the healthy traffic.
    errors.injectOpen(constantUsersPerSec(0.2).during(profile.duration)),
  )
    .protocols(httpProtocol)
    .assertions(
      // The deliberate 401s are checked as `is(401)`, so they count as SUCCESSFUL
      // requests here — this threshold is about real failures.
      global().successfulRequests().percent().gt(99),
      // details() takes a stats PATH: the request name alone, or group/request.
      // Passing the scenario name fails every run with "Could not find stats
      // matching assertion path".
      //
      // The badge is the tightest budget of the three: it is polled on every page,
      // so its p95 is what a user perceives as the app's baseline responsiveness.
      details("GET /v1/notifications/unread-count").responseTime().percentile3().lt(1000),
      // The list runs three queries (page, unread count, 90-day window total)
      // against a 50-row cap, so it is allowed more than the single COUNT.
      details("GET /v1/notifications").responseTime().percentile3().lt(1500),
      details("PATCH /v1/notifications/read").responseTime().percentile3().lt(1500),
    );
});
