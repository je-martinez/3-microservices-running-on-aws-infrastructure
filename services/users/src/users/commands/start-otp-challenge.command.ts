import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider } from "#shared/auth/auth-provider";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { AUTH_PROVIDER } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface StartOtpChallengeInput {
  email: string;
}

export interface StartOtpChallengeResult {
  session: string;
}

export class StartOtpChallengeCommand {
  constructor(public readonly input: StartOtpChallengeInput) {}
}

@Workflow("otp_challenge")
@CommandHandler(StartOtpChallengeCommand)
export class StartOtpChallengeHandler implements ICommandHandler<StartOtpChallengeCommand> {
  constructor(@Inject(AUTH_PROVIDER) private readonly auth: AuthProvider) {}

  async execute({ input }: StartOtpChallengeCommand): Promise<StartOtpChallengeResult> {
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "otp_challenge_started", email: maskEmail(input.email) },
      "Starting OTP challenge",
    );

    try {
      const result = await this.auth.startOtpChallenge(input.email);
      // WARNING: Never log `session` — it is credential-adjacent.
      appLogger.info(
        { app_event: "otp_challenge_succeeded", email: maskEmail(input.email) },
        "OTP challenge started",
      );
      trace.getActiveSpan()?.setAttribute("app_event", "otp_challenge_succeeded");
      return result;
    } catch (err) {
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
      throw err;
    }
  }
}
