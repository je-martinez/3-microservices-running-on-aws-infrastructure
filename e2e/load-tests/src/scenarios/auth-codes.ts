import { exec, jsonPath, regex, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";
import { fakeUser, mailpitBaseUrl } from "../support/config.js";

/**
 * The two flows whose second step needs a code that arrives by email: passwordless OTP
 * login and password reset, both modelled END TO END by reading Mailpit's HTTP API.
 *
 * CONTRACT: Keep the polling request NAMED separately ("GET mailpit (wait for code)").
 * This puts email latency inside the measurement — the code travels service → SQS →
 * Lambda → SES → Mailpit, taking seconds — so without its own row "waiting for an
 * email" is read as "our service is slow". The service's real latency is the other rows.
 * otp/start returns a `session` verify requires, and the code appears in Mailpit's
 * search `Snippet`, so one search call suffices. See [[testing]]
 */

/** Seeds an identity for a passwordless account (no password is ever set). */
export const seedPasswordlessIdentity = exec((session) => {
  const user = fakeUser(session.userId());
  return session.set("email", user.email).set("fullName", user.fullName);
});

/** Create the account. Passwordless users have no usable password at all. */
export const registerPasswordless = exec(
  http("POST /v1/users/register/passwordless")
    .post("v1/users/register/passwordless")
    .body(
      StringBody((session) =>
        JSON.stringify({
          email: session.get("email"),
          fullName: session.get("fullName"),
        }),
      ),
    )
    .asJson()
    .check(status().is(201)),
);

/**
 * Start the challenge. CONTRACT: The response's `session` must be echoed back by
 * `verify` — it is Cognito's CUSTOM_AUTH challenge state, and dropping it makes verify
 * fail in a way that looks like a bad code.
 */
export const otpStart = exec(
  http("POST /v1/users/otp/start")
    .post("v1/users/otp/start")
    .body(StringBody((session) => JSON.stringify({ email: session.get("email") })))
    .asJson()
    .check(status().is(200), jsonPath("$.session").saveAs("otpSession")),
);

/**
 * Poll Mailpit until the code arrives. `.tryMax` retries the whole block, since the
 * email is asynchronous and its timing is not something the service controls. The code
 * comes out of the search result's `Snippet` — Mailpit puts enough of the body there
 * that a second request for the full message is unnecessary.
 */
const fetchCodeFromMailbox = (saveAs: string, subject: string) =>
  exec(
    http("GET mailpit (wait for code)")
      .get(`${mailpitBaseUrl()}/search`)
      // Filtered by SUBJECT as well as recipient, and that is load-bearing: a
      // user who registers also receives "Welcome to 3MRAI", which carries no
      // code. With `limit=1` and no subject filter, whichever mail happens to
      // be first wins — measured at 64% failure, every one of them the regex
      // finding nothing in a welcome email and the rest of the flow failing
      // behind it.
      .queryParam(
        "query",
        (session: { get: (k: string) => unknown }) =>
          `to:${session.get("email")} subject:"${subject}"`,
      )
      .queryParam("limit", "1")
      .check(status().is(200), regex("\\b(\\d{6})\\b").saveAs(saveAs)),
  );

/** Subjects the events-pipeline sends — the discriminator for the search. */
const OTP_SUBJECT = "Your one-time code";
const RESET_SUBJECT = "Reset your password";

export const waitForOtpCode = fetchCodeFromMailbox("otpCode", OTP_SUBJECT);

/** Exchange the code for real tokens. */
export const otpVerify = exec(
  http("POST /v1/users/otp/verify")
    .post("v1/users/otp/verify")
    .body(
      StringBody((session) =>
        JSON.stringify({
          email: session.get("email"),
          code: session.get("otpCode"),
          session: session.get("otpSession"),
        }),
      ),
    )
    .asJson()
    .check(status().is(200), jsonPath("$.idToken").saveAs("token")),
);

/**
 * Request a password reset.
 *
 * Always 202, whether or not the address exists — the service refuses to be a
 * user-enumeration oracle, so a 202 here says nothing about the account.
 */
export const forgotPassword = exec(
  http("POST /v1/users/password/forgot")
    .post("v1/users/password/forgot")
    .body(StringBody((session) => JSON.stringify({ email: session.get("email") })))
    .asJson()
    .check(status().is(202)),
);

export const waitForResetCode = fetchCodeFromMailbox("resetCode", RESET_SUBJECT);

/** Set the new password, then prove it works by logging in with it. */
export const confirmPasswordReset = exec(
  http("POST /v1/users/password/confirm")
    .post("v1/users/password/confirm")
    .body(
      StringBody((session) =>
        JSON.stringify({
          email: session.get("email"),
          code: session.get("resetCode"),
          newPassword: `Bb2@${session.get("email")}`.slice(0, 24),
        }),
      ),
    )
    .asJson()
    .check(status().is(200)),
);

export const loginWithNewPassword = exec(
  http("POST /v1/users/login (after reset)")
    .post("v1/users/login")
    .body(
      StringBody((session) =>
        JSON.stringify({
          email: session.get("email"),
          password: `Bb2@${session.get("email")}`.slice(0, 24),
        }),
      ),
    )
    .asJson()
    .check(status().is(200)),
);
