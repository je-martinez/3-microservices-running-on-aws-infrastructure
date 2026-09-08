import { z } from "zod";

// Per ADR-0014: env validation with Zod, parsed once at module load.
const EnvSchema = z.object({
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  DOCDB_HOST: z.string().min(1),
  DOCDB_PORT: z.coerce.number().default(27017),
  DOCDB_USERNAME: z.string().min(1),
  DOCDB_PASSWORD: z.string().min(1),
  DOCDB_DATABASE: z.string().default("events"),
  // WORKAROUND(local): Set DOCDB_AUTH_SOURCE=admin locally. Floci backs
  // DocumentDB with a stock mongo:7.0, which creates its MONGO_INITDB_ROOT_*
  // user in `admin`, so authenticating against `events` fails with
  // "Authentication failed". Real DocumentDB authenticates against the target
  // database and leaves this unset.
  // See [[floci-sqs-lambda-docdb-support]]
  DOCDB_AUTH_SOURCE: z.string().min(1).optional(),
  SES_FROM_ADDRESS: z.string().email(),
  // Public base URL of the assets bucket, WITHOUT a trailing slash — the email
  // templates append object keys to it.
  // CONTRACT: No default, and a trailing slash is REJECTED, not trimmed. Nothing
  // in the send path fetches these URLs, so a wrong value mails every recipient
  // broken images and fails nothing; a trailing slash yields a double slash that
  // S3 treats as a different key and answers 404. Both fail at boot instead.
  // See [[email-templates]]
  ASSETS_BASE_URL: z
    .string()
    .url()
    .refine((value) => !value.endsWith("/"), {
      message: "must not end with '/' — object keys are appended with a literal '/'",
    }),
  // CONTRACT: Feeds `deployment_environment` on every log line. Same name, shape
  // and default as Users' env schema — it is part of the shared log schema and
  // must not drift.
  // See [[logging-context]]
  DEPLOYMENT_ENVIRONMENT: z.string().default("local"),
  // Kill switch for CloudWatch metric publication (default true). The publisher
  // swallows failures already; this stops the CALLS.
  METRICS_ENABLED: z.coerce.boolean().default(true),
  // Echo of the DocumentDB commands this Lambda issues; unset, the default is
  // derived below from DEPLOYMENT_ENVIRONMENT.
  // CONTRACT: A "true"/"false" enum, never z.coerce.boolean() — coercion follows
  // JS truthiness, under which the STRING "false" is true, so
  // `DOCDB_ECHO_COMMANDS=false` would enable the thing it was meant to disable.
  DOCDB_ECHO_COMMANDS: z.enum(["true", "false"]).optional(),

  // CONTRACT: Gates the whole E2E email store — the write, the TTL index and
  // the query route. Default-off is a safety property: an environment that never
  // sets it stores no plaintext codes and fails closed. Enum, never
  // z.coerce.boolean(), or the STRING "false" ENABLES a route serving live OTPs.
  // See [[testing]]
  E2E_TESTING_ENABLED: z.enum(["true", "false"]).optional(),

  // e2e_emails document lifetime — short enough that a forgotten local stack is
  // not holding login codes overnight.
  E2E_EMAIL_TTL_SECONDS: z.coerce.number().positive().default(3600),

  // Shared secret for the query route. Optional here so a stack without E2E
  // starts normally, but the route REFUSES to serve when it is unset rather
  // than serving unauthenticated — see #e2e/http-query.
  E2E_QUERY_TOKEN: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.parse(process.env);

export const env: Env = parsed;

/**
 * Whether to emit a log line per DocumentDB command. Derived, not a schema
 * default, because it depends on DEPLOYMENT_ENVIRONMENT — which a Zod
 * `.default()` cannot see.
 */
export const docdbEchoCommands: boolean =
  parsed.DOCDB_ECHO_COMMANDS !== undefined
    ? parsed.DOCDB_ECHO_COMMANDS === "true"
    : parsed.DEPLOYMENT_ENVIRONMENT !== "production";

/**
 * Whether the E2E email store is active.
 *
 * CONTRACT: Compare here, once. This gates a collection of plaintext OTP codes
 * and a route that serves them, and `=== "true"` repeated per call site is one
 * chance per site to write a truthiness check on the string. Unset is OFF.
 * See [[testing]]
 */
export const e2eTestingEnabled: boolean = parsed.E2E_TESTING_ENABLED === "true";
