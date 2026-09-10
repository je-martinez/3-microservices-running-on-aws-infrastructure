import pino from "pino";
import { env } from "#shared/config/env";
import { buildLoggerOptions } from "#shared/logging/logger";

// The single process-wide logger. Every module logs through this instance; the
// per-record identity rides the AsyncLocalStorage context that
// `buildLoggerOptions`' formatter merges into each line, so no logger is
// threaded through call sites.
// CONTRACT: Do NOT add a pino transport (pino-pretty, pino/file). A transport
// spawns a worker thread that loads its target by module path, which esbuild's
// single-file bundle does not carry — it builds cleanly and dies at runtime.
// See [[logging-context]]
export const appLogger = pino(
  buildLoggerOptions({
    serviceName: "events-pipeline",
    environment: env.DEPLOYMENT_ENVIRONMENT,
  }),
);
