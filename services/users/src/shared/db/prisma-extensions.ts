import { Prisma } from "../../generated/prisma/client.ts";
import { MODEL_ID_PREFIXES, generateId } from "../id/nano-id.ts";
import { getActor } from "../audit/actor-context.ts";

// Minimal surface of the base client needed by the soft-delete rewrite
// (`delete`/`deleteMany` call back into `update`/`updateMany` on the same
// model). Kept narrow and exported so tests can pass a lightweight mock
// instead of a real, connected PrismaClient.
export interface CrossCuttingBaseClient {
  [modelKey: string]: {
    update?: (args: unknown) => Promise<unknown>;
    updateMany?: (args: unknown) => Promise<unknown>;
  };
}

// Builds the `$allModels` query handlers for the three cross-cutting rules
// (see [[nano-id]], [[audit-fields]], [[soft-delete]]). Extracted as a plain
// function (instead of being inlined in `crossCuttingExtension` below) so it
// can be unit-tested directly against a mock client — see
// `tests/shared/db/prisma-extensions.test.ts`.
export function buildCrossCuttingQueries(client: CrossCuttingBaseClient) {
  return {
    // --- nano-id (see [[nano-id]]) ---
    // Stamps `id = <prefix><nanoid()>` when the caller didn't supply one. The
    // prefix comes from `MODEL_ID_PREFIXES`; models not listed there are left
    // untouched, but every model in this schema is expected to have a prefix
    // registered (see the map for how to extend it).
    //
    // --- audit fields (see [[audit-fields]]) ---
    // Stamps `createdBy`/`updatedBy` with the actor read from the
    // AsyncLocalStorage populated per-request in `routes.ts`.
    async create({ model, args, query }: AllModelsCbArgs) {
      stampCreateData(model, args.data as Record<string, unknown>);
      return query(args);
    },
    async createMany({ model, args, query }: AllModelsCbArgs) {
      const dataList = Array.isArray(args.data) ? args.data : [args.data];
      for (const data of dataList) {
        stampCreateData(model, data as Record<string, unknown>);
      }
      return query(args);
    },

    // Stamps `updatedBy` on every update path.
    async update({ args, query }: AllModelsCbArgs) {
      stampUpdateData(args.data as Record<string, unknown>);
      return query(args);
    },
    async updateMany({ args, query }: AllModelsCbArgs) {
      stampUpdateData(args.data as Record<string, unknown>);
      return query(args);
    },
    async upsert({ model, args, query }: AllModelsCbArgs) {
      stampCreateData(model, args.create as Record<string, unknown>);
      stampUpdateData(args.update as Record<string, unknown>);
      return query(args);
    },

    // --- soft delete (see [[soft-delete]]) ---
    // `delete`/`deleteMany` never hit the DB's DELETE — they're redirected to
    // `update`/`updateMany`, stamping `deletedAt`/`deletedBy` instead of
    // removing the row. Follows the pattern from the official
    // `prisma-client-extensions` soft-delete example.
    async delete({ model, args }: AllModelsCbArgs) {
      const modelKey = uncapitalize(model);
      const modelClient = client[modelKey];
      if (!modelClient?.update) {
        throw new Error(`cross-cutting-rules: model "${model}" has no update() to redirect delete() to.`);
      }
      return modelClient.update({
        where: args.where,
        data: { deletedAt: new Date(), deletedBy: getActor() ?? null },
      });
    },
    async deleteMany({ model, args }: AllModelsCbArgs) {
      const modelKey = uncapitalize(model);
      const modelClient = client[modelKey];
      if (!modelClient?.updateMany) {
        throw new Error(`cross-cutting-rules: model "${model}" has no updateMany() to redirect deleteMany() to.`);
      }
      return modelClient.updateMany({
        where: args.where,
        data: { deletedAt: new Date(), deletedBy: getActor() ?? null },
      });
    },

    // --- find* (see [[soft-delete]]) ---
    // Excludes soft-deleted rows by default by injecting `deletedAt: null`
    // into `where`, unless the caller already filtered on `deletedAt`.
    async findMany({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
    async findFirst({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
    async findUnique({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
    async findUniqueOrThrow({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
    async count({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
  };
}

// `isDeleted` as a computed result field (see [[soft-delete]]) — replaces the
// old standalone `isDeleted()` helper (removed from `shared/audit/audit.ts`).
// Accessed as `row.isDeleted` directly on anything the extended client
// returns; domain mapping (see `features/users/domain/user.ts`) derives it
// the same way for rows that don't go through the client (e.g. hand-built
// rows in tests).
//
// Registered per-model (`result: { user: {...} }`) instead of `$allModels`:
// `$allModels`'s generic `needs` type can't resolve a concrete field shape
// (like `{ deletedAt: true }`) across every model at once and collapses to
// `never`, so this is added to each model as it's introduced — same
// extensibility trade-off as `MODEL_ID_PREFIXES` in `shared/id/nano-id.ts`.
export function computeIsDeleted(data: { deletedAt: Date | null }): boolean {
  return data.deletedAt !== null;
}

// Single Prisma Client extension that encapsulates the cross-cutting rules
// (see [[nano-id]], [[audit-fields]], [[soft-delete]]) as query extensions
// (nano-id + audit + soft-delete rewrite) plus a result extension (computed
// `isDeleted`), so every model gets them "for free" — no manual stamping in
// commands/queries. Composition with read replicas happens in
// `shared/db/prisma.ts`.
//
// Uses the callback form of `defineExtension` (`(client) => client.$extends(...)`)
// because the soft-delete rewrite of `delete`/`deleteMany` needs to call back
// into the client as `update`/`updateMany` on the same model.
export const crossCuttingExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "cross-cutting-rules",
    query: {
      $allModels: buildCrossCuttingQueries(client as unknown as CrossCuttingBaseClient),
    },
    result: {
      user: {
        isDeleted: {
          needs: { deletedAt: true },
          compute: computeIsDeleted,
        },
      },
    },
  }),
);

// Mirrors Prisma's `ModelQueryOptionsCbArgs` (see
// `@prisma/client/runtime/client`'s `$allModels` query extension callback
// shape) narrowed to what this module needs. `args`/`query` stay loosely
// typed on purpose: Prisma's real type is a large generic union across every
// model's operation input, and re-deriving it here would just recreate
// `JsArgs` — this local shape is intentionally structural so both the real
// extension (typed by Prisma's own `$extends`) and the unit tests (passing
// plain mock args) satisfy it.
interface AllModelsCbArgs {
  model: string;
  operation: string;
  args: { data?: unknown; where?: Record<string, unknown> | null; create?: unknown; update?: unknown };
  query: (args: AllModelsCbArgs["args"]) => Promise<unknown>;
}

function stampCreateData(model: string, data: Record<string, unknown> | undefined): void {
  if (!data) return;

  if (data.id === undefined && model) {
    const prefix = MODEL_ID_PREFIXES[model];
    if (prefix) {
      data.id = generateId(prefix);
    } else if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console -- dev-only guard, every model is expected to have a prefix
      console.warn(`[cross-cutting-rules] model "${model}" has no entry in MODEL_ID_PREFIXES; id was not stamped.`);
    }
  }

  const actor = getActor();
  data.createdBy = data.createdBy ?? actor ?? null;
  data.updatedBy = data.updatedBy ?? actor ?? null;
}

function stampUpdateData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  const actor = getActor();
  data.updatedBy = data.updatedBy ?? actor ?? null;
}

function excludeSoftDeleted(args: { where?: Record<string, unknown> | null }): void {
  const where = args.where ?? {};
  if (where.deletedAt === undefined) {
    args.where = { ...where, deletedAt: null };
  }
}

function uncapitalize<T extends string>(str: T): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
