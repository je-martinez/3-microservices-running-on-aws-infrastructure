import { Inject, Optional } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import {
  CascadeClient,
  CascadeFailedError,
  CascadeUnavailableError,
} from "#shared/http/cascade-client";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { setLogContext } from "#shared/logging/log-context";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";

export type DeleteAccountResult = "deleted" | "not_found";

export class DeleteAccountCommand {
  constructor(public readonly currentUser: CurrentUser) {}
}

// CONTRACT: Cascade FIRST, account LAST. The reverse is unrecoverable.
@Workflow("delete_account")
@CommandHandler(DeleteAccountCommand)
export class DeleteAccountHandler implements ICommandHandler<DeleteAccountCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cascade: CascadeClient,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly metrics: MetricsPublisher,
    @Optional() private readonly cacheGateway?: CacheGateway,
  ) {}

  async execute({
    currentUser,
  }: DeleteAccountCommand): Promise<DeleteAccountResult | RoutineFailure<DeleteAccountResult>> {
    const target = await currentUser.resolve();
    if (!target) {
      appLogger.warn(
        { app_event: "delete_account_failed", reason: "not_found" },
        "Account deletion failed: the caller resolved to no user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "delete_account_failed", reason: "not_found" });
      // Preserve the original `"not_found"` return value for the HTTP layer.
      return new RoutineFailure("not_found", "not_found");
    }

    const email_hash = hashEmail(target.email);
    setLogContext({ email_hash, user_id: target.id });
    trace.getActiveSpan()?.setAttributes({ email_hash, user_id: target.id });
    appLogger.info(
      { app_event: "delete_account_started", email_hash, user_id: target.id },
      "Starting account deletion",
    );

    // CONTRACT: Refuse a missing `cognitoSub` up front; do NOT pass `?? ""`.
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
      throw err;
    }

    // CONTRACT: Keep the await INSIDE runAsActor — Prisma promises are lazy.
    // See [[2026-07-12-prisma-lazy-promise-als]]
    await runAsActor(AuditActor.DeleteAccount, () =>
      this.db.user.delete({ where: { id: target.id } }),
    );

    try {
      await this.cacheGateway?.invalidate(
        ME_KEY_PREFIX,
        meCacheKey(target.cognitoSub, target.id),
      );
    } catch (err) {
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

    try {
      await this.auth.deleteUser(target.email);
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "unknown";
      appLogger.error(
        {
          err,
          app_event: "delete_account_cognito_orphan",
          reason: name,
          email_hash,
          user_id: target.id,
        },
        "Account deleted, but its Cognito account survived — the email stays blocked",
      );
      trace.getActiveSpan()?.setAttributes({
        app_event: "delete_account_cognito_orphan",
        reason: name,
      });
    }

    appLogger.info(
      { app_event: "delete_account_succeeded", email_hash, user_id: target.id },
      "Account deleted",
    );
    trace.getActiveSpan()?.setAttribute("app_event", "delete_account_succeeded");

    await this.metrics.publish("users_deleted_total", 1, { Service: "users" });

    return "deleted";
  }
}
