import { describe, it, expect, vi } from "vitest";
import {
  buildCrossCuttingQueries,
  computeIsDeleted,
  type CrossCuttingBaseClient,
} from "../../../src/shared/db/prisma-extensions.js";
import { runAsActor } from "../../../src/shared/audit/actor-context.js";

// Unit-tests the `$allModels` query handlers built by `buildCrossCuttingQueries`
// directly — the same function `crossCuttingExtension` wires into a real
// PrismaClient (see `shared/db/prisma.ts`). Handlers are invoked with the same
// `{ model, operation, args, query }` shape Prisma passes at runtime, so this
// exercises the real cross-cutting logic without needing a connected DB.
function passthroughQuery(input: unknown) {
  return vi.fn(async (args: unknown) => ({ ...(args as Record<string, unknown>) }));
}

describe("cross-cutting Prisma extension", () => {
  describe("nano-id stamping on create", () => {
    it("stamps a usr_-prefixed id when args.data.id is not provided", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery(undefined);

      await queries.create({ model: "User", operation: "create", args: { data: { email: "a@b.c" } }, query });

      const calledWith = query.mock.calls[0]![0] as { data: { id: string } };
      expect(calledWith.data.id).toMatch(/^usr_/);
    });

    it("does not override an explicitly provided id", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery(undefined);

      await queries.create({ model: "User", operation: "create", args: { data: { id: "usr_explicit" } }, query });

      const calledWith = query.mock.calls[0]![0] as { data: { id: string } };
      expect(calledWith.data.id).toBe("usr_explicit");
    });

    it("stamps createdBy/updatedBy from the AsyncLocalStorage actor", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery(undefined);

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
      const calledWith = update.mock.calls[0]![0] as { where: unknown; data: { deletedAt: Date; deletedBy: string } };
      expect(calledWith.where).toEqual({ id: "usr_1" });
      expect(calledWith.data.deletedAt).toBeInstanceOf(Date);
      expect(calledWith.data.deletedBy).toBe("usr_actor");
    });

    it("redirects deleteMany() to updateMany() setting deletedAt/deletedBy", async () => {
      const updateMany = vi.fn(async (args: unknown) => ({ count: 3 }));
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
      const calledWith = updateMany.mock.calls[0]![0] as { data: { deletedAt: Date } };
      expect(calledWith.data.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe("find* excludes soft-deleted rows", () => {
    it("injects deletedAt: null into where for findMany", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery(undefined);

      await queries.findMany({ model: "User", operation: "findMany", args: { where: { email: "a@b.c" } }, query });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ email: "a@b.c", deletedAt: null });
    });

    it("injects deletedAt: null into where for findFirst when where is absent", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery(undefined);

      await queries.findFirst({ model: "User", operation: "findFirst", args: {}, query });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: null });
    });

    it("does not override an explicit deletedAt filter", async () => {
      const client: CrossCuttingBaseClient = {};
      const queries = buildCrossCuttingQueries(client);
      const query = passthroughQuery(undefined);

      await queries.findMany({
        model: "User",
        operation: "findMany",
        args: { where: { deletedAt: { not: null } } },
        query,
      });

      const calledWith = query.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(calledWith.where).toEqual({ deletedAt: { not: null } });
    });
  });

  describe("computeIsDeleted (result extension)", () => {
    it("returns false when deletedAt is null", () => {
      expect(computeIsDeleted({ deletedAt: null })).toBe(false);
    });

    it("returns true when deletedAt is set", () => {
      expect(computeIsDeleted({ deletedAt: new Date() })).toBe(true);
    });
  });
});
