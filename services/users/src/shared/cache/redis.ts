import { Redis } from "ioredis";
import { appLogger } from "#shared/logging/app-logger";

// The Redis connection used by this service. It exists for ONE thing today:
// short-lived password-reset codes (see `reset-code-store.ts`). That is also why
// Redis is here at all rather than a Postgres table — a reset code is a
// ten-minute secret that must disappear on its own, and Redis's native `EX`
// expiry is exactly that, with no sweeper job to write, schedule, or forget.
//
// Registered as a SINGLETON in the Awilix container ([[dependency-injection]]):
// ioredis holds a real TCP connection with its own reconnect state machine, so a
// per-request instance would open a socket per request and leak them.
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

  // ioredis emits `error` on every failed reconnect attempt. An `error` event
  // with NO listener is an unhandled 'error' event, which crashes the process —
  // so this listener is not optional decoration, it is what keeps a transient
  // Redis blip from taking the whole service down.
  //
  // Logged, never thrown: the callers (password reset) each decide what a Redis
  // failure means for their own flow.
  client.on("error", (err: Error) => {
    appLogger.error(
      { err, app_event: "redis_connection_failed", reason: "redis_error" },
      "Redis connection error",
    );
  });

  return client;
}
