import { exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";
import { uniqueSuffix } from "../support/config.js";

/**
 * The Users journey: register → login → read profile → update profile.
 *
 * Endpoint shapes were taken from services/users/openapi.yaml rather than
 * guessed — a wrong field name produces a 400 that reads as a service defect in
 * the dashboards, which is precisely the noise this traffic exists to avoid.
 *
 * No `x-e2e-source` header anywhere in here, on purpose: that tag marks rows for
 * the E2E teardown to delete, and load-test data is meant to persist like real
 * data. It also means nothing cleans this up — see the README.
 */

/** Seeds one virtual user's identity. Runs once per user, before any request. */
export const seedIdentity = exec((session) => {
  const suffix = uniqueSuffix();
  return session
    .set("email", `loadtest-${suffix}@example.com`)
    .set("password", `Aa1!${suffix}Xy`)
    .set("fullName", `Load Test ${suffix}`);
});

/** Register. 201 only — tolerating 409 would let a collision pass as healthy. */
export const register = exec(
  http("POST /v1/users/register")
    .post("v1/users/register")
    .body(
      StringBody((session) =>
        JSON.stringify({
          email: session.get("email"),
          password: session.get("password"),
          fullName: session.get("fullName"),
        }),
      ),
    )
    .asJson()
    .check(status().is(201)),
);

/**
 * Log in and keep the token.
 *
 * `saveAs` puts it in this virtual user's own session — a shared module-level
 * token would collapse every later request onto one cognito_sub, hiding the
 * per-user query cost the dashboards are meant to show.
 */
export const login = exec(
  http("POST /v1/users/login")
    .post("v1/users/login")
    .body(
      StringBody((session) =>
        JSON.stringify({
          email: session.get("email"),
          password: session.get("password"),
        }),
      ),
    )
    .asJson()
    .check(status().is(200), jsonPath("$.accessToken").saveAs("token")),
);

/**
 * The Authorization header must be a FUNCTION.
 *
 * A plain template string is evaluated once when the scenario is built, so every
 * virtual user would send whatever the first one happened to have — or nothing.
 */
const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

export const readProfile = exec(
  http("GET /v1/users/me")
    .get("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(200)),
);

/** Update the profile with a full name, phone and address — real user churn. */
export const updateProfile = exec(
  http("PATCH /v1/users/me")
    .patch("v1/users/me")
    .header("Authorization", authHeader)
    .body(
      StringBody((session) => {
        const suffix = uniqueSuffix();
        return JSON.stringify({
          fullName: `${session.get("fullName")} Updated`,
          phoneNumber: `+1555${String(1000000 + (parseInt(suffix.split("-")[1] ?? "1") % 9000000))}`,
          address: {
            line1: `${100 + (parseInt(suffix.split("-")[1] ?? "1") % 900)} Load Test Street`,
            city: "Springfield",
            country: "United States",
          },
        });
      }),
    )
    .asJson()
    .check(status().is(200)),
);

/** A 4xx on purpose, so the error panels carry signal instead of sitting empty. */
export const unauthorizedProfileRead = exec(
  http("GET /v1/users/me (no auth)")
    .get("v1/users/me")
    .check(status().is(401)),
);
