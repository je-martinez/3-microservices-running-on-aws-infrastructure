import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { RedisClient } from "./redis.ts";
import type { Env } from "../config/env.ts";
import type { MetricsPublisher } from "../metrics/cloudwatch-metrics.ts";
import { appLogger } from "../logging/app-logger.ts";

// Per-operation budget. The cache exists to make a read faster; an operation
// that outruns this has already failed at its only job, so we stop waiting and
// answer from Postgres. 50ms is the figure in the design spec.
const TIMEOUT_MS = 50;

const tracer = trace.getTracer("users-cache");

export interface CacheGetResult<T> {
  hit: boolean;
  value: T | undefined;
  ttlRemaining: number | undefined;
  // Distinct from `hit: false`. A MISS means Redis answered "not here"; a
  // BYPASS means Redis did not answer at all. They are different operational
  // facts and the metrics keep them apart — bypass is excluded from the
  // hit-rate denominator, so a Redis outage cannot masquerade as a poor
  // hit-rate.
  bypass: boolean;
}

// Transport layer for the response cache: JSON serialization, the timeout, and
// the metric/span/log emission. It knows nothing about HTTP — the hooks own
// that. Holds NO connection of its own: `redis` is the existing SINGLETON
// ioredis client (see redis.ts and the container registration), whose mandatory
// `error` listener is what keeps a reconnect blip from crashing the process.
export class CacheGateway {
  private readonly redis: RedisClient;
  private readonly metrics: MetricsPublisher;
  readonly enabled: boolean;

  constructor({
    redis,
    metricsPublisher,
    env,
  }: {
    redis: RedisClient;
    metricsPublisher: MetricsPublisher;
    env: Env;
  }) {
    this.redis = redis;
    this.metrics = metricsPublisher;
    this.enabled = env.CACHE_ENABLED;
  }

  async get<T>(key: string, keyPrefix: string): Promise<CacheGetResult<T>> {
    if (!this.enabled) {
      return { hit: false, value: undefined, ttlRemaining: undefined, bypass: false };
    }

    const started = Date.now();
    try {
      // Value and remaining TTL in one round trip. A pipeline, not two awaits:
      // two sequential awaits would pay the RTT twice and could read a PTTL
      // for a key that expired between them.
      const [rawValue, rawPttl] = await this.withTimeout(
        this.redis
          .pipeline()
          .get(key)
          .pttl(key)
          .exec()
          .then(
            (replies) =>
              [replies?.[0]?.[1] as string | null, replies?.[1]?.[1] as number] as const,
          ),
        "get",
      );

      const durationMs = Date.now() - started;

      if (rawValue === null || rawValue === undefined) {
        this.report("miss", keyPrefix, "get", durationMs, undefined);
        return { hit: false, value: undefined, ttlRemaining: undefined, bypass: false };
      }

      // ioredis PTTL: -2 = no such key, -1 = key with no expiry. Neither is a
      // sane "seconds remaining", so both collapse to undefined and the HIT
      // simply ships without an X-Cache-TTL header rather than with a lie.
      const ttlRemaining = rawPttl > 0 ? Math.ceil(rawPttl / 1000) : undefined;
      const value = JSON.parse(rawValue) as T;
      this.report("hit", keyPrefix, "get", durationMs, ttlRemaining);
      return { hit: true, value, ttlRemaining, bypass: false };
    } catch (err) {
      // FAIL OPEN. Includes a JSON.parse failure on a corrupt entry: a body we
      // cannot deserialize is indistinguishable, for the caller, from Redis
      // being down — both mean "answer from Postgres".
      this.reportUnavailable(err, keyPrefix, "get", Date.now() - started);
      return { hit: false, value: undefined, ttlRemaining: undefined, bypass: true };
    }
  }

  async set(key: string, keyPrefix: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.enabled) return;

