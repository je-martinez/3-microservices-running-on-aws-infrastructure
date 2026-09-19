import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import type { CascadeClient } from "#shared/http/cascade-client";
import type { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import type { CacheGateway } from "#shared/cache/cache-gateway";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { setLogContext } from "#shared/logging/log-context";
import { trace } from "@opentelemetry/api";
import { CascadeFailedError, CascadeUnavailableError } from "#shared/http/cascade-client";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";

export type DeleteAccountResult = "deleted" | "not_found";

// CONTRACT: Cascade FIRST, account LAST. The reverse is unrecoverable — an account
// deleted before a failing cascade leaves the user unable to authenticate, so they
// cannot retry, and their orders are orphaned. In this order a failure leaves the
// account alive and the user retries; both internal routes are idempotent, so the
// succeeded leg re-runs as a no-op and the inconsistency self-heals. That is why no
// compensating "undelete" exists in any of the three services.
export class DeleteAccountCommand {
  private readonly db: Db;
  private readonly cascade: CascadeClient;
  private readonly auth: AuthProvider;
  private readonly metrics: MetricsPublisher;
  // OPTIONAL on purpose, mirroring `resolveGateway`'s guard in cache-hooks.ts.
  // With CACHE_ENABLED=false the gateway is still registered and simply no-ops,
  // but a container that registers none at all (the route tests build exactly
  // that) must still be able to delete an account. An account deletion that
  // 500s because no cache is wired would be a far worse bug than a stale entry.
  private readonly cacheGateway: CacheGateway | undefined;

  constructor({
    db,
    cascade,
    auth,
    metricsPublisher,
    cacheGateway,
  }: {
    db: Db;
    cascade: CascadeClient;
    auth: AuthProvider;
    metricsPublisher: MetricsPublisher;
    cacheGateway?: CacheGateway;
  }) {
    this.db = db;
    this.cascade = cascade;
    this.auth = auth;
    this.metrics = metricsPublisher;
    this.cacheGateway = cacheGateway;
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

    // CONTRACT: Refuse a missing `cognitoSub` up front; do NOT pass `?? ""`. It is
    // the ownership key both downstream services filter by, and an empty string is
    // rejected by Orders with a 400 and matched against nothing by Tracking, failing
    // the deletion with a status that says nothing about the cause. A 502 is right:
    // the deletion did not happen, the account is intact, and retrying is correct.
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

    // 1 & 2 — the cascades. A throw propagates to the route as a 502 with the account
    // still intact. Logged here so the line names WHICH leg failed; `reason` records
    // the service.
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

    // CONTRACT: Invalidate AFTER the delete, and FAIL-OPEN. Invalidating first lets a
    // concurrent read repopulate the entry from a row that still exists, leaving a
    // profile for a deleted account readable for the full TTL. Postgres has already
    // committed here, so throwing on a Redis failure would report a deletion that did
    // not happen.
    try {
      await this.cacheGateway?.invalidate(
        ME_KEY_PREFIX,
        meCacheKey(target.cognitoSub, target.id),
      );
    } catch (err) {
      // WARN, not ERROR: the account IS gone and the stale entry expires on its own.
      // WARNING: Log only the key PREFIX — the full key carries cognito_sub and
      // user_id. See [[logging-context]]
      appLogger.warn(
        {
          err,
          app_event: "cache_unavailable",
          reason: "redis_error",
          cache_operation: "del",
          cache_key_prefix: ME_KEY_PREFIX,
          email_hash,
          user_id: target.id,
        },
        "Account deleted, but its cached profile could not be invalidated; it expires on its own TTL",
      );
    }

    // CONTRACT: Best-effort — Postgres has committed, so failing here would tell the
    // user their deletion did not happen when it did. Alert on it anyway: this is the
    // one failure that leaves an orphan in the pool and blocks the person from ever
    // registering with this address again.
    try {
      await this.auth.deleteUser(target.email);
    } catch (err: any) {
      // `err` rides along, not just its name — a bare "Error" with no stack or AWS
      // metadata is not enough to act on in the alert-worthy branch.
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
