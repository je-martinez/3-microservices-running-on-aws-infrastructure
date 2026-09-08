import { Prisma } from "../../generated/prisma/client.ts";
import { MODEL_ID_PREFIXES, generateId } from "../id/nano-id.ts";
import { getActor } from "../audit/actor-context.ts";
import { RecordNotFoundError } from "./db-errors.ts";

// Minimal surface of the base client the soft-delete rewrite needs
// (`delete`/`deleteMany` call back into `update`/`updateMany`). Exported narrow so
// tests can pass a lightweight mock instead of a connected PrismaClient.
export interface CrossCuttingBaseClient {
  [modelKey: string]: {
    update?: (args: unknown) => Promise<unknown>;
    updateMany?: (args: unknown) => Promise<unknown>;
  };
}

// Builds the `$allModels` query handlers for the three cross-cutting rules
// (see [[nano-id]], [[audit-fields]], [[soft-delete]]). A plain function so it can
// be unit-tested against a mock client.
export function buildCrossCuttingQueries(client: CrossCuttingBaseClient) {
  return {
    // --- nano-id (see [[nano-id]]) + audit fields (see [[audit-fields]]) ---
    // Stamps `id = <prefix><nanoid()>` from `MODEL_ID_PREFIXES` when the caller
    // supplied none (unlisted models are left untouched), and `createdBy`/`updatedBy`
    // from the per-request AsyncLocalStorage actor.
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

    // CONTRACT: Keep the P2025 translation. `update` targets one unique row, so the
    // injected `deletedAt: null` makes Prisma raise P2025 rather than affecting 0
    // rows; without the catch a deleted-target update surfaces as an unhandled 500
    // instead of the 404 `{ error: "not_found" }` contract. The soft-delete rewrite
    // bypasses this handler (it calls the BASE client), so it never sees either.
    // See [[soft-delete]]
    async update({ args, query }: AllModelsCbArgs) {
      stampUpdateData(args.data as Record<string, unknown>);
      excludeSoftDeleted(args);
      try {
        return await query(args);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          throw new RecordNotFoundError();
        }
        throw e;
      }
    },
    // Stamps `updatedBy` and injects `deletedAt: null`, so a bulk update skips
    // soft-deleted rows at the query layer; a caller opts out by filtering on
    // `deletedAt` themselves. The soft-delete rewrite bypasses this handler.
    async updateMany({ args, query }: AllModelsCbArgs) {
      stampUpdateData(args.data as Record<string, unknown>);
      excludeSoftDeleted(args);
      return query(args);
    },
    async upsert({ model, args, query }: AllModelsCbArgs) {
      stampCreateData(model, args.create as Record<string, unknown>);
      stampUpdateData(args.update as Record<string, unknown>);
      return query(args);
    },

    // CONTRACT: `delete`/`deleteMany` never issue a SQL DELETE — they redirect to
    // `update`/`updateMany` and stamp `deletedAt`/`deletedBy`. See [[soft-delete]]
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
    // CONTRACT: Reads inject `deletedAt: null` at the top-level `where` AND into
    // nested `include`/`select` relations (`excludeSoftDeletedDeep`) — shallow
    // injection alone leaks soft-deleted children through a relational read.
    // Safe on `findUnique`: the driver-adapter engine accepts extra non-unique
    // `where` fields beside a unique one, and the injection only ever ADDS.
    async findMany({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    async findFirst({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    // Same as findFirst, with a throw-on-empty semantic.
    async findFirstOrThrow({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    async findUnique({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    async findUniqueOrThrow({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    // count/aggregate/groupBy take a top-level `where` but no relations, so shallow
    // injection is sufficient.
    async count({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
    async aggregate({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
    async groupBy({ args, query }: AllModelsCbArgs) {
      excludeSoftDeleted(args);
      return query(args);
    },
  };
}

// CONTRACT: Register `isDeleted` per-model, NOT under `$allModels` — that generic
// `needs` type cannot resolve a concrete field shape across every model and
// collapses to `never`. Add each model as it gains `deletedAt`.
// See [[soft-delete]]
export function computeIsDeleted(data: { deletedAt: Date | null }): boolean {
  return data.deletedAt !== null;
}

// CONTRACT: One entry per model carrying `deletedAt`. Exported rather than inlined
// below so a test can assert the schema and this map agree — a model can otherwise
// gain a `deletedAt` column and no `isDeleted` with nothing detecting it.
// See [[soft-delete]]
const isDeletedField = {
  isDeleted: {
    needs: { deletedAt: true },
    compute: computeIsDeleted,
  },
} as const;

export const RESULT_EXTENSIONS = {
  user: isDeletedField,
  usersCognitoData: isDeletedField,
  usersCognitoEvent: isDeletedField,
} as const;

// CONTRACT: Keep the callback form of `defineExtension` — the soft-delete rewrite
// of `delete`/`deleteMany` must call back into the client as `update`/`updateMany`
// on the same model. One extension carries all three cross-cutting rules, so no
// command stamps anything by hand.
// See [[soft-delete]]
export const crossCuttingExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: "cross-cutting-rules",
    query: {
      $allModels: buildCrossCuttingQueries(client as unknown as CrossCuttingBaseClient),
    },
    result: RESULT_EXTENSIONS,
    model: {
      user: {
        // Resolve a user by their prefixed usr_ id OR their Cognito sub, as a raw
        // row. findFirst so the soft-delete/read-replica behaviour still applies.
        async findByIdOrCognitoSub(idOrSub: string) {
          const ctx = Prisma.getExtensionContext(this);
          return (ctx as any).findFirst({
            where: { OR: [{ id: idOrSub }, { cognitoSub: idOrSub }] },
          });
        },
      },
    },
  }),
);

// Mirrors Prisma's `$allModels` query-extension callback shape, narrowed to what
// this module needs. `args`/`query` stay loosely typed so both the real extension
// and the unit tests' plain mock args satisfy this structural shape.
interface AllModelsCbArgs {
  model: string;
  operation: string;
  // `include`/`select` stay `unknown` (like `data`/`create`/`update`): Prisma's
  // real per-op types make `select` a union (`true | AggregateInput` for
  // count/aggregate, a field map for find*), so this structural shape must not
  // narrow them or it stops satisfying Prisma's `$extends` callback types. The
  // deep soft-delete helpers below narrow to `Record<string, unknown>` at the
  // point of use.
  args: {
    data?: unknown;
    where?: Record<string, unknown> | null;
    create?: unknown;
    update?: unknown;
    include?: unknown;
    select?: unknown;
  };
  query: (args: AllModelsCbArgs["args"]) => Promise<unknown>;
}

function stampCreateData(model: string, data: Record<string, unknown> | undefined): void {
  if (!data) return;

  if (data.id === undefined && model) {
    const prefix = MODEL_ID_PREFIXES[model];
    if (prefix) {
      data.id = generateId(prefix);
    } else if (process.env.NODE_ENV !== "production") {
      // dev-only guard, every model is expected to have a prefix
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

// CONTRACT: Hand-maintained, and add an entry when a model gains a relation — this
// is the only source of truth telling `excludeSoftDeletedDeep` which `include`/
// `select` keys are relations. Do NOT derive it from the DMMF: Prisma v7's
// `prisma-client` generator exposes no public datamodel, only an inline JSON string
// inside generated internals that breaks across regenerations. A test asserts this
// map matches the schema, so an unlisted relation fails CI.
// See [[soft-delete]]
export const MODEL_RELATIONS: Record<string, Record<string, string>> = {
  User: { cognitoData: "UsersCognitoData" },
  UsersCognitoData: { user: "User", events: "UsersCognitoEvent" },
  UsersCognitoEvent: { data: "UsersCognitoData" },
};

// Injects `deletedAt: null` at the top-level `where`, then recurses into nested
// `include`/`select` relations to arbitrary depth. Every `include` key is a
// relation; under `select` only the keys in `MODEL_RELATIONS` are, so scalar
// selections are left untouched. A caller filtering on `deletedAt` opts out.
function excludeSoftDeletedDeep(model: string, args: AllModelsCbArgs["args"]): void {
  excludeSoftDeleted(args);
  applyNested(model, asRecord(args.include), "include");
  applyNested(model, asRecord(args.select), "select");
}

// Narrows a loosely-typed node to a plain record iff it's a non-null object
// (find* pass a field map here; count/aggregate never reach this path).
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

// Walks a single `include`/`select` object and injects `deletedAt: null` into
// each relation entry's own nested `where`, recursing into deeper
// include/select. `mode` decides how to treat entries: under `include` every
// key is a relation; under `select` only keys present in `MODEL_RELATIONS`
// (for the current model) are relations — scalar selections are skipped.
function applyNested(model: string, node: Record<string, unknown> | null | undefined, mode: "include" | "select"): void {
  if (!node) return;
  const relations = MODEL_RELATIONS[model];

  for (const [field, value] of Object.entries(node)) {
    const relatedModel = relations?.[field];
    // Under `select`, a field with no relation entry is a scalar selection —
    // leave it alone. Under `include`, all fields are relations, so we inject
    // even when the related model is unknown to the map (we still filter this
    // level; we just can't recurse deeper without knowing its relations).
    if (mode === "select" && !relatedModel) continue;

    injectRelationFilter(relatedModel, field, value, node);
  }
}

// Injects `deletedAt: null` for one relation entry and recurses into its nested
// include/select. `value` is the relation's argument node:
//   - `true`           -> replace with `{ where: { deletedAt: null } }`
//   - `{ ... }` object -> add `where: { deletedAt: null, ...existingWhere }`
//     (respecting an existing `deletedAt`, matching the top-level opt-out) and
//     recurse into its own `include`/`select`.
function injectRelationFilter(
  relatedModel: string | undefined,
  field: string,
  value: unknown,
  parent: Record<string, unknown>,
): void {
  if (value === true) {
    parent[field] = { where: { deletedAt: null } };
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const relationArgs = value as {
    where?: Record<string, unknown> | null;
    include?: Record<string, unknown> | null;
    select?: Record<string, unknown> | null;
  };
  excludeSoftDeleted(relationArgs);

  // Recurse only when we know the related model (so nested `select` scalar/
  // relation disambiguation stays correct). `include` at deeper levels still
  // needs the related model to look up ITS relations.
  if (relatedModel) {
    applyNested(relatedModel, relationArgs.include, "include");
    applyNested(relatedModel, relationArgs.select, "select");
  }
}

function uncapitalize<T extends string>(str: T): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
