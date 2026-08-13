import { getEnvironmentVariable, getParameter } from "@gatling.io/core";

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
 * Unique-per-virtual-user id.
 *
 * A module-level counter guarantees uniqueness within a run; the timestamp
 * prefix separates runs, so a re-run against a database that still holds
 * yesterday's rows does not collide. Registration is the reason this matters —
 * a repeated email returns 409 and reads as a broken service rather than a
 * broken feeder.
 */
let seq = 0;
const runId = `${Date.now().toString(36)}`;
export const uniqueSuffix = (): string => `${runId}-${(seq += 1)}`;
