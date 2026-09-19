import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";
import { toDomain, type User } from "#features/users/domain/user";

export interface ChangePasswordInput {
  newPassword: string;
}

export class ChangePasswordCommand {
  constructor(
    public readonly currentUser: CurrentUser,
    public readonly input: ChangePasswordInput,
  ) {}
}

// CONTRACT: This command sets the password and clears the forced-change flag,
// nothing else. Keep it out of UpdateProfile — a profile update that also
// accepted a password would let a request meant to change a phone number silently
// rewrite a credential. See [[audit-fields]]
@Workflow("change_password")
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler implements ICommandHandler<ChangePasswordCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
  ) {}

  async execute({
    currentUser,
    input,
  }: ChangePasswordCommand): Promise<User | RoutineFailure> {
    // Authorization is the identity itself: the caller proved who they are at
    // the gateway (JWT authorizer → x-user-id), and the password being set is
    // their own. There is no "current password" check — the token IS the proof.
    const target = await currentUser.resolve();
    if (!target) {
      // CONTRACT: Log this branch. No `change_password_started` line exists yet (it
      // needs the email this resolve could not find), so without it a 404 leaves the
      // stream with nothing but the generic `request completed`. No email_hash — the
      // email is what failed to resolve. See [[logging-context]]
      appLogger.warn(
        { app_event: "change_password_failed", reason: "unknown_user" },
        "Password change failed: the caller resolved to no user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "change_password_failed", reason: "unknown_user" });
      return new RoutineFailure("unknown_user");
    }

    setLogContext({ email_hash: hashEmail(target.email), user_id: target.id });
    trace
      .getActiveSpan()
      ?.setAttributes({ email_hash: hashEmail(target.email), user_id: target.id });
    appLogger.info(
      { app_event: "change_password_started", email: maskEmail(target.email) },
      "Starting password change",
    );

    // Cognito first, database second — if Cognito fails, nothing has changed
    // anywhere and a retry is clean. Clearing the flag before a failed password
    // set would tell the frontend to stop asking for a change that never happened.
    try {
      await this.auth.setPassword(target.email, input.newPassword);
    } catch (err) {
      // NEVER log the password. The masked email and the reason are all this
      // line carries beyond the error itself.
      appLogger.error(
        {
          err,
          app_event: "change_password_failed",
          email: maskEmail(target.email),
          reason: "cognito_error",
        },
        "Password change failed: the identity provider rejected the new password",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "change_password_failed", reason: "cognito_error" });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }

    // CONTRACT: Keep the await INSIDE runAsActor — Prisma promises are lazy, so
    // an await outside loses the actor and the audit extension writes null.
    // See [[2026-07-12-prisma-lazy-promise-als]]
    const row = await runAsActor(AuditActor.ChangePassword, () =>
      this.db.user.update({
        where: { id: target.id },
        data: { mustChangePassword: false },
      }),
    );

    await this.mirrorFlagToCognito(target.email, target.id);

    appLogger.info(
      {
        app_event: "change_password_succeeded",
        email: maskEmail(target.email),
        user_id: target.id,
      },
      "Password change completed",
    );

    return toDomain(row as never);
  }

  // Swallows its own failure: the durable write already succeeded, and
  // GET /v1/users/me answers from that column. A miss leaves a stale claim
  // on the next token, not lost state.
  private async mirrorFlagToCognito(email: string, userId: string): Promise<void> {
    try {
      await this.auth.setMustChangePassword(email, false);
    } catch (err) {
      appLogger.warn(
        {
          err,
          app_event: "must_change_password_mirror_failed",
          email: maskEmail(email),
          user_id: userId,
        },
        "Could not mirror mustChangePassword to Cognito (non-fatal): the token claim stays stale until the next write",
      );
    }
  }
}
