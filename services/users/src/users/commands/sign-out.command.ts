import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider } from "#shared/auth/auth-provider";
import { appLogger } from "#shared/logging/app-logger";
import { AUTH_PROVIDER } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface SignOutInput {
  accessToken: string;
}

export class SignOutCommand {
  constructor(public readonly input: SignOutInput) {}
}

// WARNING: The access token is a credential and never reaches the span or a log
// line. See [[logging-context]]
@Workflow("sign_out")
@CommandHandler(SignOutCommand)
export class SignOutHandler implements ICommandHandler<SignOutCommand> {
  constructor(@Inject(AUTH_PROVIDER) private readonly auth: AuthProvider) {}

  async execute({ input }: SignOutCommand): Promise<void> {
    appLogger.info({ app_event: "sign_out_started" }, "Starting sign-out");

    try {
      await this.auth.signOut(input.accessToken);
    } catch (err) {
      appLogger.error(
        { err, app_event: "sign_out_failed", reason: "cognito_error" },
        "Sign-out failed: Cognito did not revoke the session",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "sign_out_failed", reason: "cognito_error" });
      throw err;
    }

    appLogger.info({ app_event: "sign_out_succeeded" }, "Session revoked");
    trace.getActiveSpan()?.setAttribute("app_event", "sign_out_succeeded");
  }
}
