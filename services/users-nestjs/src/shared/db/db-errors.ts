// Persistence-layer domain error, thrown by the cross-cutting `update` handler when
// the soft-delete guard turns the target into "not found" (Prisma raises P2025 for a
// row that is absent OR excluded by the injected `deletedAt: null`). The HTTP layer
// maps it to the same 404 the /users/me routes return, so a read-then-deleted race
// yields a coherent 404 instead of an unhandled 500. See [[soft-delete]]
export class RecordNotFoundError extends Error {
  readonly statusCode = 404 as const;
  readonly code = "not_found" as const;

  constructor(message = "record not found") {
    super(message);
    this.name = new.target.name;
  }
}