    const started = Date.now();
    try {
      // `EX` (not a follow-up PEXPIRE) so the value and its lifetime are set in
      // ONE command — same argument as reset-code-store.ts: a crash between a
      // SET and a separate expire leaves a never-expiring entry behind.
      await this.withTimeout(this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds), "set");
      this.reportDuration("set", Date.now() - started);
    } catch (err) {
      // A cache-write failure never affects the response. The caller has
      // already produced a correct body; this is bookkeeping.
      this.reportUnavailable(err, keyPrefix, "set", Date.now() - started);
    }
  }

  async invalidate(keyPrefix: string, ...keys: string[]): Promise<void> {
    if (!this.enabled || keys.length === 0) return;

    try {
      // Variadic DEL, one round trip regardless of key count.
      await this.withTimeout(this.redis.del(...keys), "del");
    } catch (err) {
      // Swallowed, and this is the one swallow that deserves its own note.
      // Invalidation runs AFTER the write has persisted, so a failure here
      // leaves a stale entry that the 5-minute TTL still clears. Throwing
      // would turn a successful profile update into a 500 for the user, which
      // is strictly worse than five minutes of staleness.
      this.reportUnavailable(err, keyPrefix, "del", 0);
    }
  }

  // Rejects with a named error rather than hanging on ioredis' own retry
  // schedule. `maxRetriesPerRequest: 2` (redis.ts) already bounds a command
  // during an outage, but not one against a Redis that is UP and merely slow —
  // which is the case this budget exists for.
  private withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`cache ${label} exceeded ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      );
      // unref() so a pending timer never holds the process open at shutdown —
      // same reasoning as BusinessMetricsPoller's interval.
      timer.unref();
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }

  // ==== ONLY THE PREFIX EVER LEAVES THIS CLASS ====
  // `keyPrefix` is "users:me:v1"; the full key carries cognito_sub and user_id.
  // A CloudWatch dimension value is unbounded-cardinality billing AND an export
  // destination, and so is a span attribute. Neither may ever receive the key.
  private report(
    result: "hit" | "miss" | "bypass",
    keyPrefix: string,
    operation: "get" | "set" | "del",
    durationMs: number,
    ttlRemaining: number | undefined,
  ): void {
    const span = trace.getActiveSpan();
    span?.setAttributes({
      "cache.result": result,
      "cache.key_prefix": keyPrefix,
      ...(ttlRemaining !== undefined ? { "cache.ttl_remaining": ttlRemaining } : {}),
    });

    // Deliberately NOT awaited and never rethrown: `publish` swallows its own
    // failures by contract (cloudwatch-metrics.ts) so there is no unhandled
    // rejection, and awaiting a PutMetricData round trip inside a cached read
    // would hand back the latency the cache just saved.
    void this.metrics.publish("cache_requests_total", 1, {
      Service: "users",
      KeyPrefix: keyPrefix,
      Result: result,
    });
    this.reportDuration(operation, durationMs);
  }

  private reportDuration(operation: "get" | "set" | "del", durationMs: number): void {
    void this.metrics.publish(
      "cache_operation_duration_ms",
      durationMs,
      { Service: "users", Operation: operation },
      "Milliseconds",
    );
  }

  private reportUnavailable(
    err: unknown,
    keyPrefix: string,
    operation: "get" | "set" | "del",
    durationMs: number,
  ): void {
    // WARN, not ERROR: nothing is broken for the user — the read fell through
    // to Postgres and answered correctly. `reason` is machine-readable so an
    // operator can separate a timeout from a connection failure without
    // parsing the message ([[logging-context]]).
    appLogger.warn(
      {
        err,
        app_event: "cache_unavailable",
        reason:
          err instanceof Error && err.message.includes("exceeded") ? "timeout" : "redis_error",
        cache_operation: operation,
        // The PREFIX, for the same reason it is the only thing on the span.
        cache_key_prefix: keyPrefix,
      },
      "Cache unavailable; falling through to the database",
    );
    this.report("bypass", keyPrefix, operation, durationMs, undefined);
  }

  // A child span per operation, per the design's Observability item 2. Public
  // so the HTTP hooks can wrap the get/set inside the request's own span —
  // see cache-hooks.ts, where WHICH span is active is load-bearing.
  static async withCacheSpan<T>(
    name: "cache.get" | "cache.set",
    fn: () => Promise<T>,
  ): Promise<T> {
    return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL }, async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } finally {
        // In a `finally`, like withWorkflowSpan: a span left open on the
        // exception path never reaches OpenObserve and does not surface as an
        // error anywhere — it simply vanishes.
        span.end();
      }
    });
  }
}
