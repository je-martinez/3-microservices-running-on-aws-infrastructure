// Generates services/users/openapi.yaml from the live Nest routes.
// Run via `pnpm generate:openapi`; it boots AppModule (no listen) and exits.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildOpenApiDocument } from "./build-document.ts";

// CONTRACT: Placeholders, never real secrets — the generator only needs the env
// contract to validate. They OVERRIDE the shell so the spec is deterministic: the
// e2e and Stripe routes mount only behind E2E_TESTING_ENABLED / STRIPE_ENABLED, and
// a shell with either off silently drops those paths from openapi.yaml.
// See [[openapi-specs]]
const PLACEHOLDER = "openapi-generator-placeholder";
const PLACEHOLDER_URL = "http://127.0.0.1:9";
const GENERATOR_ENV: Record<string, string> = {
  DATABASE_WRITER_URL: "postgresql://openapi:openapi@127.0.0.1:9/openapi",
  DATABASE_READER_URL: "postgresql://openapi:openapi@127.0.0.1:9/openapi",
  E2E_TESTING_ENABLED: "true",
  STRIPE_ENABLED: "true",
  COGNITO_USER_POOL_ID: PLACEHOLDER,
  COGNITO_CLIENT_ID: PLACEHOLDER,
  AWS_ENDPOINT_URL: PLACEHOLDER_URL,
  AWS_REGION: "us-east-1",
  WEBHOOK_SECRET: PLACEHOLDER,
  INTERNAL_API_KEY: PLACEHOLDER,
  ORDERS_BASE_URL: PLACEHOLDER_URL,
  TRACKING_BASE_URL: PLACEHOLDER_URL,
  EVENTS_TOPIC_ARN: PLACEHOLDER,
  NOTIFICATIONS_QUEUE_URL: PLACEHOLDER_URL,
  WS_MANAGEMENT_ENDPOINT: PLACEHOLDER_URL,
  WS_CONNECTIONS_TABLE: PLACEHOLDER,
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "9",
};

// Minimal YAML emitter for plain JSON-compatible OpenAPI objects. Avoids a
// standalone `yaml` dependency.
function dumpYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") {
    if (value === "") return '""';
    if (/^[\w./$@+-]+$/.test(value) && !/^(true|false|null|yes|no)$/i.test(value)) {
      return value;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const nested = dumpYaml(item, indent + 1);
          const [first, ...rest] = nested.split("\n");
          return [`${pad}- ${first.trimStart()}`, ...rest].join("\n");
        }
        return `${pad}- ${dumpYaml(item, 0)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, child]) => {
        const safeKey = /^[A-Za-z_][\w.-]*$/.test(key) ? key : JSON.stringify(key);
        if (child !== null && typeof child === "object") {
          const nested = dumpYaml(child, indent + 1);
          if (nested === "{}" || nested === "[]") return `${pad}${safeKey}: ${nested}`;
          return `${pad}${safeKey}:\n${nested}`;
        }
        return `${pad}${safeKey}: ${dumpYaml(child, 0)}`;
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  Object.assign(process.env, GENERATOR_ENV);
  // WHY: Dynamic import — AppModule validates the env and reads the route gates at
  // import time, so a static import would run before GENERATOR_ENV is applied.
  const { AppModule } = await import("../../app.module.ts");
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  const document = buildOpenApiDocument(app);
  await app.close();

  // src/shared/openapi/ → services/users/
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../../openapi.yaml");
  writeFileSync(out, `${dumpYaml(document)}\n`);
  console.log(`Wrote ${out}`);
}

// CONTRACT: Exit explicitly. AppModule opens handles app.close() does not release
// (the ioredis socket reconnects forever), so without process.exit the script
// writes openapi.yaml and then hangs.
main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
