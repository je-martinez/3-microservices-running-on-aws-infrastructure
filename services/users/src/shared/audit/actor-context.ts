import { AsyncLocalStorage } from "node:async_hooks";

// The Prisma client is a process-wide singleton (see `shared/db/prisma.ts`), so
// it cannot read the acting user from a per-request Awilix scope directly. The
// audit query extension instead reads the actor from this AsyncLocalStorage,
// which `routes.ts` populates once per request (see the `onRequest` hook) so
// the whole async call chain of that request — including anything the
// extension does — can read it back via `getActor()`.
export interface ActorStore {
  actor: string | undefined;
}

export const actorContext = new AsyncLocalStorage<ActorStore>();

export function getActor(): string | undefined {
  return actorContext.getStore()?.actor;
}

// Runs `fn` with `actor` as the audit actor for its whole async call chain.
// Write paths pass a semantic `AuditActor` value (see `shared/audit/audit-actor.ts`)
// so the audit columns record WHAT produced the row (e.g. `users_api:register`)
// rather than a bare id — e.g. `register` wraps its `create` in
// `runAsActor(AuditActor.Register, ...)`, `updateProfile` its `update` in
// `runAsActor(AuditActor.UpdateProfile, ...)`. Nests correctly on top of the
// per-request store populated in `routes.ts` (AsyncLocalStorage.run creates a
// new, isolated store for its callback), so these local overrides take
// precedence over the request's `x-user-id` actor for the wrapped write.
export function runAsActor<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  return actorContext.run({ actor }, fn);
}
