import { PrismaPg } from "@prisma/adapter-pg";
import { readReplicas } from "@prisma/extension-read-replicas";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { env } from "../config/env.ts";
import { crossCuttingExtension } from "./prisma-extensions.ts";

// Single Prisma Client, replacing the two split writer/reader clients from
// milestone 1. Composition order matters (extensions apply onion-style, each
// wrapping the previous):
//
//   base client (writer adapter)
//     .$extends(crossCuttingExtension)  -- nano-id + audit + soft-delete
//     .$extends(readReplicas(...))      -- read/write routing
//
// `readReplicas` must be applied LAST (outermost) per its own docs/caveats:
// when combined with other extensions, it needs to be the outermost layer so
// it can correctly decide, for every call (including those our own query
// extensions make via `query(args)`), whether to route to the primary or to a
// replica. Applying it first would let our extensions' rewritten calls (e.g.
// soft-delete's `delete` -> `update`) bypass the replica routing decision.
//
// Reads (`find*`, `count`, etc.) are routed to the read replica; writes
// (`create`, `update`, `delete`, ...) go to the primary. `$primary()` forces a
// call through the primary when needed (e.g. read-your-writes consistency).
function buildPrismaClient() {
  const writerAdapter = new PrismaPg({ connectionString: env.DATABASE_WRITER_URL });
  const readerAdapter = new PrismaPg({ connectionString: env.DATABASE_READER_URL });
  const replicaClient = new PrismaClient({ adapter: readerAdapter });

  return new PrismaClient({ adapter: writerAdapter })
    .$extends(crossCuttingExtension)
    .$extends(readReplicas({ replicas: [replicaClient] }));
}

export type Db = ReturnType<typeof buildPrismaClient>;

export const db: Db = buildPrismaClient();
