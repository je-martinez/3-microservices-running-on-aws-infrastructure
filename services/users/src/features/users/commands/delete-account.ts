import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import type { CascadeClient } from "#shared/http/cascade-client";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export type DeleteAccountResult = "deleted" | "not_found";

// Deletes the caller's own account and everything that belongs to it.
//
// ## The ORDER is the safety argument
//
// Cascade FIRST, account LAST. The reverse order is unrecoverable: an account
// deleted before a failing cascade leaves the user unable to authenticate, so
// they cannot retry, and their orders are orphaned with no path to fix them.
// With this order a failure leaves the account alive and the user simply retries.
//
// Both internal routes are idempotent (`deleted_at IS NULL` guards), so a retry
// after a half-finished cascade re-runs the succeeded leg as a no-op. The
// inconsistency is transient and self-healing, which is why no compensation
// exists: an "undelete" primitive is absent from all three services and would be
// more new surface than the feature itself.
export class DeleteAccountCommand {
  private readonly db: Db;
  private readonly cascade: CascadeClient;
  private readonly auth: AuthProvider;

  constructor({ db, cascade, auth }: { db: Db; cascade: CascadeClient; auth: AuthProvider }) {
    this.db = db;
    this.cascade = cascade;
    this.auth = auth;
  }

  async execute(currentUser: CurrentUser): Promise<DeleteAccountResult> {
    return withWorkflowSpan("delete_account", { app_event: "delete_account_started" }, () =>
      this.doExecute(currentUser),
    );
  }

  private async doExecute(currentUser: CurrentUser): Promise<DeleteAccountResult> {
    const target = await currentUser.resolve();
    if (!target) {
      appLogger.info({
        app_event: "delete_account_failed",
        reason: "not_found",
      });
      return "not_found";
    }

    const email_hash = hashEmail(target.email);

    // 1 & 2 — the cascades. A throw here propagates to the route as a 502 with
    // the account still intact, which is exactly the recoverable state we want.
    //
    // `cognitoSub` is nullable on the model but is the ownership key both
    // downstream services filter by. An empty string cannot match any row there,
    // so a user without one cascades to zero rows rather than to everyone's.
    await this.cascade.deleteOrdersForUser(target.cognitoSub ?? "");
    await this.cascade.deleteTrackingsForUser(target.cognitoSub ?? "", target.id);

    // 3 — our own row. `delete` is rewritten into an UPDATE stamping deletedAt and
    // deletedBy by the cross-cutting Prisma extension: no SQL DELETE is issued,
    // and the write user holds no DELETE grant anyway ([[ADR-0004-soft-delete-only]]).
    // The row keeps its real email; the partial unique index is what frees the
    // address for re-registration.
    await runAsActor(AuditActor.DeleteAccount, () =>
      this.db.user.delete({ where: { id: target.id } }),
    );

    // 4 — Cognito: the point of no return, and what actually frees the email.
    //
    // Best-effort BY DESIGN. Postgres has already committed, so failing the
    // request here would tell the user their deletion did not happen when it did.
    // But this is the one failure in the flow that deserves an alert: it leaves an
    // orphan in the pool that will block this person from ever registering again
    // with this address — the precise outcome the feature exists to prevent.
    try {
      await this.auth.deleteUser(target.email);
    } catch (e: any) {
      appLogger.error({
        app_event: "delete_account_cognito_orphan",
        reason: e?.name ?? "unknown",
        email_hash,
        user_id: target.id,
      });
    }

    appLogger.info({
      app_event: "delete_account_succeeded",
      email_hash,
      user_id: target.id,
    });

    return "deleted";
  }
}
