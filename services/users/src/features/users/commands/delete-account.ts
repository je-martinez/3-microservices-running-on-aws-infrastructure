import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import type { CascadeClient } from "#shared/http/cascade-client";
import type { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { setLogContext } from "#shared/logging/log-context";
import { trace } from "@opentelemetry/api";
import { CascadeFailedError, CascadeUnavailableError } from "#shared/http/cascade-client";
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
  private readonly metrics: MetricsPublisher;

  constructor({
    db,
    cascade,
    auth,
    metricsPublisher,
  }: {
    db: Db;
    cascade: CascadeClient;
    auth: AuthProvider;
    metricsPublisher: MetricsPublisher;
  }) {
    this.db = db;
    this.cascade = cascade;
    this.auth = auth;
    this.metrics = metricsPublisher;
  }

  async execute(currentUser: CurrentUser): Promise<DeleteAccountResult> {
    return withWorkflowSpan("delete_account", { app_event: "delete_account_started" }, () =>
      this.doExecute(currentUser),
    );
  }

  private async doExecute(currentUser: CurrentUser): Promise<DeleteAccountResult> {
    const target = await currentUser.resolve();
    if (!target) {
      // No `_started` line has been emitted yet at this point (it needs the user
      // this resolve failed to find), so without this the 404 would leave the log
      // stream with nothing but the generic `request completed`.
      appLogger.warn(
        { app_event: "delete_account_failed", reason: "not_found" },
        "Account deletion failed: the caller resolved to no user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "delete_account_failed", reason: "not_found" });
      return "not_found";
    }

    const email_hash = hashEmail(target.email);

    // Enriches every LATER line of this request, including the cascade client's
    // own. Mirrored onto the span so trace and logs carry the same identity.
    setLogContext({ email_hash, user_id: target.id });
    trace.getActiveSpan()?.setAttributes({ email_hash, user_id: target.id });

    // `email_hash`, never the address itself: this is not an auth flow, so it
    // does not get the masked-email exemption ([[logging-context]]).
    appLogger.info(
      { app_event: "delete_account_started", email_hash, user_id: target.id },
      "Starting account deletion",
    );

    // `cognitoSub` is the ownership key BOTH downstream services filter by, and
    // the column is nullable. Passing `?? ""` would send an empty string that
    // Orders rejects with a 400 and Tracking matches against nothing — the
    // deletion would fail with a downstream status code that says nothing about
    // the real cause, and (before this branch existed) said it silently.
    //
    // Refused up front instead, with a reason that names the actual problem. A
    // 502 is right even though nothing downstream was asked: from the caller's
    // side this is the same fact as a leg not confirming — the deletion did not
    // happen, the account is intact, and retrying is the correct response (it
    // will keep failing until the row gets a sub, which is an operator fix).
    if (!target.cognitoSub) {
      appLogger.error(
        {
          app_event: "delete_account_failed",
          email_hash,
          user_id: target.id,
          reason: "missing_cognito_sub",
        },
        "Account deletion failed: the user has no Cognito sub to cascade on",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "delete_account_failed", reason: "missing_cognito_sub" });
      throw new CascadeUnavailableError("missing_cognito_sub");
    }

    // 1 & 2 — the cascades. A throw here propagates to the route as a 502 with
    // the account still intact, which is exactly the recoverable state we want.
    //
    // Logged HERE rather than left to propagate silently: this is the failure a
    // 502 sends the user away with, and without a line naming WHICH leg failed,
    // the one question worth asking of the logs has no answer. The error carries
    // the service; `reason` records it.
    try {
      await this.cascade.deleteOrdersForUser(target.cognitoSub, target.id);
      await this.cascade.deleteTrackingsForUser(target.cognitoSub, target.id);
    } catch (err) {
      const reason =
        err instanceof CascadeFailedError ? `cascade_failed_${err.service}` : "cascade_failed";
      appLogger.error(
        { err, app_event: "delete_account_failed", email_hash, user_id: target.id, reason },
        "Account deletion failed: a cascade leg did not confirm",
      );
      trace.getActiveSpan()?.setAttributes({ app_event: "delete_account_failed", reason });
      throw err; // rethrown untouched — the route maps it to 502
    }

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
    } catch (err: any) {
      // `err` rides along, not just its name: this is the alert-worthy branch,
      // and a bare "Error" with no stack or AWS metadata is not enough to act on.
      appLogger.error(
        {
          err,
          app_event: "delete_account_cognito_orphan",
          reason: err?.name ?? "unknown",
          email_hash,
          user_id: target.id,
        },
        "Account deleted, but its Cognito account survived — the email stays blocked",
      );
      trace.getActiveSpan()?.setAttributes({
        app_event: "delete_account_cognito_orphan",
        reason: err?.name ?? "unknown",
      });
    }

    appLogger.info(
      { app_event: "delete_account_succeeded", email_hash, user_id: target.id },
      "Account deleted",
    );
    trace.getActiveSpan()?.setAttribute("app_event", "delete_account_succeeded");

    // The counterpart to `users_registered_total`: without it the fleet can only
    // measure sign-ups, so the population looks monotonically increasing and
    // churn is invisible. Published AFTER the durable write, like every other
    // counter here, and awaited but non-fatal for the same reason the publisher
    // swallows its own errors — a metrics outage must not fail a deletion that
    // already happened.
    await this.metrics.publish("users_deleted_total", 1, { Service: "users" });

    return "deleted";
  }
}
