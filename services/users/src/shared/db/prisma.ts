import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

export const writer = new PrismaClient({
  datasources: { db: { url: env.DATABASE_WRITER_URL } },
});

export const reader = new PrismaClient({
  datasources: { db: { url: env.DATABASE_READER_URL } },
});
