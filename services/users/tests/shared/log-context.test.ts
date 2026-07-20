import { describe, it, expect } from "vitest";
import {
  getLogContext,
  logContext,
  runWithLogContext,
  setLogContext,
} from "#shared/logging/log-context";

describe("log context store", () => {
  it("exposes the fields set for the wrapped call chain", async () => {
    await runWithLogContext({ cognito_sub: "sub-1", user_id: "usr_1" }, async () => {
      expect(getLogContext()).toEqual({ cognito_sub: "sub-1", user_id: "usr_1" });
    });
  });

  it("returns an empty object outside a request", () => {
    expect(getLogContext()).toEqual({});
  });

  it("survives awaits inside the callback", async () => {
    await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getLogContext().cognito_sub).toBe("sub-1");
    });
  });

  it("merges fields added mid-request via setLogContext", async () => {
    await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
      setLogContext({ user_id: "usr_late" });
      expect(getLogContext()).toEqual({ cognito_sub: "sub-1", user_id: "usr_late" });
    });
  });

  it("setLogContext is a no-op outside a request", () => {
    setLogContext({ user_id: "usr_orphan" });
    expect(getLogContext()).toEqual({});
  });

  it("isolates concurrent requests from each other", async () => {
    const observed: Array<string | undefined> = [];

    await Promise.all([
      runWithLogContext({ cognito_sub: "sub-a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.push(getLogContext().cognito_sub);
      }),
      runWithLogContext({ cognito_sub: "sub-b" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        observed.push(getLogContext().cognito_sub);
      }),
    ]);

    expect(observed.sort()).toEqual(["sub-a", "sub-b"]);
  });

  // Regression guard for the lazy-promise hazard documented in
  // shared/audit/actor-context.ts. A Prisma create/update returns a thenable
  // that starts no work until awaited; if runWithLogContext passed `fn`
  // straight to AsyncLocalStorage.run, the store would exit before the query
  // ran and the context would be whatever is active at the await site.
  it("keeps the store alive for a lazily-started thenable", async () => {
    // Stand-in for a PrismaPromise: nothing happens until .then is called.
    function lazyOperation(): PromiseLike<string | undefined> {
      return {
        then(onFulfilled) {
          const seen = getLogContext().cognito_sub;
          return Promise.resolve(onFulfilled ? onFulfilled(seen) : seen) as never;
        },
      };
    }

    const seenInside = await runWithLogContext(
      { cognito_sub: "sub-lazy" },
      () => lazyOperation() as Promise<string | undefined>,
    );

    expect(seenInside).toBe("sub-lazy");
  });

  it("nests, so an inner context overrides the outer one", async () => {
    await runWithLogContext({ cognito_sub: "outer" }, async () => {
      await runWithLogContext({ cognito_sub: "inner" }, async () => {
        expect(getLogContext().cognito_sub).toBe("inner");
      });
      expect(getLogContext().cognito_sub).toBe("outer");
    });
  });

  it("binds the store to the current async resource via enterWith", async () => {
    // The shape routes.ts uses: a Fastify onRequest hook returns via done()
    // rather than wrapping the handler, so there is no callback to run around.
    await new Promise<void>((resolve) => {
      logContext.run({}, () => {
        logContext.enterWith({ cognito_sub: "sub-entered" });
        setImmediate(() => {
          expect(getLogContext().cognito_sub).toBe("sub-entered");
          resolve();
        });
      });
    });
  });
});
