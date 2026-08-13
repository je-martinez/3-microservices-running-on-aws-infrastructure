import { getEnvironmentVariable, getParameter } from "@gatling.io/core";
import Chance from "chance";

const chance = new Chance();

/**
 * Shared configuration for every simulation.
 *
 * Values come from the SDK's own accessors, never `process.env`: simulations run
 * in GraalVM rather than Node, so `process` is undefined at runtime even though
 * it type-checks when @types/node is present. See the gatling-js skill.
 */

/** Base URL every simulation targets. */
export const baseUrl = (): string => {
  const url = getEnvironmentVariable("API_GATEWAY_URL", "");
  if (!url) {
    // Failing loudly beats defaulting to localhost: a silent default produces a
    // green run against nothing, which is worse than no run at all.
    throw new Error(
      "API_GATEWAY_URL is not set. It is generated into .env.local.infra by " +
        "`make bootstrap`; export it before running, e.g. " +
        "`export $(grep API_GATEWAY_URL .env.local.infra | xargs)`.",
    );
  }
  // The gateway URL carries a path (…/restapis/<id>/$default/_user_request_),
  // so a trailing slash is required for relative request paths to append rather
  // than replace it.
  return url.endsWith("/") ? url : `${url}/`;
};

/** The carrier API key, for the one endpoint authenticated outside Cognito. */
export const carrierApiKey = (): string =>
  getEnvironmentVariable("TRACKING_CARRIER_API_KEY", "");

/**
 * Mailpit's HTTP API — the local inbox the OTP and reset codes land in.
 *
 * An ABSOLUTE url, because these requests do not go through the gateway: they
 * read a mailbox rather than call the product. Gatling's `baseUrl` still
 * applies to every relative path, so mixing the two in one simulation is fine.
 */
export const mailpitBaseUrl = (): string =>
  getEnvironmentVariable("MAILPIT_API_URL", "http://localhost:8025/api/v1");

/** Load profile knobs — `npx gatling run key=value`, no file edit needed. */
export const profile = {
  /** Steady arrival rate during the measurement window. */
  usersPerSec: parseFloat(getParameter("usersPerSec", "1")),
  /** Seconds the steady rate is held. */
  duration: parseInt(getParameter("duration", "60")),
  /** Users injected during the warm-up ramp. */
  rampUsers: parseInt(getParameter("rampUsers", "10")),
  /** Seconds the ramp is spread over. */
  rampDuration: parseInt(getParameter("rampDuration", "20")),
};

/**
 * Run-scoped namespace for generated identities.
 *
 * Uniqueness here is load-bearing, and getting it wrong is expensive rather
 * than merely untidy: a duplicate email fails registration, the login that
 * follows then fails for lack of an account, and every authenticated step after
 * it returns 401. One collision produced **five** failures in a measured run —
 * so a weak namespace does not look like a data bug, it looks like the auth
 * chain is broken.
 *
 * Chance's own `chance.email()` is deliberately NOT used for this: it draws
 * from a finite pool and repeats. Chance IS used for every other field, where
 * repetition is harmless and realism is the point.
 *
 * The suffix combines three sources so that no single one has to be perfect:
 * wall-clock milliseconds (separates runs), a random component, and a
 * monotonic counter (guarantees uniqueness within a run, which is the only
 * part that must never fail).
 */
const runId = `${Date.now().toString(36)}${chance.string({
  length: 8,
  alpha: true,
  numeric: true,
  casing: "lower",
})}`;

/**
 * Realistic fake data, from Chance.js.
 *
 * Chance bundles into the simulation (verified — it is pure JS with no Node
 * built-ins, which is the thing to check before depending on a library here;
 * see the gatling-js skill). Real names, streets and cities beat synthetic
 * strings because they exercise the same validation, encoding and column widths
 * a real signup does — `Ünal O'Brien-Smith` finds bugs that `Load Test 42`
 * never will.
 *
 * The EMAIL is the one field not left to Chance: `chance.email()` draws from a
 * finite pool and repeats, and a repeat means 409 email_exists. The run-scoped
 * prefix plus the counter guarantees uniqueness, so registration failures mean
 * a real defect rather than a birthday collision.
 */
export const fakeUser = (
  userId: number,
): {
  email: string;
  password: string;
  fullName: string;
  phoneNumber: string;
  address: { line1: string; city: string; country: string };
} => {
  // Gatling's own per-virtual-user id, not a module counter.
  //
  // This was measured the hard way: a module-level counter produced the SAME
  // email five times in one run. Simulation modules are evaluated per
  // execution context in GraalVM, so a counter in module scope is not the
  // single shared sequence it appears to be — several users draw the same
  // value. `session.userId()` is unique per virtual user by construction,
  // which is the guarantee this needs.
  const suffix = `${runId}-${userId}`;
  return {
    email: `loadtest-${suffix}@example.com`,
    // Matches the service's password policy: upper, lower, digit, symbol.
    password: `Aa1!${chance.string({ length: 10, alpha: true, numeric: true })}`,
    fullName: chance.name(),
    phoneNumber: chance.phone(),
    address: {
      line1: chance.address(),
      city: chance.city(),
      country: chance.country({ full: true }),
    },
  };
};
