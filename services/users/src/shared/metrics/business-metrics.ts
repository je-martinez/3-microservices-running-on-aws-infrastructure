import type { Db } from "../db/prisma.ts";
import type { Env } from "../config/env.ts";
import { trace } from "@opentelemetry/api";
import { appLogger } from "../logging/app-logger.ts";
import { withWorkflowSpan } from "../observability/workflow-tracing.ts";
import type { MetricsPublisher } from "./cloudwatch-metrics.ts";
import { ME_KEY_PREFIX } from "../cache/cache-keys.ts";

/**
 * Periodically publishes gauge metrics describing the CURRENT state of the users
 * table. Gauges, not counters: "how many users have no password" is a question
 * about state, and a counter cannot decrement when a user sets one.
 */
export class BusinessMetricsPoller {
  private readonly db: Db;
  private readonly metrics: MetricsPublisher;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor({
    db,
    metricsPublisher,
    env,
  }: {
    db: Db;
    metricsPublisher: MetricsPublisher;
    env: Env;
  }) {
    this.db = db;
    this.metrics = metricsPublisher;
    this.intervalMs = env.METRICS_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    // unref() so a pending timer never holds the process open at shutdown.
    this.timer = setInterval(() => {
      void this.collectAndPublish();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One tick. Public so tests can drive it without waiting on a timer. */
  async collectAndPublish(): Promise<void> {
    try {
      // CONTRACT: Wrap the tick in a span and log success INSIDE the callback. A
      // setInterval tick has no ambient request span, so without the wrapper every
      // Prisma and CloudWatch span becomes its own root trace and anonymous
      // `prisma:client:operation` fragments bury the real request traces. The
      // try/catch stays OUTSIDE so the throw reaches withWorkflowSpan and the span
      // comes out ERROR. INTERNAL, not CONSUMER: our own timer consumes nothing.
      // See [[logging-context]]
      await withWorkflowSpan("metrics-tick", { app_event: "metrics_tick_started" }, async () => {
        const counts = await this.collectAndPublishTick();
        trace.getActiveSpan()?.setAttribute("app_event", "metrics_tick_succeeded");
        appLogger.info(
          {
            app_event: "metrics_tick_succeeded",
            users_with_password: counts.withPassword,
            users_without_password: counts.withoutPassword,
            users_total: counts.withPassword + counts.withoutPassword,
          },
          "published business metrics",
        );
      });
    } catch (err) {
      // Outside the span so it can see the throw, which costs this line the tick
      // span's id. The span carries ERROR status and the recorded exception, and a
      // missing `metrics_tick_succeeded` is what marks the tick as failed.
      appLogger.warn(
        {
          app_event: "metrics_collection_failed",
          reason: err instanceof Error ? err.message : String(err),
        },
        "failed to collect business metrics",
      );
    }
  }

  /**
   * The tick's actual work, run inside the `metrics-tick` span. Returns the two
   * counts it published so the caller's success line can state WHAT went out —
   * "the tick ran" alone would not distinguish a healthy publish from one that
   * shipped zeros because the query silently matched nothing.
   */
  private async collectAndPublishTick(): Promise<{
    withPassword: number;
    withoutPassword: number;
  }> {
    // CONTRACT: Two counts, not a groupBy — a groupBy omits rows for a value with no
    // users, so the series stops publishing instead of publishing a 0, and a stalled
    // series reads as "no data" in a dashboard rather than "zero".
    const withPassword = await this.db.user.count({
      where: { authType: "PASSWORD", deletedAt: null },
    });
    const withoutPassword = await this.db.user.count({
      where: { authType: "PASSWORDLESS", deletedAt: null },
    });

    await this.metrics.publish("users_total", withPassword, {
      Service: "users",
      HasPassword: "true",
    });
    await this.metrics.publish("users_total", withoutPassword, {
      Service: "users",
      HasPassword: "false",
    });
    // CONTRACT: Publish the TOTAL as its own series; do NOT expect a dashboard to
    // sum the two. CloudWatch under Floci does not aggregate across dimensions, and
    // PromQL `sum()` silently returns one breakdown because the collector stamps
    // each scrape with a distinct start_time — a "total users" card read 9 while its
    // own "with password" breakdown read 450.
    await this.metrics.publish("users_total", withPassword + withoutPassword, {
      Service: "users",
      HasPassword: "ALL",
    });

    // CONTRACT: Seed the failure counters at zero every tick. They are only emitted
    // from error paths, so until something fails the series does not exist and the
    // panel renders "Error Loading Data" — the card that should read "no errors"
    // looks broken, and a real outage becomes indistinguishable from a healthy
    // system. A 0 is free: CloudWatch sums within a period.
    await Promise.all(
      ["4xx", "5xx"].map((statusClass) =>
        this.metrics.publish("http_errors_total", 0, {
          Service: "users",
          StatusClass: statusClass,
        }),
      ),
    );

    // CONTRACT: Seed the business counters too. Their series exists only while
    // traffic flows, so a quiet time range has no points and OpenObserve's panel
    // throws `Cannot read properties of undefined (reading 'values')` — the card
    // breaks precisely when the answer is "nobody registered". Seeding keeps a
    // datapoint in every window; summing a 0 changes no count.
    await Promise.all([
      this.metrics.publish("users_registered_total", 0, { Service: "users" }),
      this.metrics.publish("password_resets_total", 0, { Service: "users" }),
      // Deletions are rarest, so this is the series most often empty over a narrow
      // range — the case the seeding above exists for.
      this.metrics.publish("users_deleted_total", 0, { Service: "users" }),
    ]);

    // CONTRACT: Seed the cache counters — including `bypass`, which should stay at
    // zero — for the reason above. Do NOT seed cache_operation_duration_ms: a
    // synthetic 0ms every tick drags every average and percentile toward zero and
    // reports a fast cache precisely when nothing is being cached. Seeding a counter
    // is free (CloudWatch sums within a period); seeding a duration is a lie.
    await Promise.all(
      (["hit", "miss", "bypass"] as const).map((result) =>
        this.metrics.publish("cache_requests_total", 0, {
          Service: "users",
          // The PREFIX, never a key — the same rule the gateway follows. Users
          // has exactly one cached endpoint, so this list is exactly one entry
          // long; a second cached route would add its prefix here.
          KeyPrefix: ME_KEY_PREFIX,
          Result: result,
        }),
      ),
    );

    return { withPassword, withoutPassword };
  }
}
