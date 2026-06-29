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
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

export const env = parseEnv();
