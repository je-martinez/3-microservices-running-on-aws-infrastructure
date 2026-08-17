import {
  simulation,
  scenario,
  nothingFor,
  constantUsersPerSec,
  global,
  details,
  getParameter,
} from "@gatling.io/core";
import { http } from "@gatling.io/http";
import { baseUrl } from "./support/config.js";
import { seedIdentity, register, readProfile } from "./scenarios/users.js";
import {
  seedPasswordlessIdentity,
  registerPasswordless,
  otpStart,
  waitForOtpCode,
  otpVerify,
  forgotPassword,
  waitForResetCode,
  confirmPasswordReset,
  loginWithNewPassword,
} from "./scenarios/auth-codes.js";

/**
 * The two email-code flows: passwordless OTP login, and password reset.
 *
 *   pnpm run auth-codes
 *   pnpm exec gatling run --typescript --simulation authCodes usersPerSec=0.5 duration=120
 *
 * Kept SEPARATE from fullJourney on purpose. Every virtual user here waits for
 * an email to travel service → SQS → Lambda → SES → Mailpit, which takes
 * seconds. Mixed into the main simulation those seconds would inflate the whole
 * run's percentiles with latency that is not our services'. Here they are
 * isolated, and the polling request has its own row in the report so the wait is
 * visible rather than smeared across the service's own numbers.
 *
 * The rate defaults LOW for the same reason: this exercises the events-pipeline
 * end to end (one email per user), so it is a throughput test of the email path
 * rather than of the HTTP surface.
 */
export default simulation((setUp) => {
  const usersPerSec = parseFloat(getParameter("usersPerSec", "0.3"));
  const duration = parseInt(getParameter("duration", "60"));

  const httpProtocol = http
    .baseUrl(baseUrl())
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    .userAgentHeader("3mrai-load-tests/0.1");

  // Sign in with a one-time code, no password anywhere in the flow.
  const otpLogin = scenario("Passwordless OTP login")
    .exec(seedPasswordlessIdentity)
    .exec(registerPasswordless)
    .pause(1)
    .exec(otpStart)
    // The pause before polling is not politeness — starting to poll instantly
    // just burns retries against an inbox that cannot possibly have the message
    // yet, and makes the report's wait row longer than the real wait.
    .pause(3)
    .exec(waitForOtpCode)
    .exec(otpVerify)
    .pause(1)
    .exec(readProfile);

  // Forget the password, reset it by email, prove the new one works.
  const passwordReset = scenario("Password reset")
    .exec(seedIdentity)
    .exec(register)
    .pause(1)
    .exec(forgotPassword)
    .pause(3)
    .exec(waitForResetCode)
    .exec(confirmPasswordReset)
    .pause(1)
    .exec(loginWithNewPassword);

  setUp(
    otpLogin.injectOpen(
      nothingFor(5),
      constantUsersPerSec(usersPerSec).during(duration),
    ),
    passwordReset.injectOpen(
      nothingFor(5),
      constantUsersPerSec(usersPerSec).during(duration),
    ),
  )
    .protocols(httpProtocol)
    .assertions(
      global().successfulRequests().percent().gt(95),
      // Thresholds are on OUR endpoints only. The Mailpit wait deliberately has
      // no assertion: its duration is the email pipeline's, and holding it to a
      // latency budget here would fail the run for something this simulation
      // does not measure.
      details("POST /v1/users/otp/start").responseTime().percentile3().lt(5000),
      details("POST /v1/users/password/forgot").responseTime().percentile3().lt(5000),
    );
});
