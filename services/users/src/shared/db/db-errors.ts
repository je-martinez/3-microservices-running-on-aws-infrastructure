// Persistence-layer domain error. Thrown by the cross-cutting `update` handler
// (see `prisma-extensions.ts`) when the soft-delete guard turns a target row
// into "not found": Prisma's `update` on a unique `where` raises P2025 when the
// row does not exist OR is now excluded by the injected `deletedAt: null`
// filter (i.e. it was soft-deleted). The HTTP layer's `setErrorHandler` (see
// `features/users/http/routes.ts`) maps this to the same 404 `{ error:
// "not_found" }` contract the /users/me routes already return, so a
// read-then-deleted race on a profile update yields a coherent 404 instead of
// an unhandled P2025 → 500.
export class RecordNotFoundError extends Error {
  readonly statusCode = 404 as const;
  readonly code = "not_found" as const;

  constructor(message = "record not found") {
    super(message);
    this.name = new.target.name;
  }
}
