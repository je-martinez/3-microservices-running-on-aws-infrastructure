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
 * Log in, retrying briefly if the account has not propagated yet.
 *
 * A freshly registered account is not immediately usable in Floci's Cognito,
 * and the window is narrow enough to be easy to miss. Measured over one full
 * `load` run (341 successful logins): the register→login gap had median 1122ms
 * and p95 1372ms, and only 26 logins fell under 150ms. SIX of those failed with
 * `invalid_credentials` on accounts whose `register_succeeded` had fired only
 * 80–140ms earlier, with no password change in between — every failure sat
 * inside that sub-150ms band, and none outside it.
 *
 * The cost was out of all proportion to six requests: a failed login saves no
 * token, so the rest of that virtual user's journey sent `Bearer null` and
 * 401d, adding 26 more KO scattered across products, profile and orders. That
 * cascade is what dragged the run to 98.58%, under the 99% gate — and the
 * scattering is why it read as a broken auth chain rather than as one race.
 *
 * `tryMax(3)` retries the whole block, the same construct the Mailpit poll in
 * auth-codes.ts uses for the other asynchronous dependency here. The retry is
 * BOUNDED, and because the check above still demands a 200 carrying a token,
 * exhausting the tries leaves the virtual user failed rather than quietly
 * tokenless: a real auth outage still fails the run loudly, which is the point.
 *
 * The pause sits INSIDE the tried block and comes first, so it delays the
 * initial attempt as well as the retries. That is deliberate: the caller that
 * actually loses this race is fullJourney's "Error traffic" scenario, which
 * chains `register` straight into `login` with no pause of its own, while the
 * buyer and browser journeys already wait 1s and sit clear of the band. 400ms
 * covers the observed 80–140ms failures with margin while staying well under
 * the 1122ms median, so it does not distort the think-time other scenarios
 * model.
 */
export const login = exec(
  tryMax(3).on(
    exec(pause({ amount: 400, unit: "milliseconds" })).exec(loginRequest),
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
