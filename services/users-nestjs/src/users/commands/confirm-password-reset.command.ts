import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { Db } from "#shared/db/prisma";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { InvalidResetCodeError } from "#shared/auth/auth-errors";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface ConfirmPasswordResetInput {
  email: string;
  code: string;
  newPassword: string;
}

export class ConfirmPasswordResetCommand {
  constructor(public readonly input: ConfirmPasswordResetInput) {}
}

@Workflow("password_reset_confirm")
@CommandHandler(ConfirmPasswordResetCommand)
export class ConfirmPasswordResetHandler implements ICommandHandler<ConfirmPasswordResetCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly resetCodeStore: ResetCodeStore,
    private readonly metrics: MetricsPublisher,
    private readonly cacheGateway: CacheGateway,
  ) {}

  // WARNING: Never put `input.code` or `input.newPassword` on a span attribute.
  async execute({ input }: ConfirmPasswordResetCommand): Promise<void> {
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "password_reset_confirm_started", email: maskEmail(input.email) },
      "Starting password reset confirmation",
    );

    // CONTRACT: Every rejection throws the SAME InvalidResetCodeError — unknown
    // email, no outstanding code, expired code, wrong code.
    const user = await this.db.user.findFirst({ where: { email: input.email } });
    if (!user) {
      this.reject(input.email, "unknown_email");
    }

    setLogContext({ user_id: user!.id });

    const accepted = await this.resetCodeStore.verifyAndConsume(input.email, input.code);
    if (!accepted) {
      this.reject(input.email, "invalid_or_expired_code");
    }

    // CONTRACT: The code is consumed BEFORE Cognito is called. Do NOT reorder.
    await this.auth.setPassword(input.email, input.newPassword);

    // CONTRACT: Keep the await INSIDE runAsActor — Prisma promises are lazy.
    // See [[2026-07-12-prisma-lazy-promise-als]]
    await runAsActor(AuditActor.PasswordResetConfirmed, () =>
      this.db.user.update({
        where: { id: user!.id },
        data: { mustChangePassword: false },
      }),
    );

    const cognitoSub = (user as { cognitoSub?: string | null } | null)?.cognitoSub;
    if (cognitoSub) {
      await this.cacheGateway.invalidate(ME_KEY_PREFIX, meCacheKey(cognitoSub, user!.id));
    }

    try {
      await this.auth.setMustChangePassword(input.email, false);
    } catch (err) {
      appLogger.warn(
        {
          err,
          app_event: "must_change_password_mirror_failed",
          email: maskEmail(input.email),
          user_id: user!.id,
        },
        "Could not mirror mustChangePassword to Cognito (non-fatal): the token claim stays stale until the next write",
      );
    }

    appLogger.info(
      {
        app_event: "password_reset_confirm_succeeded",
        email: maskEmail(input.email),
        user_id: user!.id,
      },
      "Password reset confirmed and new password applied",
    );
    trace.getActiveSpan()?.setAttributes({
      app_event: "password_reset_confirm_succeeded",
      user_id: user!.id,
    });

    await this.metrics.publish("password_resets_total", 1, { Service: "users" });
  }

  private reject(email: string, reason: string): never {
    appLogger.warn(
      { app_event: "password_reset_confirm_failed", email: maskEmail(email), reason },
      "Password reset confirmation rejected",
    );
    trace
      .getActiveSpan()
      ?.setAttributes({ app_event: "password_reset_confirm_failed", reason });
    throw new InvalidResetCodeError();
  }
}
