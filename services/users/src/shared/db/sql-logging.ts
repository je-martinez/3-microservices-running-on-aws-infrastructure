import type { Logger } from "pino";
import { appLogger } from "../logging/app-logger.ts";
import { env } from "../config/env.ts";

/**
 * The shape of Prisma's `query` event (`Prisma.QueryEvent`), restated locally so
 * this module can be unit-tested without constructing a connected client. Only
 * the fields we actually read are declared.
 */
export interface PrismaQueryEvent {
  /** The statement text, with `$1`-style placeholders — never the values. */
  query: string;
  /** Serialized parameter VALUES. Deliberately never read here — see below. */
  params?: string;
  /** Statement duration in milliseconds, as measured by Prisma. */
  duration?: number;
}

/** Minimal surface of the base client needed to subscribe to the query event. */
export interface QueryEventEmitter {
  $on(eventType: "query", callback: (event: PrismaQueryEvent) => void): unknown;
}

/**
 * Emit SQL only outside production, matching Tracking's `Settings.echo_sql`
 * (`environment != "production"`). Gated rather than hardcoded on: the
 * statements are genuinely useful locally but high-volume, and production has no
 * need for a line per query. Derived from the Zod-validated `NODE_ENV` (see
 * [[ADR-0014-env-validation-zod]]) rather than a new env var, so no env file,
 * compose service or deployment has to learn a key to get the same posture the
 * other two services already have.
 */
export const echoSql: boolean = env.NODE_ENV !== "production";

/**
 * Route Prisma's statements through the service's OWN Pino logger.
 *
 * ROUTING CONTRACT (observability/otel-collector-config.yaml → filter/only_sql):
 * the collector selects a record for the `sql` stream when `attributes["message"]`
 * matches `^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b`, or when
 * `attributes["commandText"]` is present. We take the FIRST branch: the bare
 * statement IS the log message, exactly like SQLAlchemy's echo in Tracking. So
 * nothing in the collector config needs to change for these lines to be routed.
 *
 * WHY THROUGH `appLogger` AND NOT `console.log` / Prisma's `emit: "stdout"`:
 * a line emitted by the library itself carries no `service_name`, no
 * `severity_text`/`severity_number`, and none of the AsyncLocalStorage request
 * context — so it cannot be filtered by service and cannot be tied back to the
 * request that issued it. Tracking paid for that lesson: `create_engine(echo=True)`
 * made SQLAlchemy install its own plain-text StreamHandler AFTER startup had
 * stripped library handlers, and every statement was emitted twice — once as
 * enriched JSON, once as raw text with multi-line statements arriving as several
 * unrelated records (see services/tracking/src/shared/db/engine.py). Prisma's
 * mechanism differs (`log: [{ emit: "event", level: "query" }]` + `$on`), but the
 * principle is identical: the library hands us the record, WE emit it.
 *
 * PARAMETER VALUES ARE DELIBERATELY OMITTED. `event.params` carries the bound
 * values — for this service that means emails, password-reset codes and tokens.
 * Per [[logging-context]] those must never reach a log line. The statement text
 * (placeholders intact) and the duration are the whole diagnostic value; the
 * values are a PII leak with no diagnostic payoff, so `params` is never read.
 *
 * `duration_ms` matches the shared context field Tracking and Orders already
 * carry for timing.
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
