import { Redis } from "ioredis";
import { appLogger } from "#shared/logging/app-logger";

// CONTRACT: Register as a SINGLETON — ioredis holds a real TCP connection with its
// own reconnect state machine, so a per-request instance opens and leaks a socket per
// request. It exists for one thing: short-lived password-reset codes, which need
// Redis's native `EX` expiry rather than a Postgres table and a sweeper job.
// See [[dependency-injection]]
export type RedisClient = Redis;

// `lazyConnect: false` (the default) is what we want: the socket is opened as
// soon as the client is constructed, so a misconfigured host surfaces in the
// logs at boot instead of on the first user who forgets their password.
export function createRedisClient(options: { host: string; port: number }): RedisClient {
  const client = new Redis({
    host: options.host,
    port: options.port,

    // ==== DO NOT SET THIS TO `null`/Infinity ====
    // A command issued while the connection is down is retried this many times
    // and then FAILS, instead of queueing forever. That matters because the two
    // callers are on an HTTP request path: an unbounded retry would turn a Redis
    // outage into hung requests holding connections open, rather than a fast
    // error the command can log and answer for.
    maxRetriesPerRequest: 2,

    // Exponential-ish backoff with a ceiling, so a Redis restart does not become
    // a reconnect storm. Returning a number keeps ioredis retrying forever at
    // the CONNECTION level (unlike per-command retries above) — the process
    // should recover on its own once Redis is back, without a redeploy.
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });

  // CONTRACT: Keep this listener. ioredis emits `error` on every failed reconnect,
  // and an `error` event with no listener is an unhandled 'error' that crashes the
  // process — a transient Redis blip would take the whole service down. Logged, never
  // thrown: each caller decides what a Redis failure means for its flow.
  client.on("error", (err: Error) => {
    appLogger.error(
      { err, app_event: "redis_connection_failed", reason: "redis_error" },
      "Redis connection error",
    );
  });

  return client;
}
