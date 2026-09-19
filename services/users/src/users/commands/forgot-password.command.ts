import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { generateResetCode, RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";
import { DB, EVENT_PUBLISHER } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface ForgotPasswordInput {
  email: string;
}

export class ForgotPasswordCommand {
  constructor(public readonly input: ForgotPasswordInput) {}
}

// WARNING: Never put the minted `code` on a span attribute.
// CONTRACT: The unknown-email branch is marked a SUCCESS with
// `reason: unknown_email`, not an error — anything else rebuilds the enumeration
// oracle in the trace backend. See [[logging-context]]
@Workflow("password_reset_requested")
@CommandHandler(ForgotPasswordCommand)
export class ForgotPasswordHandler implements ICommandHandler<ForgotPasswordCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    private readonly resetCodeStore: ResetCodeStore,
  ) {}

  async execute({ input }: ForgotPasswordCommand): Promise<void> {
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "password_reset_requested_started", email: maskEmail(input.email) },
      "Starting password reset request",
    );

    const user = await this.db.user.findFirst({ where: { email: input.email } });

    // CONTRACT: Do NOT turn this into a 404. An unknown email must answer with the
    // same status and body as a known one. See [[auth-error-mapping]]
    if (!user) {
      appLogger.info(
        {
          app_event: "password_reset_requested_succeeded",
          email: maskEmail(input.email),
          reason: "unknown_email",
        },
        "Password reset request accepted for an unknown email (no code minted, no event published)",
      );
      trace.getActiveSpan()?.setAttributes({
        app_event: "password_reset_requested_succeeded",
        reason: "unknown_email",
      });
      return;
    }

    setLogContext({ user_id: user.id });

    const code = generateResetCode();

    // CONTRACT: Only the HASH is stored. No `runAsActor` — this write never
    // reaches Postgres.
    await this.resetCodeStore.store(input.email, code);

    // CONTRACT: Keep this try/catch — a publish error surfacing as a 500 can only
    // happen for an email that EXISTS, rebuilding the enumeration oracle.
    try {
      await this.events.publishPasswordResetRequested({
        userId: user.id,
        email: input.email,
        fullName: user.fullName,
        code,
        ttlSeconds: RESET_CODE_TTL_SECONDS,
        ...(user.cognitoSub ? { cognitoSub: user.cognitoSub } : {}),
      });
    } catch (err) {
      appLogger.error(
        {
          err,
          app_event: "password_reset_requested_publish_failed",
          reason: "publish_threw",
          user_id: user.id,
        },
        "PASSWORD_RESET_REQUESTED publish failed (non-fatal): the code was stored but no email was requested",
      );
    }

    appLogger.info(
      {
        app_event: "password_reset_requested_succeeded",
        email: maskEmail(input.email),
        user_id: user.id,
        ttl_seconds: RESET_CODE_TTL_SECONDS,
      },
      "Password reset code minted and event published",
    );
    trace.getActiveSpan()?.setAttributes({
      app_event: "password_reset_requested_succeeded",
      user_id: user.id,
    });
  }
}
