import { exec, jsonPath, pause, StringBody, tryMax } from "@gatling.io/core";
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
 * CONTRACT: Send NO `x-e2e-source` header anywhere in this file. That tag marks rows
 * for the E2E teardown to delete, and load-test data must persist like real data —
 * which also means nothing cleans it up (see the README). Endpoint shapes come from
 * services/users/openapi.yaml, never guessed: a wrong field name yields a 400 that
 * reads as a service defect in the dashboards. See [[testing]]
 */

/**
 * Seeds one virtual user's identity, once per user before any request. The whole
 * identity comes from Chance.js — real names, streets, cities and phone numbers —
 * so the traffic exercises the validation and encoding paths a real signup does.
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
 * CONTRACT: Keep the token in the virtual user's own session via `saveAs`. A shared
 * module-level token collapses every later request onto one cognito_sub and hides the
 * per-user query cost the dashboards exist to show. See [[testing]]
 */
const loginRequest = http("POST /v1/users/login")
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
    // Still 200 ONLY, and that is the point of the retry below. Widening this
    // to accept 401 would be the wrong fix: a 401 saves no token, so every
    // authenticated step after it sends `Bearer null` and 401s in turn — and it
    // would destroy this suite's ability to ever detect genuinely broken auth.
    // Same principle as `register` above: tolerating the failure status lets a
    // broken system pass as healthy.
    status().is(200),
    jsonPath("$.accessToken").saveAs("token"),
    // Kept so the refresh step below has something to exchange.
    jsonPath("$.refreshToken").saveAs("refreshToken"),
  );

/**
 * WORKAROUND(local): Do NOT log in immediately after registering — a fresh account is
 * unusable in Floci's Cognito for ~150ms. Every observed `invalid_credentials` sat
 * 80-140ms after `register_succeeded`, none outside that band. A failed login saves no
 * token, so the rest of that user's journey sends `Bearer null` and 401s, scattering KO
 * across products, profile and orders — one race that reads as a broken auth chain.
 * The 400ms pause sits INSIDE the tried block and first, so it delays the initial
 * attempt too: fullJourney's "Error traffic" chains register straight into login with
 * no pause. It stays under the 1122ms median gap, so it does not distort think time.
 * The retry is bounded and the check still demands a 200 with a token.
 * See [[testing]]
 */
export const login = exec(
  tryMax(3).on(
    exec(pause({ amount: 400, unit: "milliseconds" })).exec(loginRequest),
  ),
);

/**
 * Exchange the refresh token for a new access token. Worth loading rather than
 * skipping as plumbing: a real client hits it whenever its access token expires, so
 * under sustained traffic it is one of the most-called auth endpoints — and unlike
 * most reads it goes to Cognito.
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
 * Change the password while authenticated — distinct from the reset flow: no email,
 * no code. It takes ONLY `newPassword`; this endpoint is not a profile update.
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
