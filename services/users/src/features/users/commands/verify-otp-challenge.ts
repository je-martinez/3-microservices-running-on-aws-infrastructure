import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import { InvalidOtpError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface VerifyOtpChallengeInput {
  email: string;
  session: string;
  code: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class VerifyOtpChallengeCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  // NEVER put `input.code` (or `input.session`) on a span attribute — not
  // masked, not hashed, not truncated, and never inside a `reason`. A span is
  // exported to a tracing backend exactly like a log line is exported to a log
  // backend, so the rule from the log call sites below applies unchanged: a
  // 6-digit code has 1,000,000 possibilities and stays a live credential for
  // its whole TTL, so no partial reveal is safe. Only `email_hash` and the
  // flow's own app_event/reason go on this span.
  async execute(input: VerifyOtpChallengeInput): Promise<AuthTokens> {
    return withWorkflowSpan(
      "otp_verify",
      { app_event: "otp_verify_started", email_hash: hashEmail(input.email) },
      () => this.doExecute(input),
    );
  }

  private async doExecute(input: VerifyOtpChallengeInput): Promise<AuthTokens> {
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "otp_verify_started", email: maskEmail(input.email) },
      "Starting OTP verification",
    );

    try {
      // NEVER LOG `input.code` — not masked, not hashed, not truncated, and
      // never inside a `reason` string. A 6-digit code has only 1,000,000
      // possibilities, so unlike an email no partial reveal is safe, and it is
      // a live credential for its whole TTL. `input.session` is withheld for
      // the same reason: it is what buys tokens.
      const tokens = await this.auth.respondToOtpChallenge(
        input.email,
        input.session,
        input.code,
      );
      // NOTE: `tokens` is deliberately NOT logged — access and refresh tokens
      // are credentials, exactly like the code that produced them.
      appLogger.info(
        { app_event: "otp_verify_succeeded", email: maskEmail(input.email) },
        "OTP verification completed",
      );
      trace.getActiveSpan()?.setAttribute("app_event", "otp_verify_succeeded");
      return tokens;
    } catch (err) {
      const invalid = err instanceof InvalidOtpError;
      appLogger.error(
        {
          err,
          app_event: "otp_verify_failed",
          email: maskEmail(input.email),
          reason: invalid ? "invalid_otp" : "cognito_error",
        },
        invalid
          ? "OTP verification failed: invalid or expired code"
          : "OTP verification failed: the identity provider rejected the request",
      );
      // The reason only ever names the CLASS of failure, never the code that
      // caused it — same two values the log line above uses, same branch.
      trace
        .getActiveSpan()
        ?.setAttributes({
          app_event: "otp_verify_failed",
          reason: invalid ? "invalid_otp" : "cognito_error",
        });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
