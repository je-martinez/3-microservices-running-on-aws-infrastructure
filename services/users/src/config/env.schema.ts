import { z } from "zod/v4";
import { parseAllowedSources } from "../shared/http/source-ip.ts";

// CONTRACT: The generated .env.local.users seeds STRIPE_* keys EMPTY into its CUSTOM
// box when the user hasn't opted in, and compose passes "" through as the literal
// empty string — never omits the var. Wrap those keys' schemas with this so "" and
// whitespace-only validate identically to the var being absent, instead of failing
// z.string().min(1)/z.enum() and blocking boot. See [[env-files]]
const emptyAsUnset = <T extends z.ZodType>(inner: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), inner);

// CONTRACT: This schema is the service contract for its environment, kept
// verbatim from the Fastify implementation. @nestjs/config validates against it
// at bootstrap (ConfigModule.forRoot({ validationSchema })), so a missing or
// malformed var fails the process at start rather than at first use.
// See [[env-files]]
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
  // INTERNAL_API_KEY is the shared symmetric key validated by the x-api-key
  // interceptor and is required in every environment so the surface can never
  // be deployed unguarded by omission.
  GRPC_PORT: z.coerce.number().int().positive().default(50051),
  INTERNAL_API_KEY: z.string().min(1),
  // CONTRACT: Required with no default — a missing value must fail at boot with a
  // named Zod error, or DELETE /v1/users/me reaches a half-configured cascade and
  // reports success for orders it never deleted. Named to match Orders'
  // TRACKING_BASE_URL; both routes are internal and absent from the API Gateway.
  // See [[ADR-0014-env-validation-zod]]
  ORDERS_BASE_URL: z.string().url(),
  TRACKING_BASE_URL: z.string().url(),
  // CONTRACT: Never default this — a placeholder ARN publishes into the void and
  // loses every event silently. Generated: Floci remints it. See [[env-files]]
  EVENTS_TOPIC_ARN: z.string().min(1),
  NOTIFICATIONS_QUEUE_URL: z.string().url(),
  // CONTRACT: The IN-NETWORK @connections endpoint (floci:4566) with Floci's
  // undocumented /execute-api/{apiId}/{stage} prefix — not a host URL, and not
  // validated as one (`$default` is a legal segment). A wrong shape answers HTTP
  // 400 with an S3 XML body. See [[floci-websocket-apigw-dynamodb-support]]
  WS_MANAGEMENT_ENDPOINT: z.string().min(1),
  WS_CONNECTIONS_TABLE: z.string().min(1),
  // CONTRACT: Keyed by `cognito_sub`, never `user_id` — querying it with an
  // internal usr_ id returns zero rows and no error, reading exactly like "the
  // user has nothing open". See [[user-id-vs-cognito-sub-ownership-key]]
  WS_CONNECTIONS_GSI: z.string().min(1).default("by-cognito-sub"),
  // CONTRACT: REDIS_HOST is the backing container name (`floci-valkey-<id>`), NEVER
  // "localhost". The ElastiCache API reports "localhost", which from inside the
  // `users` container resolves to that container itself — ECONNREFUSED on the first
  // password-reset. Both vars are required with no default, so a missing value fails
  // at boot with a named Zod error instead. See [[ADR-0014-env-validation-zod]]
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
  // How often BusinessMetricsPoller publishes its gauges. This 15s default is
  // the PRODUCTION-safe fallback; both real AWS and the local stack run at 60s,
  // set explicitly via METRICS_INTERVAL_MS in the generated .env.local.users.
  // Defaulted so no existing env file, test, or deployment breaks by omitting it.
  METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Kill switch for the whole Stripe integration (spec D13). Off by default so
  // every existing deploy and every test that doesn't opt in stays untouched.
  STRIPE_ENABLED: emptyAsUnset(
    z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  ),
  // A restricted key (rk_...), never a secret key. Optional: STRIPE_ENABLED=true
  // with this absent is a valid boot state (spec D13) — the Stripe routes then
  // answer 503 instead of taking the service down.
  STRIPE_SECRET_KEY: emptyAsUnset(z.string().min(1).optional()),
  STRIPE_WEBHOOK_SECRET: emptyAsUnset(z.string().min(1).optional()),
  // Webhook defense in depth. Unset with the flag on is a valid boot state: the
  // webhook answers 503, never allow-all. A malformed allowlist fails at boot.
  // See [[2026-09-19-stripe-payments-design]]
  STRIPE_WEBHOOK_URL_TOKEN: emptyAsUnset(z.string().min(1).optional()),
  STRIPE_WEBHOOK_ALLOWED_CIDRS: emptyAsUnset(
    z
      .string()
      .refine((raw) => {
        try {
          parseAllowedSources(raw);
          return true;
        } catch {
          return false;
        }
      }, "must be comma-separated IPv4/IPv6 addresses or CIDRs")
      .optional(),
  ),
  STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS: emptyAsUnset(z.coerce.number().int().min(0).default(0)),
});

export const envSchema = schema;
export type Env = z.infer<typeof schema>;
