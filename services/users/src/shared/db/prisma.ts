import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";

// Two separate clients (writer/reader), each backed by its own driver adapter
// connection. Kept split for now — unifying them behind
// @prisma/extension-read-replicas is milestone 2 (block 2).
export const writer = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_WRITER_URL }),
});

export const reader = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_READER_URL }),
});
