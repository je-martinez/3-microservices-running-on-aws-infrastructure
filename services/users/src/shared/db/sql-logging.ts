import type { Logger } from "pino";
import { appLogger } from "../logging/app-logger.ts";

/**
 * Restated locally so this module can be unit-tested without constructing a
 * connected client. Only the fields actually read are declared.
 */
export interface PrismaQueryEvent {
  /** Statement text with `$1` placeholders — never the values. */
  query: string;
  /** Parameter VALUES. Never read here — see the WARNING below. */
  params?: string;
  duration?: number;
}

export interface QueryEventEmitter {
  $on(eventType: "query", callback: (event: PrismaQueryEvent) => void): unknown;
}

/**
 * Emit SQL only outside production, matching Tracking's `echo_sql`. The statements are
 * useful locally but high-volume. Derived from `NODE_ENV` (schema default
 * "development") rather than a new env var, so nothing has to learn another key.
 */
export const echoSql: boolean = (process.env.NODE_ENV ?? "development") !== "production";

/**
 * Route Prisma's statements through the service's OWN Pino logger.
 *
 * CONTRACT: The bare statement IS the log message — the collector selects the `sql`
 * stream on `attributes["message"]` matching `^(SELECT|INSERT|...)`, so renaming or
 * prefixing it drops these lines out of that stream. Emit through `appLogger`, never
 * `console.log`: a line the library emits carries no service or request context.
 * See [[logging-context]]
 */

/**
 * WARNING: Never read `event.params`. The bound values are emails, password-reset
 * codes and tokens — a PII leak with no diagnostic payoff. The statement text with
 * placeholders intact, plus `duration_ms`, is the whole diagnostic value.
 * See [[logging-context]]
 */
export function attachSqlLogging(
  client: QueryEventEmitter,
  options: { enabled?: boolean; logger?: Logger } = {},
): void {
  const enabled = options.enabled ?? echoSql;
  if (!enabled) return;

  const logger = options.logger ?? appLogger;

  client.$on("query", (event) => {
    // `event.query` is the log MESSAGE, not a field: filter/only_sql matches on
    // `message` starting with the statement keyword.
    logger.info({ duration_ms: event.duration }, event.query);
  });
}
