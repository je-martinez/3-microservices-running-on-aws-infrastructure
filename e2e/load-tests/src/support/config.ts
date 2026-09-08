import { getEnvironmentVariable, getParameter } from "@gatling.io/core";
import Chance from "chance";

const chance = new Chance();

/**
 * CONTRACT: Read values through the SDK's accessors, NEVER `process.env`. Simulations
 * run in GraalVM, so `process` is undefined at runtime even though it type-checks with
 * @types/node present. See [[testing]]
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
 * Mailpit's HTTP API — the local inbox the OTP and reset codes land in. ABSOLUTE,
 * because these read a mailbox rather than call the product; `baseUrl` still applies
 * to relative paths, so mixing the two in one simulation is fine.
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
 * CONTRACT: Do NOT weaken this to `chance.email()` — it draws from a finite pool and
 * repeats. A duplicate email 409s registration, the login then fails, and every step
 * after it 401s: one collision produced FIVE failures in a run, reading as a broken
 * auth chain rather than a data bug. The suffix combines wall-clock ms, a random
 * component, and a per-user counter. See [[testing]]
 */
const runId = `${Date.now().toString(36)}${chance.string({
  length: 8,
  alpha: true,
  numeric: true,
  casing: "lower",
})}`;

/**
 * Realistic fake data from Chance.js (pure JS, no Node built-ins — the thing to check
 * before depending on a library here). Real names and streets exercise the validation
 * and column widths a real signup does. The EMAIL is the one field not left to Chance.
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
  // CONTRACT: Use Gatling's per-virtual-user id, NEVER a module-level counter.
  // Simulation modules are evaluated per execution context in GraalVM, so module scope
  // is not one shared sequence — a counter produced the SAME email five times in one
  // run. `session.userId()` is unique per virtual user by construction.
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
