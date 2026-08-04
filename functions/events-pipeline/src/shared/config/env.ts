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
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
