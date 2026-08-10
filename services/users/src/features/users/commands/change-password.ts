import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
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
  async execute(currentUser: CurrentUser, input: ChangePasswordInput): Promise<User | null> {
    // Authorization is the identity itself: the caller proved who they are at
    // the gateway (JWT authorizer → x-user-id), and the password being set is
    // their own. There is no "current password" check — the token IS the proof,
    // the same standard every other /me route holds.
    const target = await currentUser.resolve();
    if (!target) return null;

    setLogContext({ email_hash: hashEmail(target.email), user_id: target.id });
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
