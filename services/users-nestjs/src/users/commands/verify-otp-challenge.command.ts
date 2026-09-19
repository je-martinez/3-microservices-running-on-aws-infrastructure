import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import { InvalidOtpError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { AUTH_PROVIDER } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface VerifyOtpChallengeInput {
  email: string;
  session: string;
  code: string;
}

export class VerifyOtpChallengeCommand {
  constructor(public readonly input: VerifyOtpChallengeInput) {}
}

@Workflow("otp_verify")
@CommandHandler(VerifyOtpChallengeCommand)
export class VerifyOtpChallengeHandler implements ICommandHandler<VerifyOtpChallengeCommand> {
  constructor(@Inject(AUTH_PROVIDER) private readonly auth: AuthProvider) {}

  // WARNING: Never put `input.code` or `input.session` on a span attribute.
  // See [[logging-context]]
  async execute({ input }: VerifyOtpChallengeCommand): Promise<AuthTokens> {
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "otp_verify_started", email: maskEmail(input.email) },
      "Starting OTP verification",
    );

    try {
      const tokens = await this.auth.respondToOtpChallenge(
        input.email,
        input.session,
        input.code,
      );
      // WARNING: Never log `tokens` — access and refresh tokens are credentials.
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
      trace.getActiveSpan()?.setAttributes({
        app_event: "otp_verify_failed",
        reason: invalid ? "invalid_otp" : "cognito_error",
      });
      throw err;
    }
  }
}
