import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  buildCrossCuttingQueries,
  computeIsDeleted,
  crossCuttingExtension,
  MODEL_RELATIONS,
  RESULT_EXTENSIONS,
  type CrossCuttingBaseClient,
} from "#shared/db/prisma-extensions";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { runAsActor } from "#shared/audit/actor-context";
import { Prisma, PrismaClient } from "../../../src/generated/prisma/client.ts";

// The `$allModels` handlers are invoked with the `{ model, operation, args, query }`
// shape Prisma passes at runtime, so the real cross-cutting logic runs without a
// connected database. See [[soft-delete]], [[audit-fields]], [[nano-id]]
type Queries = ReturnType<typeof buildCrossCuttingQueries>;
type Args = Parameters<Queries["findMany"]>[0]["args"];

function passthroughQuery() {
  return vi.fn(async (args: unknown) => ({ ...(args as Record<string, unknown>) }));
}

async function run(
  op: keyof Queries,
  args: Args,
  { model = "User", client = {} as CrossCuttingBaseClient } = {},
) {
  const query = passthroughQuery();
  await buildCrossCuttingQueries(client)[op]({ model, operation: op, args, query });
  return query.mock.calls[0]![0] as Record<string, any>;
}

const SCHEMA = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");
const MODEL_BLOCKS = [...SCHEMA.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)];

