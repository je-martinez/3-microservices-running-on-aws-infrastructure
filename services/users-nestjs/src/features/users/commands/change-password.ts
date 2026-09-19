import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { toDomain, type User } from "../domain/user.ts";

export interface ChangePasswordInput {
  newPassword: string;
}

// CONTRACT: This command sets the password and clears the forced-change flag,
// nothing else. Keep it out of UpdateProfileCommand — a profile update that also
// accepted a password would let a request meant to change a phone number silently
// rewrite a credential, and the audit trail could not tell the two apart.
export class ChangePasswordCommand {
  private readonly db: Db;
  private readonly auth: AuthProvider;

  constructor({ db, auth }: { db: Db; auth: AuthProvider }) {
    this.db = db;
    this.auth = auth;
  }

  // Returns null when the caller resolves to no user, so the route answers the same
  // 404 the other /me routes do. The span opens BEFORE `currentUser.resolve()` so the
  // unresolved-caller 404 is not the one path with no span at all.
  // WARNING: No PII on the span — `email_hash` only once the user resolves, and the
  // new password never appears here. See [[logging-context]]
  async execute(currentUser: CurrentUser, input: ChangePasswordInput): Promise<User | null> {
    return withWorkflowSpan("change_password", { app_event: "change_password_started" }, () =>
      this.doExecute(currentUser, input),
    );
  }

  private async doExecute(
    currentUser: CurrentUser,
    input: ChangePasswordInput,
  ): Promise<User | null> {
    // Authorization is the identity itself: the caller proved who they are at
    // the gateway (JWT authorizer → x-user-id), and the password being set is
    // their own. There is no "current password" check — the token IS the proof,
    // the same standard every other /me route holds.
    const target = await currentUser.resolve();
    if (!target) {
      // CONTRACT: Log this branch. No `change_password_started` line exists yet (it
      // needs the email this resolve could not find), so without it a 404 leaves the
      // stream with nothing but the generic `request completed`. Inside the span, so
      // it shares the flow's span_id. No email_hash — the email is what failed to
      // resolve; identity still reaches the line via the request log context.
      appLogger.warn(
        { app_event: "change_password_failed", reason: "unknown_user" },
        "Password change failed: the caller resolved to no user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "change_password_failed", reason: "unknown_user" });
      return null;
    }

    setLogContext({ email_hash: hashEmail(target.email), user_id: target.id });
    trace
      .getActiveSpan()
      ?.setAttributes({ email_hash: hashEmail(target.email), user_id: target.id });
    appLogger.info(
      { app_event: "change_password_started", email: maskEmail(target.email) },
      "Starting password change",
    );

    // Cognito first, database second — same ordering argument as the reset
    // confirmation: if Cognito fails, nothing has changed anywhere and a retry
    // is clean. Clearing the flag before a failed password set would tell the
    // frontend to stop asking for a change that never happened.
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

    const row = await runAsActor(AuditActor.ChangePassword, () =>
      this.db.user.update({
        where: { id: target.id },
        // The ONLY field this command writes. `mustChangePassword` is cleared
        // because the user has just done exactly what it was demanding.
        data: { mustChangePassword: false },
      }),
    );

    // Mirror the cleared flag onto Cognito so the NEXT token carries
    // must_change_password=false. Best-effort by design: the durable write above
    // already succeeded, and GET /v1/users/me — what the frontend actually reads
    // — answers from that column. Failing the request here would report an error
    // for a password change that did happen.
    await this.mirrorFlagToCognito(target.email, target.id);

    appLogger.info(
      {
        app_event: "change_password_succeeded",
        email: maskEmail(target.email),
        user_id: target.id,
      },
      "Password change completed",
    );
    trace.getActiveSpan()?.setAttribute("app_event", "change_password_succeeded");

    return toDomain(row as any);
  }

  // Swallows its own failure, like the event publisher in register.ts: the
  // consequence of a miss is a stale claim on the next token, not lost state.
  // Logged with a distinct app_event so the drift is observable rather than
  // silent — an operator seeing these knows tokens may disagree with Postgres.
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
