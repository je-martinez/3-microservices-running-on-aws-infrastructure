import { Prisma } from "../../generated/prisma/client.ts";
import { MODEL_ID_PREFIXES, generateId } from "../id/nano-id.ts";
import { getActor } from "../audit/actor-context.ts";
import { RecordNotFoundError } from "./db-errors.ts";

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

    // Stamps `updatedBy` AND injects `deletedAt: null` into `where` (via the
    // same `excludeSoftDeleted` helper the reads use, respecting the caller's
    // opt-out), so an update on a unique row ALSO requires that row to be
    // non-deleted — the query-layer soft-delete guard (ADR-0004).
    //
    // The complication vs `updateMany`: `update` targets a single unique row,
    // so when the injected `deletedAt: null` excludes a soft-deleted (or
    // absent) target, Prisma raises `P2025` ("record not found") instead of
    // silently affecting 0 rows. We catch that P2025 and translate it into a
    // typed `RecordNotFoundError`, which the HTTP layer's `setErrorHandler`
    // maps to the same 404 `{ error: "not_found" }` contract the /users/me
    // routes already use — so a deleted-target update yields a coherent 404,
    // never an unhandled 500. In practice update-profile (the only business
    // `update` caller) pre-reads via `findByIdOrCognitoSub` and 404s a
    // soft-deleted user BEFORE reaching here, so this only fires in a rare
    // read-then-deleted race.
    //
    // The soft-delete rewrite's `update` path (delete -> update) is UNAFFECTED:
    // it calls the BASE client's `update` directly (see below), bypassing this
    // handler, so it never gets `deletedAt: null` injected and never surfaces
    // this translated error.
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
    // Stamps `updatedBy` AND injects `deletedAt: null` into `where` (via the
    // same `excludeSoftDeleted` helper the reads use), so a business bulk
    // update skips soft-deleted rows at the query layer (ADR-0004) — turning
    // the old call-site convention into an invariant. A caller can still opt
    // out by filtering on `deletedAt` themselves. The soft-delete rewrite
    // (`deleteMany`) is UNAFFECTED: it calls the BASE client's `updateMany`
    // directly (see below), bypassing this handler, so it still re-stamps
    // `deletedAt` even on already-deleted rows.
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
    //
    // `findUnique`/`findUniqueOrThrow` are safe here: `excludeSoftDeleted`
    // only ever ADDS `deletedAt` alongside whatever unique field the caller
    // supplied (`id`/`email`), it never removes/replaces it. Prisma's
    // `prisma-client` generator (v7, driver-adapter engine) accepts extra
    // non-unique `where` fields next to a unique one — it only rejects a
    // `where` with NO unique field at all (`PrismaClientValidationError`).
    // Verified against the live DB: a `findUnique({ where: { id } })` call
    // with `deletedAt: null` injected returns the row when not soft-deleted
    // and `null` when it is — see
    // `tests/shared/db/prisma-extensions.test.ts` ("findUnique / find
    // safety"). This was flagged as a latent break under an assumption from
    // the classic (non-driver-adapter) Prisma engine, which does not hold
    // for this stack's actual Prisma version — see JE-40.
    //
    // The find* handlers use `excludeSoftDeletedDeep`, which injects
    // `deletedAt: null` at the top-level `where` (as before) AND propagates it
    // into any nested `include`/`select` relations so a relational read can't
    // leak soft-deleted children (see [[soft-delete]], ADR-0004).
    async findMany({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    async findFirst({ model, args, query }: AllModelsCbArgs) {
      excludeSoftDeletedDeep(model, args);
      return query(args);
    },
    // `findFirstOrThrow` gets the same treatment as `findFirst` — it's just
    // findFirst with a throw-on-empty semantic, so the same top-level + nested
    // injection applies.
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
    // count/aggregate/groupBy accept a top-level `where` but no
    // `include`/`select` relations, so shallow injection is sufficient and
    // correct for them.
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

// One entry per soft-deletable model — i.e. every model carrying `deletedAt`
// (see [[soft-delete]]). Kept as a named export, not inlined into the
// `result:` block below, so a test can assert the schema and this map agree:
// `UsersCognitoData`/`UsersCognitoEvent` were added with a `deletedAt` column
// but no `isDeleted` for a while precisely because nothing checked that.
// Add a model here when it gains `deletedAt`.
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
    result: RESULT_EXTENSIONS,
    model: {
      user: {
        // Resolve a user by their prefixed usr_ id OR their Cognito sub. Returns
        // the raw row (or null); callers map via toDomain. findFirst so the
        // cross-cutting soft-delete/read-replica behavior still applies.
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

// Relation map: model name -> { relationField: relatedModelName } (see
// [[soft-delete]], ADR-0004). Single source of truth for which fields under a
// read's `include`/`select` are RELATIONS (as opposed to scalar selections),
// so `excludeSoftDeletedDeep` knows where to propagate `deletedAt: null`.
//
// Why a hand-maintained map instead of the Prisma DMMF: this stack's Prisma v7
// `prisma-client` generator does NOT expose a stable public DMMF/datamodel on
// the client (`Prisma.dmmf` doesn't exist; the runtime datamodel only lives as
// an inline JSON string inside the generated `internal/class.ts`, which is not
// a supported import surface). Reaching into generated internals would be
// fragile across regenerations, so we mirror the schema here explicitly — the
// same trade-off already made by `MODEL_ID_PREFIXES` (shared/id/nano-id.ts) and
// `RESULT_EXTENSIONS` above. A test asserts this map agrees with the schema's
// relation fields, so a new/changed relation that isn't added here fails CI.
//
// Add an entry when a model gains a relation.
export const MODEL_RELATIONS: Record<string, Record<string, string>> = {
  User: { cognitoData: "UsersCognitoData" },
  UsersCognitoData: { user: "User", events: "UsersCognitoEvent" },
  UsersCognitoEvent: { data: "UsersCognitoData" },
};

// Recursively excludes soft-deleted rows from a read: injects `deletedAt: null`
// at the top-level `where` (same opt-out behavior as `excludeSoftDeleted` — the
// caller can filter on `deletedAt` themselves to bypass), THEN walks any nested
// `include`/`select` relations and injects the same filter on each, recursing
// to arbitrary depth (UsersCognitoData -> events is two levels deep).
//
// Relation-vs-scalar distinction: every key under `include` IS a relation, so
// we recurse into all of them. Under `select`, keys can be scalar selections
// (`{ id: true }`) OR relations — we consult `MODEL_RELATIONS` and only inject
// a `where` on the relation keys, leaving scalar selections untouched.
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
