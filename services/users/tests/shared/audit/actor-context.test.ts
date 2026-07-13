import { describe, it, expect } from "vitest";
import { actorContext, runAsActor, getActor } from "#shared/audit/actor-context";

// Prisma's `create`/`update`/`deleteMany` return a LAZY `PrismaPromise`: it runs
// no work at construction, only when awaited. A mock that returns an ordinary
// (eager) promise cannot reproduce that, and therefore cannot catch the bug this
// file guards against — so these tests model the laziness explicitly.
function lazyThenable<T>(work: () => T): PromiseLike<T> {
  return {
    then(resolve, reject) {
      // The work — and any getActor() inside it — runs HERE, at await time.
      return Promise.resolve()
        .then(() => work())
        .then(resolve, reject);
    },
  } as PromiseLike<T>;
}

describe("runAsActor", () => {
  it("keeps the actor visible to a lazy thenable that only runs when awaited", async () => {
    // The exact shape of the register bug: a NON-async arrow that returns an
    // un-started Prisma promise. If runAsActor passed `fn` straight to
    // AsyncLocalStorage.run, the store would be gone by the time the thenable
    // executed and this would read back undefined.
    const seen = await runAsActor("users_api:register", () =>
      lazyThenable(() => getActor()) as Promise<string | undefined>,
    );
    expect(seen).toBe("users_api:register");
  });

  it("wins over an enclosing request store (lazy thenable, non-async arrow)", async () => {
    // The onRequest hook wraps every request in a store. A self-service write
    // must stamp its semantic actor, never the request's x-user-id — and never
    // undefined on an unauthenticated route like /register.
    const seen = await actorContext.run({ actor: "cognito-sub-123" }, () =>
      runAsActor("users_api:update_profile", () =>
        lazyThenable(() => getActor()) as Promise<string | undefined>,
      ),
    );
    expect(seen).toBe("users_api:update_profile");
  });

  it("still works when the enclosing store has no actor (unauthenticated /register)", async () => {
    const seen = await actorContext.run({ actor: undefined }, () =>
      runAsActor("users_api:register", () =>
        lazyThenable(() => getActor()) as Promise<string | undefined>,
      ),
    );
    expect(seen).toBe("users_api:register");
  });
});
