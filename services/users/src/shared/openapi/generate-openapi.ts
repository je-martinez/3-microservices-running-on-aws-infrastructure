// Generates services/users/openapi.yaml from the live Nest routes.
// Run via `pnpm generate:openapi`. Do not invoke until AppModule and controllers
// exist — this script boots the real app and writes the committed artifact.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../../app.module.ts";
import { buildOpenApiDocument } from "./build-document.ts";

// Minimal YAML emitter for plain JSON-compatible OpenAPI objects. Avoids a
// standalone `yaml` dependency while the generate script stays dormant until
// AppModule lands.
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
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
