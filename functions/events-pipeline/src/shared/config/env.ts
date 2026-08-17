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
  // Database the credentials are verified against. Amazon DocumentDB
  // authenticates the master user against the target database, so this stays
  // unset there. A stock mongo:7.0 (what Floci backs DocumentDB with) creates
  // its MONGO_INITDB_ROOT_* user in `admin` instead, and authenticating against
  // `events` fails with "Authentication failed" — set DOCDB_AUTH_SOURCE=admin
  // locally. Optional so the same code serves both substrates.
  DOCDB_AUTH_SOURCE: z.string().min(1).optional(),
  SES_FROM_ADDRESS: z.string().email(),
  // Public base URL of the assets bucket, WITHOUT a trailing slash. The email
  // templates append a known object key ("<base>/email/logo.png") to build the
  // remote <img> src of every icon — see emails/assets.ts.
  //
  // REQUIRED, with no default, on purpose. A default would let a
  // misconfigured deploy mail every recipient an email full of broken images
  // and never fail anything: nothing in the send path fetches these URLs, so
  // there is no other moment at which a wrong value can surface. Requiring it
  // moves the failure to boot, where it is one loud Zod error (ADR-0014).
  //
  // The trailing slash is REJECTED rather than trimmed. `emails/assets.ts`
  // joins with a literal "/", so a trailing slash yields "…/assets//email/x.png"
  // — a URL S3 treats as a DIFFERENT key ("/email/x.png") and answers with 404,
  // which again nothing here would notice. Failing on the shape is cheaper than
  // silently normalising a value the operator got wrong.
  ASSETS_BASE_URL: z
    .string()
    .url()
    .refine((value) => !value.endsWith("/"), {
      message: "must not end with '/' — object keys are appended with a literal '/'",
    }),
  // Feeds the schema logger's `deployment_environment` base field (see
  // #shared/logging/logger). Defaults to "local" for dev/test; prod deploys set
  // it explicitly. Same name, shape and default as Users' env schema — the
  // field is part of the shared log schema, so it must not drift.
  DEPLOYMENT_ENVIRONMENT: z.string().default("local"),
  // Kill switch for CloudWatch custom-metric publication. Defaulted to true so
  // no Terraform block, env file or test stub breaks by omitting it — the
  // publisher already swallows every failure, so the flag exists to stop the
  // calls entirely (e.g. a suite that must not reach the SDK), not to protect
  // the caller.
  METRICS_ENABLED: z.coerce.boolean().default(true),
  // Echo of the DocumentDB commands this Lambda issues (see
  // #shared/db/command-logger). The equivalent of Tracking's `Settings.echo_sql`
  // and, like it, ON OUTSIDE PRODUCTION BY DESIGN: locally these lines are the
  // only answer to "what did this query do?", while in production they are
  // per-operation volume nobody reads.
  //
  // Left UNSET, the default is derived below from DEPLOYMENT_ENVIRONMENT rather
  // than hardcoded to true, so a prod deploy that sets only the environment (as
  // every other switch here expects) gets the echo off without a second
  // variable to remember. Setting it explicitly always wins, in either
  // direction — including turning it on in production to debug something.
  //
  // Spelled as an explicit "true"/"false" enum rather than z.coerce.boolean():
  // coercion follows JS truthiness, under which the STRING "false" is true, so
  // `DOCDB_ECHO_COMMANDS=false` would silently enable the very thing it was
  // written to disable.
  DOCDB_ECHO_COMMANDS: z.enum(["true", "false"]).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.parse(process.env);

export const env: Env = parsed;

/**
 * Whether to emit a log line per DocumentDB command.
 *
 * A derived value rather than a schema field with a static default: the default
 * depends on ANOTHER field (DEPLOYMENT_ENVIRONMENT), which a Zod `.default()`
 * cannot see.
 */
export const docdbEchoCommands: boolean =
  parsed.DOCDB_ECHO_COMMANDS !== undefined
    ? parsed.DOCDB_ECHO_COMMANDS === "true"
    : parsed.DEPLOYMENT_ENVIRONMENT !== "production";
