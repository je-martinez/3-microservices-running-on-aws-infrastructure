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
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
