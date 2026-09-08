import { PrismaPg } from "@prisma/adapter-pg";
import { readReplicas } from "@prisma/extension-read-replicas";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { env } from "../config/env.ts";
import { crossCuttingExtension } from "./prisma-extensions.ts";
import { attachSqlLogging } from "./sql-logging.ts";

// CONTRACT: Apply `readReplicas` LAST, outermost. Extensions compose onion-style, and
// only as the outer layer can it route every call — including the ones our own query
// extensions make via `query(args)` — to the primary or a replica. Applied first, a
// rewritten call like soft-delete's `delete` -> `update` bypasses routing entirely.
// Reads go to the replica, writes to the primary; `$primary()` forces the primary for
// read-your-writes.
function buildPrismaClient() {
  const writerAdapter = new PrismaPg({ connectionString: env.DATABASE_WRITER_URL });
  const readerAdapter = new PrismaPg({ connectionString: env.DATABASE_READER_URL });

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

  return writerClient
    .$extends(crossCuttingExtension)
    .$extends(readReplicas({ replicas: [replicaClient] }));
}

export type Db = ReturnType<typeof buildPrismaClient>;

export const db: Db = buildPrismaClient();
