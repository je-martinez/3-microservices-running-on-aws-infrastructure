import { exec, jsonPath, regex, StringBody } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";
import { fakeUser, mailpitBaseUrl } from "../support/config.js";

/**
 * The two flows whose second step needs a code that arrives by email:
 * passwordless OTP login, and password reset.
 *
 * Both are modelled END TO END, which means the simulation reads the code out
 * of Mailpit's HTTP API the way a person reads their inbox.
 *
 * > [!warning] This deliberately puts email latency inside the measurement.
 * > The code travels service → SQS → Lambda → SES → Mailpit, which takes
 * > seconds. Those seconds land in these scenarios' percentiles, and Mailpit
 * > becomes part of the system under load.
 * >
 * > That is why the polling request is NAMED separately ("GET mailpit (wait for
 * > code)"): in the report it sits on its own row, so "waiting for an email" is
 * > never mistaken for "our service is slow". Read the service's own latency
 * > from the other rows.
 *
 * Verified against the running stack before being written: otp/start returns a
 * `session` that verify requires, and the six-digit code appears in Mailpit's
 * search `Snippet`, so one search call is enough — no second fetch for the full
 * message body.
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
 * Start the challenge.
 *
 * The response carries a `session` that `verify` must echo back — Cognito's
 * CUSTOM_AUTH challenge state. Dropping it makes verify fail in a way that
 * looks like a bad code.
 */
export const otpStart = exec(
  http("POST /v1/users/otp/start")
    .post("v1/users/otp/start")
    .body(StringBody((session) => JSON.stringify({ email: session.get("email") })))
    .asJson()
    .check(status().is(200), jsonPath("$.session").saveAs("otpSession")),
);

/**
 * Poll Mailpit until the code arrives.
 *
 * `.tryMax` retries the whole block, so a message that has not landed yet is
 * retried rather than failing the user — the email is asynchronous and its
 * timing is not something the service controls.
 *
 * The code is pulled from the search result's `Snippet` with a regex; Mailpit
 * puts enough of the body there that a second request for the full message is
 * unnecessary.
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
