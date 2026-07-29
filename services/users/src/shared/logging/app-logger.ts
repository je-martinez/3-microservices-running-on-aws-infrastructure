import pino from "pino";
import { env } from "#shared/config/env";
import { buildLoggerOptions } from "./logger.ts";

// A module-level logger for flow logs emitted from commands and queries, which
// have no `req` in scope.
//
// WHY NOT INJECT IT: the per-request identity already travels through the
// AsyncLocalStorage log context (shared/logging/log-context.ts), which
// `buildLoggerOptions`' formatter merges into every line. So this logger emits
// exactly the same enriched schema as `req.log` without threading a logger
// through every constructor and call site — the spec's "no function signature
// changes" constraint.
//
// Uses the SAME options as the Fastify logger, so a flow log and a request log
// are indistinguishable in shape downstream.
export const appLogger = pino(
  buildLoggerOptions({
    serviceName: "users",
    environment: env.DEPLOYMENT_ENVIRONMENT,
  }),
);
