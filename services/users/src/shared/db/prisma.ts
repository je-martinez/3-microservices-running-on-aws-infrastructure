import { PrismaPg } from "@prisma/adapter-pg";
import { readReplicas } from "@prisma/extension-read-replicas";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { envSchema, type Env } from "#config/env.schema";
import { crossCuttingExtension } from "./prisma-extensions.ts";
import { attachSqlLogging } from "./sql-logging.ts";

type PrismaConfig = Pick<Env, "DATABASE_WRITER_URL" | "DATABASE_READER_URL">;

// CONTRACT: Apply `readReplicas` LAST. Prisma runs query hooks in the order the
// extensions were applied, and `readReplicas` answers a read by calling the BARE
// replica client instead of `query(args)` — so any hook applied after it never runs
// for reads. Applied first, every replica read skips the `deletedAt: null` filter and
// returns soft-deleted rows. Reads go to the replica, writes to the primary;
// `$primary()` forces the primary for read-your-writes. See [[soft-delete]]
export function composeDbClients(writerClient: PrismaClient, replicaClient: PrismaClient) {
  return writerClient
    .$extends(crossCuttingExtension)
    .$extends(readReplicas({ replicas: [replicaClient] }));
}

export function createPrismaClient(config: PrismaConfig) {
  const writerAdapter = new PrismaPg({ connectionString: config.DATABASE_WRITER_URL });
  const readerAdapter = new PrismaPg({ connectionString: config.DATABASE_READER_URL });

  // `emit: "event"` is what makes `$on("query", …)` fire at all — the default,
  // `emit: "stdout"`, would have Prisma print the statement ITSELF, unstructured
  // and with no service_name, which is exactly the failure Tracking hit with
  // SQLAlchemy's echo=True (see shared/db/sql-logging.ts for the full story).
  // Declared even when echo is off: the listener is what decides, and a client
  // built without this option could never be instrumented later.
  const queryLog = [{ emit: "event" as const, level: "query" as const }];

  const replicaClient = new PrismaClient({ adapter: readerAdapter, log: queryLog });
  const writerClient = new PrismaClient({ adapter: writerAdapter, log: queryLog });

  // BOTH clients, not just the writer. Reads are routed to the replica by the
  // extension below, so instrumenting only the primary would log every write and
  // silently miss every SELECT — the majority of this service's traffic, and the
  // half most likely to be the one someone is trying to explain.
  attachSqlLogging(writerClient);
  attachSqlLogging(replicaClient);

  return composeDbClients(writerClient, replicaClient);
}

export type Db = ReturnType<typeof createPrismaClient>;

// CONTRACT: Build the client LAZILY, and import this bridge nowhere new.
// Parsing the environment at module-eval time kills the process on import,
// before Nest can report which variable is missing. PrismaModule provides the
// real client; this disappears once every consumer resolves DB from it.
let lazyDb: Db | undefined;

export function getDb(): Db {
  lazyDb ??= createPrismaClient(envSchema.parse(process.env));
  return lazyDb;
}
