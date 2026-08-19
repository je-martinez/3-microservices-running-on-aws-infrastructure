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

// Constructor-injected from the Awilix cradle (PROXY injection mode).
//
// The dedicated change-password command behind PATCH /v1/users/me/password. It
// does ONE thing: set the new password (and clear the forced-change flag it
// satisfies). It is deliberately NOT part of UpdateProfileCommand — a
// general-purpose profile update that also happened to accept a password would
// let a request meant to change a phone number silently rewrite a credential,
// and would make the audit trail unable to say which of the two a given call was.
export class ChangePasswordCommand {
  private readonly db: Db;
  private readonly auth: AuthProvider;

  constructor({ db, auth }: { db: Db; auth: AuthProvider }) {
    this.db = db;
    this.auth = auth;
  }

  // Returns null when the caller's identity resolves to no user, so the route
  // answers the same 404 `{ error: "not_found" }` the other /me routes do.
  //
  // The span opens BEFORE `currentUser.resolve()`, one step earlier than the
  // `change_password_started` log line, which cannot fire until the email it
  // masks is known. That is deliberate: the unresolved-caller 404 is a real
  // outcome of this workflow and would otherwise be the one path with no span
  // at all. It is marked with its own `reason` below rather than left blank.
  //
  // No PII on the span: `email_hash` is set once the user resolves; the new
  // password never appears here, exactly as it never appears in a log line.
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
      // The one path of this flow that used to return silently: no started
      // line had been emitted yet (it needs the email this resolve failed to
      // find), so a 404 here left the log stream with nothing but the generic
      // `request completed`. Logged inside the span, so it shares the
      // `change_password` span_id like every other line of the flow.
      //
      // No email_hash: the email is precisely what could not be resolved. The
      // caller's identity still reaches the line through the request log
      // context.
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
