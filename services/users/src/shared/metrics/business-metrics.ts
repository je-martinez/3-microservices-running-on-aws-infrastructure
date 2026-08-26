import type { Db } from "../db/prisma.ts";
import type { Env } from "../config/env.ts";
import { trace } from "@opentelemetry/api";
import { appLogger } from "../logging/app-logger.ts";
import { withWorkflowSpan } from "../observability/workflow-tracing.ts";
import type { MetricsPublisher } from "./cloudwatch-metrics.ts";
import { ME_KEY_PREFIX } from "../cache/cache-keys.ts";

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
      // The tick runs on a setInterval, so there is no ambient request span to
      // hang off: without this wrapper each tick's Prisma and CloudWatch spans
      // arrive at Jaeger as their OWN root traces, and the trace list fills up
      // with anonymous `prisma:client:operation` fragments (122 of them were
      // measured) that bury the real request traces.
      //
      // INTERNAL, not CONSUMER — events-pipeline's identically-named
      // `metrics-tick` is CONSUMER because EventBridge wakes it; this one is our
      // own timer and consumes nothing. The name is shared on purpose so it
      // means the same thing in every service.
      //
      // The try/catch stays OUTSIDE the span: a metrics failure must not tumble
      // anything, but the span still has to come out ERROR, and it can only see
      // the error if the throw reaches withWorkflowSpan first.
      //
      // The success line is emitted INSIDE the callback, deliberately: the
      // catch below is outside the span (see above), so a line logged there
      // would carry the enclosing span's id — or none at all — and the span's
      // "View logs" would come back empty. Until this existed there was no way
      // to tell a tick that ran and published from one that never fired at all;
      // the failure path logged, the success path was silent.
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
      // Stays OUT of the span on purpose: the span must SEE the throw to come
      // out ERROR, so it has already ended here. That is the one accepted
      // trade-off in this file — the failure line does not share the tick
      // span's id. The span still tells the failure story on its own (ERROR
      // status + recorded exception with the same message this line carries),
      // and the started/succeeded pair inside the span is what makes a missing
      // `metrics_tick_succeeded` legible as a failed tick.
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
    // The TOTAL as its own published series, not something a dashboard adds
    // up. Two independent reasons, and either alone would justify it:
    //
    // 1. CloudWatch under Floci does not aggregate across dimensions, so a
    //    query omitting HasPassword returns empty — the same reason
    //    emails_sent_total publishes an EmailType=ALL series.
    // 2. Summing the two series in PromQL does not work either: the
    //    collector stamps each scrape with a distinct start_time, so the two
    //    breakdowns rarely share a timestamp and `sum()` silently returns
    //    just one of them. That produced a "total users" card reading 9 while
    //    its own "with password" breakdown read 450.
    //
    // Publishing the sum from here — one number, one timestamp, computed
    // where the data actually lives — sidesteps both.
    await this.metrics.publish("users_total", withPassword + withoutPassword, {
      Service: "users",
      HasPassword: "ALL",
    });

    // Seed the failure counters at zero on every tick.
    //
    // These are emitted from the error paths, so until something actually
    // fails the series does not exist at all — and a panel over a
    // non-existent stream renders "Error Loading Data". That is the worst
    // possible behaviour for an incident card: the one that should read
    // "no errors" is the one that looks broken, and a real outage is then
    // indistinguishable from a healthy system.
    //
    // Publishing a 0 costs nothing arithmetically: CloudWatch sums the data
    // within a period, so a zero alongside real increments leaves the count
    // unchanged. The same reasoning already governs users_total's own
    // breakdown — a value with no users publishes 0 rather than skipping.
    await Promise.all(
      ["4xx", "5xx"].map((statusClass) =>
        this.metrics.publish("http_errors_total", 0, {
          Service: "users",
          StatusClass: statusClass,
        }),
      ),
    );

    // The BUSINESS counters get the same treatment, for a subtler reason.
    //
    // These do fire in normal operation, so unlike the error counters their
    // series does exist — but only while traffic is flowing. Narrow the
    // dashboard's time range to a quiet hour and the series has no points in
    // it, and the panel does not render "0": OpenObserve's metric panel
    // throws `Cannot read properties of undefined (reading 'values')` and
    // shows "Error Loading Data". So the card breaks precisely when the
    // answer is the least alarming one — nobody registered in the last five
    // minutes.
    //
    // Seeding keeps a datapoint in every window, which is what makes the
    // time picker behave: a quiet range reads 0 instead of erroring. Summing
    // a 0 changes no count.
    await Promise.all([
      this.metrics.publish("users_registered_total", 0, { Service: "users" }),
      this.metrics.publish("password_resets_total", 0, { Service: "users" }),
    ]);

    // The cache counters get the same seeding as the error and business
    // counters above, for the reason spelled out there: a panel over a series
    // that has no datapoint in the selected window does not render "0" — it
    // throws and shows "Error Loading Data". So the hit-rate card breaks
    // exactly when the answer is "nobody read a profile in the last five
    // minutes", which is the least alarming answer there is.
    //
    // `bypass` is seeded alongside hit/miss even though it should stay at zero
    // in a healthy system — a card that reads "Error Loading Data" until the
    // first Redis outage is a card nobody trusts when the outage arrives.
    //
    // NOT seeded: cache_operation_duration_ms. That is a duration, and a
    // synthetic 0ms every tick would pull every average and percentile toward
    // zero, reporting a fast cache precisely when nothing is being cached.
    // Seeding a COUNTER is arithmetically free (CloudWatch sums within a
    // period); seeding a duration is a lie.
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
