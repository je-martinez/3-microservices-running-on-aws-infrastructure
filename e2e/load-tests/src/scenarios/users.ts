import { exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";
import { fakeUser } from "../support/config.js";

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

/**
 * Seeds one virtual user's identity. Runs once per user, before any request.
 *
 * The whole identity comes from Chance.js — real names, streets, cities and
 * phone numbers rather than synthetic strings, so the traffic exercises the
 * same validation and encoding paths a real signup does.
 */
export const seedIdentity = exec((session) => {
  const user = fakeUser(session.userId());
  return session
    .set("email", user.email)
    .set("password", user.password)
    .set("fullName", user.fullName)
    .set("phoneNumber", user.phoneNumber)
    .set("addressLine1", user.address.line1)
    .set("city", user.address.city)
    .set("country", user.address.country);
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
      StringBody((session) =>
        JSON.stringify({
          // Chance-generated values seeded on this virtual user, so the update
          // carries the same realistic shape the registration did.
          fullName: session.get("fullName"),
          phoneNumber: session.get("phoneNumber"),
          address: {
            line1: session.get("addressLine1"),
            city: session.get("city"),
            country: session.get("country"),
          },
        }),
      ),
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
