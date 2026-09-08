import { AsyncLocalStorage } from "node:async_hooks";

// The Prisma client is a process-wide singleton, so it cannot read the acting user
// from a per-request Awilix scope. The audit extension reads it from this
// AsyncLocalStorage, which `routes.ts` populates once per request.
// See [[audit-fields]]
export interface ActorStore {
  actor: string | undefined;
}

export const actorContext = new AsyncLocalStorage<ActorStore>();

export function getActor(): string | undefined {
  return actorContext.getStore()?.actor;
}

// Runs `fn` with `actor` as the audit actor for its whole async call chain. Write
// paths pass a semantic `AuditActor` value so the audit columns record WHAT produced
// the row (`users_api:register`) rather than a bare id. Nests on top of the
// per-request store, so a local override wins for the wrapped write.
// See [[audit-fields]]
export function runAsActor<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  // CONTRACT: Keep the `async () => await fn()` shape — do NOT pass `fn` directly to
  // `actorContext.run`. Prisma promises are LAZY, and AsyncLocalStorage exits its
  // store the moment the callback returns synchronously, so `fn` handed back
  // un-started runs later under the store active at the AWAIT site: the audit actor
  // is stamped null on /register, or worse, as the caller's sub on authenticated
  // writes. See [[2026-07-12-prisma-lazy-promise-als]]
  return actorContext.run({ actor }, async () => await fn());
}
