import type { Db } from "../db/prisma.ts";
import type { Env } from "../config/env.ts";
import { appLogger } from "../logging/app-logger.ts";
import type { MetricsPublisher } from "./cloudwatch-metrics.ts";

/**
 * Periodically publishes gauge metrics describing the CURRENT state of the users
 * table.
 *
 * These are gauges, not counters, on purpose: "how many users have no password"
 * is a question about state. A counter would have to decrement when a user sets
 * one, which counters cannot do, and would drift from the database with no way to
 * explain the difference.
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
      // Two counts rather than a groupBy: a groupBy omits rows for a value with no
      // users at all, which would silently stop publishing that series instead of
      // publishing a 0 — and a series that stops updating reads as "no data" in a
      // dashboard, not as "zero".
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
    } catch (err) {
      appLogger.warn(
        {
          app_event: "metrics_collection_failed",
          reason: err instanceof Error ? err.message : String(err),
        },
        "failed to collect business metrics",
      );
    }
  }
}
