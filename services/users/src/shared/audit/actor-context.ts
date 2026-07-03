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
// Used by self-registration (see `commands/register.ts`): the new user row's
// `createdBy`/`updatedBy` must be its own freshly generated id, but that id
// isn't known until the nano-id extension stamps it — so `register` reserves
// the id up front, then runs the `create` call inside `runAsActor(id, ...)`.
// Nests correctly on top of the per-request store populated in `routes.ts`
// (AsyncLocalStorage.run creates a new, isolated store for its callback).
export function runAsActor<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  return actorContext.run({ actor }, fn);
}
