import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// CLI-only configuration (migrate/generate). Runtime env validation for the
// app itself stays in src/shared/config/env.ts (Zod) — unrelated to this file.
// The writer URL is used here because migrations run DDL, which only the
// writer connection is allowed to do.
//
// NOTE: we read process.env directly instead of prisma/config's `env()`
// helper. `env()` throws PrismaConfigEnvError synchronously if the variable
// is unset, and it does so while this config module is evaluated — before
// Prisma even knows which command is running. `prisma generate` never
// touches the database and doesn't need this URL at all, but it still loads
// this file, so an eager throw here breaks `generate` in environments
// without a .env (e.g. the Docker build, CI). `migrate`/`db` commands do
// need a real URL; if it's missing, the underlying Postgres driver will
// fail with a clear connection error when it actually tries to connect.
export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(import.meta.dirname, "prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_WRITER_URL ?? "",
  },
});