describe("cross-cutting Prisma extension", () => {
  describe("nano-id + audit stamping on create", () => {
    it("stamps a usr_-prefixed id when args.data.id is not provided", async () => {
      const sent = await run("create", { data: { email: "a@b.c" } });
      expect(sent.data.id).toMatch(/^usr_/);
    });

    it("stamps the prefix of the model being created", async () => {
      const sent = await run("create", { data: {} }, { model: "StripePaymentMethod" });
      expect(sent.data.id).toMatch(/^spm_/);
    });

    it("does not override an explicitly provided id", async () => {
      const sent = await run("create", { data: { id: "usr_explicit" } });
      expect(sent.data.id).toBe("usr_explicit");
    });

    it("leaves the id unset for a model with no registered prefix", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sent = await run("create", { data: {} }, { model: "Unprefixed" });
      expect(sent.data.id).toBeUndefined();
      warn.mockRestore();
    });

    it("stamps createdBy/updatedBy from the AsyncLocalStorage actor", async () => {
      const sent = await runAsActor("usr_actor", () => run("create", { data: { email: "a@b.c" } }));
      expect(sent.data).toMatchObject({ createdBy: "usr_actor", updatedBy: "usr_actor" });
    });

    it("stamps null audit fields when no actor is active", async () => {
      const sent = await run("create", { data: { email: "a@b.c" } });
      expect(sent.data).toMatchObject({ createdBy: null, updatedBy: null });
    });

    it("keeps caller-supplied audit fields", async () => {
      const sent = await runAsActor("usr_actor", () =>
        run("create", { data: { createdBy: "system", updatedBy: "system" } }),
      );
      expect(sent.data).toMatchObject({ createdBy: "system", updatedBy: "system" });
    });

    it("stamps every row of a createMany", async () => {
      const sent = await runAsActor("usr_actor", () =>
        run("createMany", { data: [{ email: "a@b.c" }, { email: "d@e.f" }] }),
      );
      for (const row of sent.data) {
        expect(row.id).toMatch(/^usr_/);
        expect(row).toMatchObject({ createdBy: "usr_actor", updatedBy: "usr_actor" });
      }
      expect(sent.data[0].id).not.toBe(sent.data[1].id);
    });

    it("stamps create AND update branches of an upsert", async () => {
      const sent = await runAsActor("usr_actor", () =>
        run("upsert", { where: { id: "usr_1" }, create: { email: "a@b.c" }, update: { fullName: "A" } }),
      );
      expect(sent.create).toMatchObject({ createdBy: "usr_actor", updatedBy: "usr_actor" });
      expect(sent.create.id).toMatch(/^usr_/);
      expect(sent.update).toEqual({ fullName: "A", updatedBy: "usr_actor" });
    });
  });

  describe("soft delete", () => {
    it("redirects delete() to the BASE update() setting deletedAt/deletedBy", async () => {
      const update = vi.fn(async (args: unknown) => args);
      const query = vi.fn();
      const queries = buildCrossCuttingQueries({ user: { update } });

      await runAsActor("usr_actor", () =>
        queries.delete({ model: "User", operation: "delete", args: { where: { id: "usr_1" } }, query }),
      );

      expect(query).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledOnce();
      const sent = update.mock.calls[0]![0] as { where: object; data: Record<string, unknown> };
      // The base client skips the extension's `deletedAt: null` guard, so an
      // already soft-deleted row can still be (re-)touched.
      expect(sent.where).toEqual({ id: "usr_1" });
      expect(sent.data.deletedAt).toBeInstanceOf(Date);
      expect(sent.data.deletedBy).toBe("usr_actor");
    });

    it("stamps deletedBy null when no actor is active", async () => {
      const update = vi.fn(async (args: unknown) => args);
      const queries = buildCrossCuttingQueries({ user: { update } });

      await queries.delete({ model: "User", operation: "delete", args: { where: { id: "usr_1" } }, query: vi.fn() });

      expect((update.mock.calls[0]![0] as { data: { deletedBy: unknown } }).data.deletedBy).toBeNull();
    });

    it("redirects deleteMany() to the BASE updateMany() and returns its result", async () => {
      const updateMany = vi.fn(async (_args: unknown) => ({ count: 3 }));
      const query = vi.fn();
      const queries = buildCrossCuttingQueries({ user: { updateMany } });

      const result = await queries.deleteMany({
        model: "User",
        operation: "deleteMany",
        args: { where: { tags: { has: "E2E Source" } } },
        query,
      });

      expect(query).not.toHaveBeenCalled();
      expect(result).toEqual({ count: 3 });
      const sent = updateMany.mock.calls[0]![0] as { where: object; data: Record<string, unknown> };
      expect(sent.where).toEqual({ tags: { has: "E2E Source" } });
      expect(sent.data.deletedAt).toBeInstanceOf(Date);
    });

    it("targets the model client by its camelCase key", async () => {
      const update = vi.fn(async (args: unknown) => args);
      const queries = buildCrossCuttingQueries({ usersCognitoData: { update } });

      await queries.delete({
        model: "UsersCognitoData",
        operation: "delete",
        args: { where: { id: "ucd_1" } },
        query: vi.fn(),
      });

      expect(update).toHaveBeenCalledOnce();
    });

    it("throws rather than hard-deleting when the model has no update()", async () => {
      const query = vi.fn();
      const queries = buildCrossCuttingQueries({});

      await expect(
        queries.delete({ model: "User", operation: "delete", args: { where: { id: "usr_1" } }, query }),
      ).rejects.toThrow(/no update\(\)/);
      await expect(
        queries.deleteMany({ model: "User", operation: "deleteMany", args: {}, query }),
      ).rejects.toThrow(/no updateMany\(\)/);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("updateMany excludes soft-deleted rows", () => {
    it("injects deletedAt: null and stamps updatedBy", async () => {
      const sent = await runAsActor("usr_actor", () =>
        run("updateMany", { where: { tags: { has: "beta" } }, data: { role: "member" } }),
      );
      expect(sent.where).toEqual({ tags: { has: "beta" }, deletedAt: null });
      expect(sent.data).toEqual({ role: "member", updatedBy: "usr_actor" });
    });

    it("injects deletedAt: null when where is absent", async () => {
      const sent = await run("updateMany", { data: { role: "member" } });
      expect(sent.where).toEqual({ deletedAt: null });
    });

    it("does not override an explicit deletedAt filter (opt-out preserved)", async () => {
      const sent = await run("updateMany", { where: { deletedAt: { not: null } }, data: {} });
      expect(sent.where).toEqual({ deletedAt: { not: null } });
    });
  });

  describe("update excludes soft-deleted rows", () => {
    it("injects deletedAt: null and stamps updatedBy", async () => {
      const sent = await runAsActor("usr_actor", () =>
        run("update", { where: { id: "usr_1" }, data: { fullName: "Alice" } }),
      );
      expect(sent.where).toEqual({ id: "usr_1", deletedAt: null });
      expect(sent.data).toEqual({ fullName: "Alice", updatedBy: "usr_actor" });
    });

    it("does not override an explicit deletedAt filter (opt-out preserved)", async () => {
      const sent = await run("update", { where: { id: "usr_1", deletedAt: { not: null } }, data: {} });
      expect(sent.where).toEqual({ id: "usr_1", deletedAt: { not: null } });
    });

    it("translates a Prisma P2025 from the base query into a RecordNotFoundError", async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError("record not found", {
        code: "P2025",
        clientVersion: "test",
      });
      const query = vi.fn(async () => {
        throw p2025;
      });

      await expect(
        buildCrossCuttingQueries({}).update({
          model: "User",
          operation: "update",
          args: { where: { id: "usr_deleted" }, data: {} },
          query,
        }),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it("re-throws non-P2025 errors unchanged", async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError("unique constraint", {
        code: "P2002",
        clientVersion: "test",
      });
      const query = vi.fn(async () => {
        throw p2002;
      });

      await expect(
        buildCrossCuttingQueries({}).update({
          model: "User",
          operation: "update",
          args: { where: { id: "usr_1" }, data: {} },
          query,
        }),
      ).rejects.toBe(p2002);
    });
  });

  describe("reads exclude soft-deleted rows", () => {
    it.each(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow"] as const)(
      "%s keeps the caller's where and only adds deletedAt: null",
      async (op) => {
        const sent = await run(op, { where: { id: "usr_1" } });
        expect(sent.where).toEqual({ id: "usr_1", deletedAt: null });
      },
    );

    it.each(["count", "aggregate", "groupBy"] as const)("%s injects deletedAt: null", async (op) => {
      const sent = await run(op, { where: { tags: { has: "x" } } });
      expect(sent.where).toEqual({ tags: { has: "x" }, deletedAt: null });
    });

    it.each([
      "findMany",
      "findFirst",
      "findFirstOrThrow",
      "findUnique",
      "findUniqueOrThrow",
      "count",
      "aggregate",
      "groupBy",
    ] as const)("%s injects deletedAt: null when where is absent", async (op) => {
      const sent = await run(op, {});
      expect(sent.where).toEqual({ deletedAt: null });
    });

    it.each(["findMany", "findUnique", "count"] as const)(
      "%s does not override an explicit deletedAt filter",
      async (op) => {
        const sent = await run(op, { where: { id: "usr_1", deletedAt: { not: null } } });
        expect(sent.where).toEqual({ id: "usr_1", deletedAt: { not: null } });
      },
    );
  });

  describe("reads propagate deletedAt: null into nested relations", () => {
    it("rewrites an include of a relation given as true", async () => {
      const sent = await run("findMany", { where: { email: "a@b.c" }, include: { cognitoData: true } });
      expect(sent.include).toEqual({ cognitoData: { where: { deletedAt: null } } });
    });

    it("adds deletedAt: null to an include relation's where and recurses two levels", async () => {
      const sent = await run("findFirst", {
        include: { cognitoData: { where: { clientId: "abc" }, include: { events: true } } },
      });
      expect(sent.include).toEqual({
        cognitoData: {
          where: { clientId: "abc", deletedAt: null },
          include: { events: { where: { deletedAt: null } } },
        },
      });
    });

    it("filters the stripePaymentMethods relation of a user", async () => {
      const sent = await run("findUnique", { where: { id: "usr_1" }, include: { stripePaymentMethods: true } });
      expect(sent.include).toEqual({ stripePaymentMethods: { where: { deletedAt: null } } });
    });

    it("does not override an explicit deletedAt on a nested relation where", async () => {
      const sent = await run("findMany", { include: { cognitoData: { where: { deletedAt: { not: null } } } } });
      expect(sent.include).toEqual({ cognitoData: { where: { deletedAt: { not: null } } } });
    });

    it("injects into relation keys under select but leaves scalar selections untouched", async () => {
      const sent = await run("findMany", { select: { id: true, email: true, cognitoData: true } });
      expect(sent.select).toEqual({ id: true, email: true, cognitoData: { where: { deletedAt: null } } });
    });

    it("recurses through a nested select relation (UsersCognitoData -> events)", async () => {
      const sent = await run("findMany", {
        select: { id: true, cognitoData: { select: { id: true, events: true } } },
      });
      expect(sent.select).toEqual({
        id: true,
        cognitoData: {
          where: { deletedAt: null },
          select: { id: true, events: { where: { deletedAt: null } } },
        },
      });
    });
  });

  describe("MODEL_RELATIONS agrees with the schema", () => {
    // WHY: The map is hand-maintained; a schema relation missing from it
    // silently skips nested-select filtering for that relation.
    it("registers every relation field declared in the schema", () => {
      const modelNames = MODEL_BLOCKS.map(([, name]) => name);
      for (const [, model, body] of MODEL_BLOCKS) {
        const relationFields = [...body!.matchAll(/^\s*(\w+)\s+(\w+)(\[\])?\??/gm)]
          .filter(([, , type]) => modelNames.includes(type))
          .map(([, field, type]) => [field!, type!] as const);

        for (const [field, type] of relationFields) {
          expect(
            MODEL_RELATIONS[model!]?.[field],
            `${model}.${field} is a schema relation but missing from MODEL_RELATIONS`,
          ).toBe(type);
        }
      }
    });
  });

  describe("computeIsDeleted (result extension)", () => {
    it("returns false when deletedAt is null", () => {
      expect(computeIsDeleted({ deletedAt: null })).toBe(false);
    });

    it("returns true when deletedAt is set", () => {
      expect(computeIsDeleted({ deletedAt: new Date() })).toBe(true);
    });

    // WHY: Testing the function alone cannot catch a soft-deletable model that
    // was never REGISTERED for `isDeleted`; this asserts the registration.
    it("registers isDeleted for every model that has deletedAt", () => {
      const softDeletable = MODEL_BLOCKS.filter(([, , body]) => /\bdeletedAt\b/.test(body!)).map(
        ([, name]) => name!.charAt(0).toLowerCase() + name!.slice(1),
      );

      expect(softDeletable.length).toBeGreaterThan(1);
      for (const model of softDeletable) {
        const entry = RESULT_EXTENSIONS[model as keyof typeof RESULT_EXTENSIONS];
        expect(entry, `${model} has deletedAt but no computed isDeleted`).toBeDefined();
        expect(entry.isDeleted.compute).toBe(computeIsDeleted);
        expect(entry.isDeleted.needs).toEqual({ deletedAt: true });
      }
    });
  });

  describe("user.findByIdOrCognitoSub (model extension)", () => {
    // `Prisma.getExtensionContext` only resolves against a real `$extends`
    // result, so the production extension is applied to an unconnected client
    // and its `findFirst` is stubbed — no query reaches a database.
    it("calls findFirst with an OR over id and cognitoSub and returns its result", async () => {
      const adapter = new PrismaPg({ connectionString: "postgresql://user:pass@localhost:1/db" });
      const db = new PrismaClient({ adapter }).$extends(crossCuttingExtension);
      const findFirst = vi.fn(async () => ({ id: "usr_1" }));
      (db.user as unknown as { findFirst: typeof findFirst }).findFirst = findFirst;

      const result = await db.user.findByIdOrCognitoSub("x");

      expect(findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "x" }, { cognitoSub: "x" }] } });
      expect(result).toEqual({ id: "usr_1" });
    });
  });
});
