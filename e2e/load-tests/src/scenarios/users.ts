import { exec, jsonPath, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";
import { fakeUser } from "../support/config.js";

/**
 * The Authorization header must be a FUNCTION.
 *
 * A plain template string is evaluated once when the scenario is built, so every
 * virtual user would send whatever the first one happened to have — or nothing.
 */
const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;


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
    .check(
      status().is(200),
      jsonPath("$.accessToken").saveAs("token"),
      // Kept so the refresh step below has something to exchange.
      jsonPath("$.refreshToken").saveAs("refreshToken"),
    ),
);

/**
 * Exchange the refresh token for a new access token.
 *
 * Worth loading rather than skipping as plumbing: a real client hits this every
 * time its access token expires, so under sustained traffic it is one of the
 * most-called auth endpoints — and it goes to Cognito, unlike most reads.
 */
export const refreshToken = exec(
  http("POST /v1/users/refresh")
    .post("v1/users/refresh")
    .body(
      StringBody((session) =>
        JSON.stringify({ refreshToken: session.get("refreshToken") }),
      ),
    )
    .asJson()
    // Replace the token, so later steps use the refreshed one and the exchange
    // is proven to have produced something usable rather than merely a 200.
    .check(status().is(200), jsonPath("$.accessToken").saveAs("token")),
);

/**
 * Change the password while authenticated.
 *
 * Distinct from the reset flow: no email, no code — just a logged-in user
 * setting a new password. It takes ONLY `newPassword`; this endpoint is
 * deliberately not a general profile update.
 */
export const changePassword = exec(
  http("PATCH /v1/users/me/password")
    .patch("v1/users/me/password")
    .header("Authorization", authHeader)
    .body(
      StringBody((session) =>
        // Derived from the email so it is unique per virtual user and stays
        // within the Cognito password policy (upper, lower, digit, symbol).
        JSON.stringify({
          newPassword: `Cc3#${session.get("email")}`.slice(0, 24),
        }),
      ),
    )
    .asJson()
    .check(status().is(200)),
);

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
