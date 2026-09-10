import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// CLI-only configuration (migrate/generate); the app's own env validation lives in
// src/shared/config/env.ts. The writer URL is used because migrations run DDL.
//
// CONTRACT: Read process.env directly, NOT prisma/config's `env()` helper. `env()`
// throws PrismaConfigEnvError while this module is evaluated, before Prisma knows
// which command is running — which breaks `prisma generate` in any environment
// without a .env (the Docker build, CI), even though it never touches the database.
// See [[env-files]]
export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(import.meta.dirname, "prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_WRITER_URL ?? "",
  },
});
