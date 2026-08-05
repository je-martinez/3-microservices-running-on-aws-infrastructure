import pino from "pino";
import { env } from "#shared/config/env";
import { buildLoggerOptions } from "#shared/logging/logger";

// The single process-wide logger for this Lambda. There is no per-request
// logger to mirror (no HTTP server here), so every module — the entrypoint, the
// state machine, the SES sender — logs through this one instance and gets the
// same enriched schema, because the per-record identity travels through the
// AsyncLocalStorage log context (#shared/logging/log-context) that
// `buildLoggerOptions`' formatter merges into every line. No logger is
// threaded through constructors or call sites.
//
// DESTINATION: pino's default synchronous stdout write, deliberately. No
// transport, no pino-pretty, no pino/file — transports spawn a worker thread
// that loads its target by module path, which does not survive esbuild's
// single-file bundle (scripts/build.mjs), and would fail at runtime inside the
// Lambda after building cleanly. Plain JSON on stdout is also exactly what
// CloudWatch (and the OTel collector tailing it) wants.
export const appLogger = pino(
  buildLoggerOptions({
    serviceName: "events-pipeline",
    environment: env.DEPLOYMENT_ENVIRONMENT,
  }),
);
