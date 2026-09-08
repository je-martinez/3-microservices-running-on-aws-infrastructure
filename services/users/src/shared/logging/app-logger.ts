import pino from "pino";
import { env } from "#shared/config/env";
import { buildLoggerOptions } from "./logger.ts";

// A module-level logger for flow logs from commands and queries, which have no `req`
// in scope. Not injected: the per-request identity already travels through the
// AsyncLocalStorage log context, which the formatter merges into every line, so this
// emits the same enriched schema as `req.log` without threading a logger through
// every constructor. Same options as the Fastify logger, so the two are
// indistinguishable in shape downstream.
export const appLogger = pino(
  buildLoggerOptions({
    serviceName: "users",
    environment: env.DEPLOYMENT_ENVIRONMENT,
  }),
);
