import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCrossCuttingQueries,
  computeIsDeleted,
  MODEL_RELATIONS,
  RESULT_EXTENSIONS,
  type CrossCuttingBaseClient,
} from "#shared/db/prisma-extensions";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { runAsActor } from "#shared/audit/actor-context";
import { PrismaClient, Prisma } from "../../../src/generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";

// Unit-tests the `$allModels` query handlers built by `buildCrossCuttingQueries`
// directly — the same function `crossCuttingExtension` wires into a real
// PrismaClient (see `shared/db/prisma.ts`). Handlers are invoked with the same
// `{ model, operation, args, query }` shape Prisma passes at runtime, so this
// exercises the real cross-cutting logic without needing a connected DB.
function passthroughQuery() {
  return vi.fn(async (args: unknown) => ({ ...(args as Record<string, unknown>) }));
}

describe("cross-cutting Prisma extension", () => {
  describe("nano-id stamping on create", () => {
    it("stamps a usr_-prefixed id when args.data.id is not provided", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.create({ model: "User", operation: "create", args: { data: { email: "a@b.c" } }, query });

      const calledWith = query.mock.calls[0]![0] as { data: { id: string } };
      expect(calledWith.data.id).toMatch(/^usr_/);
    });

    it("does not override an explicitly provided id", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.create({ model: "User", operation: "create", args: { data: { id: "usr_explicit" } }, query });

      const calledWith = query.mock.calls[0]![0] as { data: { id: string } };
      expect(calledWith.data.id).toBe("usr_explicit");
    });

    it("stamps createdBy/updatedBy from the AsyncLocalStorage actor", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await runAsActor("usr_actor", () =>
        queries.create({ model: "User", operation: "create", args: { data: { email: "a@b.c" } }, query }),
      );

      const calledWith = query.mock.calls[0]![0] as { data: { createdBy: string; updatedBy: string } };
      expect(calledWith.data.createdBy).toBe("usr_actor");
      expect(calledWith.data.updatedBy).toBe("usr_actor");
    });
  });

  describe("soft delete", () => {
    it("redirects delete() to update() setting deletedAt/deletedBy", async () => {
      const update = vi.fn(async (args: unknown) => args);
      const client: CrossCuttingBaseClient = { user: { update } };
      const queries = buildCrossCuttingQueries(client);

      await runAsActor("usr_actor", () =>
        queries.delete({ model: "User", operation: "delete", args: { where: { id: "usr_1" } }, query: vi.fn() }),
      );

      expect(update).toHaveBeenCalledOnce();
      const calledWith = update.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        data: { deletedAt: Date; deletedBy: string };
      };
      // The rewrite goes to the BASE client's update, NOT the extension's
      // update handler, so the `deletedAt: null` guard added there is NOT
      // injected — the where is exactly what the caller passed. This lets the
      // rewrite (re-)touch an already soft-deleted row.
      expect(calledWith.where).toEqual({ id: "usr_1" });
      expect(calledWith.where.deletedAt).toBeUndefined();
      expect(calledWith.data.deletedAt).toBeInstanceOf(Date);
      expect(calledWith.data.deletedBy).toBe("usr_actor");
    });

    it("redirects deleteMany() to updateMany() setting deletedAt/deletedBy", async () => {
      const updateMany = vi.fn(async (_args: unknown) => ({ count: 3 }));
      const client: CrossCuttingBaseClient = { user: { updateMany } };
      const queries = buildCrossCuttingQueries(client);

      const result = await queries.deleteMany({
        model: "User",
        operation: "deleteMany",
        args: { where: { tags: { has: "E2E Source" } } },
        query: vi.fn(),
      });

      expect(updateMany).toHaveBeenCalledOnce();
      expect(result).toEqual({ count: 3 });
      const calledWith = updateMany.mock.calls[0]![0] as { where: Record<string, unknown>; data: { deletedAt: Date } };
      expect(calledWith.data.deletedAt).toBeInstanceOf(Date);
      // The rewrite goes to the BASE client's updateMany, NOT the extension's
      // updateMany handler, so the `deletedAt: null` guard added there is NOT
      // injected here — the where is exactly what the caller passed. This is
      // what keeps soft-deleting able to (re-)touch already-deleted rows.
      expect(calledWith.where).toEqual({ tags: { has: "E2E Source" } });
      expect(calledWith.where.deletedAt).toBeUndefined();
    });
  });

  // ADR-0004 hardening: a business `updateMany` now excludes soft-deleted rows
  // at the query layer (via the same `excludeSoftDeleted` helper the reads
  // use), turning the old call-site convention into an invariant. The
  // soft-delete rewrite (`deleteMany` -> BASE client's updateMany) bypasses
  // this handler, so it is unaffected (asserted in the "soft delete" block).
  describe("updateMany excludes soft-deleted rows", () => {
    it("injects deletedAt: null into where for a business updateMany", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.updateMany({
        model: "User",
        operation: "updateMany",
        args: { where: { tags: { has: "beta" } }, data: { role: "member" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
      expect(calledWith.where).toEqual({ tags: { has: "beta" }, deletedAt: null });
      // still stamps updatedBy on the update path
      expect(calledWith.data).toMatchObject({ role: "member" });
      expect("updatedBy" in calledWith.data).toBe(true);
    });

    it("injects deletedAt: null when where is absent", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.updateMany({
        model: "User",
        operation: "updateMany",
        args: { data: { role: "member" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: null });
    });

    it("does not override an explicit deletedAt filter (opt-out preserved)", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.updateMany({
        model: "User",
        operation: "updateMany",
        args: { where: { deletedAt: { not: null } }, data: { role: "member" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: { not: null } });
    });
  });

  // ADR-0004 hardening (delicate part): a business `update` on a unique row now
  // also requires that row to be non-deleted. Because `update` targets ONE
  // unique row, excluding a soft-deleted target makes Prisma raise P2025, which
  // the handler catches and translates into a typed RecordNotFoundError (mapped
  // to 404 by the HTTP error handler). The soft-delete rewrite (delete ->
  // update -> BASE client) bypasses this handler and is unaffected (asserted in
  // the "soft delete" block).
  describe("update excludes soft-deleted rows", () => {
    it("injects deletedAt: null into where for a business update", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.update({
        model: "User",
        operation: "update",
        args: { where: { id: "usr_1" }, data: { fullName: "Alice" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
      expect(calledWith.where).toEqual({ id: "usr_1", deletedAt: null });
      expect(calledWith.data).toMatchObject({ fullName: "Alice" });
      expect("updatedBy" in calledWith.data).toBe(true);
    });

    it("does not override an explicit deletedAt filter (opt-out preserved)", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.update({
        model: "User",
        operation: "update",
        args: { where: { id: "usr_1", deletedAt: { not: null } }, data: { fullName: "Alice" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ id: "usr_1", deletedAt: { not: null } });
    });

    it("translates a Prisma P2025 from the base query into a RecordNotFoundError", async () => {
      const queries = buildCrossCuttingQueries({});
      const p2025 = new Prisma.PrismaClientKnownRequestError("record not found", {
        code: "P2025",
        clientVersion: "test",
      });
      const query = vi.fn(async () => {
        throw p2025;
      });

      await expect(
        queries.update({
          model: "User",
          operation: "update",
          args: { where: { id: "usr_deleted" }, data: { fullName: "Alice" } },
          query,
        }),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it("re-throws non-P2025 errors unchanged", async () => {
      const queries = buildCrossCuttingQueries({});
      const other = new Prisma.PrismaClientKnownRequestError("unique constraint", {
        code: "P2002",
        clientVersion: "test",
      });
      const query = vi.fn(async () => {
        throw other;
      });

      await expect(
        queries.update({
          model: "User",
          operation: "update",
          args: { where: { id: "usr_1" }, data: { fullName: "Alice" } },
          query,
        }),
      ).rejects.toBe(other);
    });
  });

  describe("find* excludes soft-deleted rows", () => {
    it("injects deletedAt: null into where for findMany", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.findMany({ model: "User", operation: "findMany", args: { where: { email: "a@b.c" } }, query });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ email: "a@b.c", deletedAt: null });
    });

    it("injects deletedAt: null into where for findFirst when where is absent", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.findFirst({ model: "User", operation: "findFirst", args: {}, query });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: null });
    });

    it("does not override an explicit deletedAt filter", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.findMany({
        model: "User",
        operation: "findMany",
        args: { where: { deletedAt: { not: null } } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: { not: null } });
    });

    // JE-40 item 3: findUnique/findUniqueOrThrow used to be flagged as a
    // latent break because injecting `deletedAt: null` alongside a unique
    // field (e.g. `id`) was assumed to make Prisma reject the `where` shape
    // (true for the classic Prisma engine's UserWhereUniqueInput
    // validation). That assumption does not hold for this stack: Prisma 7's
    // `prisma-client` generator + driver-adapter engine accepts extra
    // non-unique `where` fields alongside a unique one, applying them as
    // additional AND filters (verified live against the compose Postgres —
    // a findUnique({ where: { id } }) call with `deletedAt: null` injected
    // returns the row when live and `null` when soft-deleted, matching
    // findFirst's behavior). These tests lock in the contract that makes
    // that safe: excludeSoftDeleted only ADDS deletedAt, it never removes or
    // replaces the caller's unique field.
    it("findUnique keeps the caller's unique field and only adds deletedAt: null", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.findUnique({ model: "User", operation: "findUnique", args: { where: { id: "usr_1" } }, query });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ id: "usr_1", deletedAt: null });
    });

    it("findUniqueOrThrow keeps the caller's unique field and only adds deletedAt: null", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.findUniqueOrThrow({
        model: "User",
        operation: "findUniqueOrThrow",
        args: { where: { email: "a@b.c" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ email: "a@b.c", deletedAt: null });
    });

    it("findUnique does not override an explicit deletedAt filter", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery();

      await queries.findUnique({
        model: "User",
        operation: "findUnique",
        args: { where: { id: "usr_1", deletedAt: { not: null } } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ id: "usr_1", deletedAt: { not: null } });
    });

    // ADR-0004 hardening: the three read ops that previously had NO handler
    // (so no `deletedAt: null` injection) now get the same shallow top-level
    // injection as the other reads, closing a latent leak if code ever calls
    // them.
    it("injects deletedAt: null into where for findFirstOrThrow", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.findFirstOrThrow({
        model: "User",
        operation: "findFirstOrThrow",
        args: { where: { email: "a@b.c" } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ email: "a@b.c", deletedAt: null });
    });

    it("injects deletedAt: null into where for aggregate", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.aggregate({
        model: "User",
        operation: "aggregate",
        args: { where: { tags: { has: "x" } }, _count: true } as never,
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ tags: { has: "x" }, deletedAt: null });
    });

    it("injects deletedAt: null into where for groupBy", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.groupBy({
        model: "User",
        operation: "groupBy",
        args: { by: ["email"] } as never,
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: null });
    });
  });

  describe("find* propagates deletedAt: null into nested relations", () => {
    it("injects a where on an include of a relation (value: true)", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.findMany({
        model: "User",
        operation: "findMany",
        args: { where: { email: "a@b.c" }, include: { cognitoData: true } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { include: Record<string, unknown> };
      expect(calledWith.include).toEqual({ cognitoData: { where: { deletedAt: null } } });
    });

    it("adds deletedAt: null to an include relation's existing where and recurses two levels", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.findFirst({
        model: "User",
        operation: "findFirst",
        args: {
          include: {
            cognitoData: {
              where: { clientId: "abc" },
              include: { events: true },
            },
          },
        },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { include: Record<string, unknown> };
      expect(calledWith.include).toEqual({
        cognitoData: {
          where: { clientId: "abc", deletedAt: null },
          include: { events: { where: { deletedAt: null } } },
        },
      });
    });

    it("does not override an explicit deletedAt on a nested relation where", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.findMany({
        model: "User",
        operation: "findMany",
        args: { include: { cognitoData: { where: { deletedAt: { not: null } } } } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { include: Record<string, unknown> };
      expect(calledWith.include).toEqual({ cognitoData: { where: { deletedAt: { not: null } } } });
    });

    it("injects into relation keys under select but leaves scalar selections untouched", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.findMany({
        model: "User",
        operation: "findMany",
        args: { select: { id: true, email: true, cognitoData: true } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { select: Record<string, unknown> };
      expect(calledWith.select).toEqual({
        id: true,
        email: true,
        cognitoData: { where: { deletedAt: null } },
      });
    });

    it("recurses through a nested select relation (UsersCognitoData -> events)", async () => {
      const queries = buildCrossCuttingQueries({});
      const query = passthroughQuery();

      await queries.findMany({
        model: "User",
        operation: "findMany",
        args: { select: { id: true, cognitoData: { select: { id: true, events: true } } } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { select: Record<string, unknown> };
      expect(calledWith.select).toEqual({
        id: true,
        cognitoData: {
          where: { deletedAt: null },
          select: { id: true, events: { where: { deletedAt: null } } },
        },
      });
    });
  });

  describe("MODEL_RELATIONS agrees with the schema", () => {
    // Guards the hand-maintained relation map (used to distinguish relations
    // from scalar selections under `select`): every `kind: "object"` relation
    // field in the schema must be registered, or nested-select filtering for
    // that relation would silently be skipped. Parses the schema's relation
    // fields (those with a `@relation` or a model-typed field) directly.
    it("registers every relation field declared in the schema", () => {
      const schema = readFileSync(
        new URL("../../../prisma/schema.prisma", import.meta.url),
        "utf8",
      );
      const modelNames = [...schema.matchAll(/model\s+(\w+)\s*\{/g)].map(([, name]) => name);
      const modelBlocks = [...schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)];

      for (const [, model, body] of modelBlocks) {
        // A relation field is a field whose type is another model name
        // (optionally with `?` or `[]`). Scalars (String, Json, DateTime, ...)
        // are excluded because their type is not a model name.
        const relationFields = [...body.matchAll(/^\s*(\w+)\s+(\w+)(\[\])?\??/gm)]
          .filter(([, , type]) => modelNames.includes(type))
          .map(([, field]) => field);

        for (const field of relationFields) {
          expect(
            MODEL_RELATIONS[model!]?.[field],
            `${model}.${field} is a schema relation but missing from MODEL_RELATIONS`,
          ).toBeDefined();
        }
      }
    });
  });

  describe("user.findByIdOrCognitoSub (model extension)", () => {
    // Unlike `buildCrossCuttingQueries` (a plain function unit-tested against
    // a mock client), the model method relies on `Prisma.getExtensionContext`,
    // which only resolves against a client produced by a real `$extends`
    // call. So this builds a minimal `$extends`-wrapped client (unconnected —
    // no query ever reaches the DB) and stubs the extended `findFirst`, the
    // same shape `crossCuttingExtension` produces in `shared/db/prisma-extensions.ts`.
    it("calls findFirst with an OR over id and cognitoSub and returns its result", async () => {
      const adapter = new PrismaPg({ connectionString: "postgresql://user:pass@localhost:5432/db" });
      const base = new PrismaClient({ adapter });

      const ext = base.$extends({
        name: "probe",
        model: {
          user: {
            async findByIdOrCognitoSub(idOrSub: string) {
              const ctx = Prisma.getExtensionContext(this);
              return (ctx as any).findFirst({
                where: { OR: [{ id: idOrSub }, { cognitoSub: idOrSub }] },
              });
            },
          },
        },
      });

      const findFirst = vi.fn(async () => ({ id: "usr_1" }));
      (ext.user as any).findFirst = findFirst;

      const result = await ext.user.findByIdOrCognitoSub("x");

      expect(findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "x" }, { cognitoSub: "x" }] } });
      expect(result).toEqual({ id: "usr_1" });
    });
  });

  describe("computeIsDeleted (result extension)", () => {
    it("returns false when deletedAt is null", () => {
      expect(computeIsDeleted({ deletedAt: null })).toBe(false);
    });

    it("returns true when deletedAt is set", () => {
      expect(computeIsDeleted({ deletedAt: new Date() })).toBe(true);
    });

    // Testing `computeIsDeleted` alone cannot catch a model that was never
    // REGISTERED for it — which is exactly how UsersCognitoData and
    // UsersCognitoEvent ended up with a `deletedAt` column but no computed
    // `isDeleted`. This asserts the registration itself: every soft-deletable
    // model in the schema must appear in the extension's `result` block.
    it("registers isDeleted for every model that has deletedAt", () => {
      const schema = readFileSync(
        new URL("../../../prisma/schema.prisma", import.meta.url),
        "utf8",
      );
      // Models declaring a deletedAt column are, by definition, soft-deletable.
      const softDeletable = [...schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)]
        .filter(([, , body]) => /\bdeletedAt\b/.test(body))
        .map(([, name]) => name.charAt(0).toLowerCase() + name.slice(1));

      expect(softDeletable.length).toBeGreaterThan(1);

      const registered = Object.keys(RESULT_EXTENSIONS);
      for (const model of softDeletable) {
        expect(registered, `${model} has deletedAt but no computed isDeleted`).toContain(model);
        expect(RESULT_EXTENSIONS[model as keyof typeof RESULT_EXTENSIONS].isDeleted.compute).toBe(
          computeIsDeleted,
        );
      }
    });
  });
});
