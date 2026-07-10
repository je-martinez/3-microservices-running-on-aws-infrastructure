import { z } from "zod";

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
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

export const env = parseEnv();
