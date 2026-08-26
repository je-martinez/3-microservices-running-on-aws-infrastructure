import { z } from "zod/v4";

const schema = z.object({
  DATABASE_WRITER_URL: z.string().url(),
  DATABASE_READER_URL: z.string().url(),
  E2E_TESTING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  PORT: z.coerce.number().default(3000),
  COGNITO_USER_POOL_ID: z.string(),
  COGNITO_CLIENT_ID: z.string(),
  AWS_ENDPOINT_URL: z.string().url(),
  AWS_REGION: z.string(),
  // Gates the local identity capture in register() (spec D7). Defaults to
  // "development": if a prod deploy forgets to set it, register() also captures,
  // but the Lambda and register() derive the same message_id (D4), so the
  // duplicate is swallowed by ON CONFLICT DO NOTHING. Benign, not data loss.
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Guards POST /v1/webhooks/cognito (spec D1, D8). Required in EVERY
  // environment so the endpoint can never be deployed unprotected by omission.
  // Prod sources it from Secrets Manager (ADR-0007); compose supplies a
  // development value.
  WEBHOOK_SECRET: z.string().min(1),
  // gRPC server (spec: Users GetUserById surface). Port defaults to 50051;
  // GRPC_API_KEY is the shared symmetric key validated by the x-api-key
  // interceptor and is required in every environment so the surface can never
  // be deployed unguarded by omission.
  GRPC_PORT: z.coerce.number().int().positive().default(50051),
  GRPC_API_KEY: z.string().min(1),
  // Shared events queue consumed by the events-pipeline Lambda. Required in
  // every environment and never hardcoded: `make env-file` writes it into
  // .env.local.users from the Terraform output, because Floci remints the queue
  // URL on every apply (see [[env-files]]).
  EVENTS_QUEUE_URL: z.string().url(),
  // ElastiCache Redis, the store for password-reset codes. Both are REQUIRED
  // (no default host): a missing value must fail at boot with a named Zod error
  // rather than silently defaulting to "localhost" and producing ECONNREFUSED
  // on the first password-reset request — see [[ADR-0014-env-validation-zod]].
  //
  // ==== REDIS_HOST IS THE BACKING CONTAINER NAME, NEVER "localhost" ====
  // Locally, Floci backs the replication group with a real `valkey/valkey:8`
  // container on the compose network, and the endpoint the ElastiCache API
  // reports is literally "localhost" — which, resolved from inside the `users`
  // container, is the `users` container itself (measured: ECONNREFUSED). So the
  // value written into .env.local.users is the `floci-valkey-<id>` hostname,
  // derived by `make env-file` from a Terraform output. Do not "fix" this to
  // localhost. Same shape as the DOCDB_HOST quirk in the events-pipeline.
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  // Kill switch for the response cache. Defaults to true so a service that never
  // sets it still caches; the load-test A/B flips it to false. Same string->bool
  // shape as E2E_TESTING_ENABLED above: env values are always strings, and
  // z.coerce.boolean() would read "false" as true (a non-empty string).
  CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Feeds the schema logger's `deployment_environment` base field (see
  // shared/logging/logger.ts). Defaults to "local" for dev/test; prod deploys
  // set it explicitly.
  DEPLOYMENT_ENVIRONMENT: z.string().default("local"),
  // How often BusinessMetricsPoller publishes its gauges: 15s locally; real AWS
  // uses 60s. Defaulted so no existing env file, test, or deployment breaks by
  // omitting it.
  METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

export const env = parseEnv();
