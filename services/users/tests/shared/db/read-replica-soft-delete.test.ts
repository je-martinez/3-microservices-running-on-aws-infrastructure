import { PrismaPg } from "@prisma/adapter-pg";
import { readReplicas } from "@prisma/extension-read-replicas";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client.ts";
import { composeDbClients } from "../../../src/shared/db/prisma.ts";
import { crossCuttingExtension } from "../../../src/shared/db/prisma-extensions.ts";

interface ReplicaCall {
  model: string;
  operation: string;
  args: Record<string, unknown>;
}

// `readReplicas` answers a read with `replica[model][operation](args)`, so a
// recording stand-in captures exactly what the replica would execute.
function recordingReplica(calls: ReplicaCall[]): PrismaClient {
  const empty: Record<string, unknown> = { findMany: [], count: 0, groupBy: [], aggregate: {} };
  const replica = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$connect" || model === "$disconnect") return async () => {};
        return new Proxy(
          {},
          {
            get: (_t, operation: string) => async (args: Record<string, unknown>) => {
              calls.push({ model, operation, args });
              return operation in empty ? empty[operation] : null;
            },
          },
        );
      },
    },
  );
  return replica as unknown as PrismaClient;
}

// Never connected: every read under test is routed to the replica, so a read
// that reaches this client fails loudly on the unreachable port.
function unreachableWriter(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: "postgres://u:p@127.0.0.1:1/none" }) });
}

describe("composeDbClients — soft-delete filter on replica reads", () => {
  let calls: ReplicaCall[];
  let db: ReturnType<typeof composeDbClients>;

  function build() {
    calls = [];
    db = composeDbClients(unreachableWriter(), recordingReplica(calls));
  }

  it.each([
    ["findUnique", () => db.user.findUnique({ where: { id: "usr_x" } })],
    ["findUniqueOrThrow", () => db.user.findUniqueOrThrow({ where: { id: "usr_x" } }).catch(() => undefined)],
    ["findFirst", () => db.user.findFirst({ where: { email: "a@b.c" } })],
    ["findFirstOrThrow", () => db.user.findFirstOrThrow({ where: { email: "a@b.c" } }).catch(() => undefined)],
    ["findMany", () => db.user.findMany({ where: { email: "a@b.c" } })],
    ["count", () => db.user.count({ where: { email: "a@b.c" } })],
    ["aggregate", () => db.user.aggregate({ where: { email: "a@b.c" }, _count: true })],
    ["groupBy", () => db.user.groupBy({ by: ["email"], where: { email: "a@b.c" } })],
  ])("%s reaches the replica with deletedAt: null", async (operation, run) => {
    build();
    await run();

    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe(operation);
    expect(calls[0].args.where).toMatchObject({ deletedAt: null });
  });

  it("findByIdOrCognitoSub reaches the replica with deletedAt: null", async () => {
    build();
    await db.user.findByIdOrCognitoSub("usr_x");

    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe("findFirst");
    expect(calls[0].args.where).toMatchObject({ deletedAt: null });
  });

  it("filters nested includes on the replica too", async () => {
    build();
    await db.user.findUnique({ where: { id: "usr_x" }, include: { cognitoData: true } });

    expect(calls[0].args.include).toEqual({ cognitoData: { where: { deletedAt: null } } });
  });

  it("an explicit deletedAt filter reaches the replica untouched", async () => {
    build();
    await db.user.findMany({ where: { deletedAt: { not: null } } });

    expect(calls[0].args.where).toEqual({ deletedAt: { not: null } });
  });

  // Negative control: proves this suite detects a wrong composition order
  // rather than passing whatever the order is.
  it("with readReplicas applied first, the replica read loses the filter", async () => {
    calls = [];
    const reversed = unreachableWriter()
      .$extends(readReplicas({ replicas: [recordingReplica(calls)] }))
      .$extends(crossCuttingExtension);

    await reversed.user.findUnique({ where: { id: "usr_x" } });

    expect(calls).toHaveLength(1);
    expect(calls[0].args.where).toEqual({ id: "usr_x" });
  });
});
