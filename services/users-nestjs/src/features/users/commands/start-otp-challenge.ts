import type { AuthProvider } from "#shared/auth/auth-provider";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface StartOtpChallengeInput {
  email: string;
}

export interface StartOtpChallengeResult {
  session: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class StartOtpChallengeCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  // Span attributes mirror the flow log's fields. The returned `session` is
  // credential-adjacent (it is what respondToOtpChallenge trades for tokens) and
  // is no more loggable as a span attribute than as a log field — it never
  // appears here, and neither does the plaintext email.
  async execute(input: StartOtpChallengeInput): Promise<StartOtpChallengeResult> {
    return withWorkflowSpan(
      "otp_challenge",
      { app_event: "otp_challenge_started", email_hash: hashEmail(input.email) },
      () => this.doExecute(input),
    );
  }

  private async doExecute(input: StartOtpChallengeInput): Promise<StartOtpChallengeResult> {
    // Only email_hash goes in the CONTEXT — context fields stick to every later
    // line of the request, including `request completed`. The masked email is
    // passed per-call-site instead, so it appears on the auth-flow lines only.
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "otp_challenge_started", email: maskEmail(input.email) },
      "Starting OTP challenge",
    );

    try {
      const result = await this.auth.startOtpChallenge(input.email);
      // The session token is opaque and short-lived but is still a
      // credential-adjacent value (it is what respondToOtpChallenge trades for
      // tokens) — never logged, same treatment as AuthTokens in login.ts.
      appLogger.info(
        { app_event: "otp_challenge_succeeded", email: maskEmail(input.email) },
        "OTP challenge started",
      );
      trace.getActiveSpan()?.setAttribute("app_event", "otp_challenge_succeeded");
      return result;
    } catch (err) {
      // Distinguished here rather than in the route's error handler, which sees
      // only a typed error with no memory of the step that produced it.
      appLogger.error(
        {
          err,
          app_event: "otp_challenge_failed",
          email: maskEmail(input.email),
          reason: "cognito_error",
        },
        "OTP challenge start failed: the identity provider rejected the request",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "otp_challenge_failed", reason: "cognito_error" });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
