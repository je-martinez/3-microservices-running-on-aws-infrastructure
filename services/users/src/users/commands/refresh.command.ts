import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider, RefreshedTokens } from "#shared/auth/auth-provider";
import { AUTH_PROVIDER } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface RefreshInput {
  refreshToken: string;
}

export class RefreshCommand {
  constructor(public readonly input: RefreshInput) {}
}

// WARNING: The refresh token is a credential and never reaches the span.
// See [[logging-context]]
@Workflow("refresh")
@CommandHandler(RefreshCommand)
export class RefreshHandler implements ICommandHandler<RefreshCommand> {
  constructor(@Inject(AUTH_PROVIDER) private readonly auth: AuthProvider) {}

  async execute({ input }: RefreshCommand): Promise<RefreshedTokens> {
    try {
      const tokens = await this.auth.refresh(input.refreshToken);
      trace.getActiveSpan()?.setAttribute("app_event", "refresh_succeeded");
      return tokens;
    } catch (err) {
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "refresh_failed", reason: "cognito_error" });
      throw err;
    }
  }
}
