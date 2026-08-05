import { describe, it, expect } from "vitest";
import {
  getLogContext,
  setLogContext,
  runWithLogContext,
} from "#shared/logging/log-context";

describe("runWithLogContext", () => {
  it("exposes the fields to a synchronous read inside the callback", async () => {
    await runWithLogContext({ event_id: "evt_1" }, async () => {
      expect(getLogContext().event_id).toBe("evt_1");
    });
  });

  it("returns an empty context outside any record", () => {
    expect(getLogContext()).toEqual({});
  });

  it("restores the outer absence of context after the callback resolves", async () => {
    await runWithLogContext({ event_id: "evt_1" }, async () => {});
    expect(getLogContext()).toEqual({});
  });

  it("propagates the callback's resolved value", async () => {
    const result = await runWithLogContext({ event_id: "evt_1" }, async () => "done");
    expect(result).toBe("done");
  });

  it("propagates a rejection instead of swallowing it", async () => {
    await expect(
      runWithLogContext({ event_id: "evt_1" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("keeps the context intact across an await inside the callback", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    setTimeout(() => release(), 10);

    const seen = await runWithLogContext({ event_id: "evt_await" }, async () => {
      await barrier;
      return getLogContext().event_id;
    });

    expect(seen).toBe("evt_await");
  });

  it("keeps the context intact across several awaits and nested async calls", async () => {
    async function deep(): Promise<string | undefined> {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getLogContext().type;
    }

    const seen = await runWithLogContext({ type: "ORDER_CREATED" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return deep();
    });

    expect(seen).toBe("ORDER_CREATED");
  });

  // THE test this file exists for — and the ONLY shape that actually
  // distinguishes the two implementations. Verified by mutation: replacing
  // log-context.ts's `logContext.run(fields, async () => await fn())` with the
  // naive `logContext.run(fields, fn)` leaves every OTHER test in this file
  // green, because Node propagates the store into an async function's
  // continuations through async_hooks whether or not `run`'s callback awaits.
  //
  // What breaks is a LAZY THENABLE: a callback that returns an object doing no
  // work until something calls `.then` on it. `run` exits the store the moment
  // that object is returned synchronously, and the work then starts at the AWAIT
  // SITE — outside the store entirely. That is precisely the shape of Prisma's
  // lazy promises in the Users lesson
  // (docs/lessons/2026-07-12-prisma-lazy-promise-als.md), and the reason the
  // `async () => await fn()` wrapper exists: awaiting INSIDE run() forces the
  // `.then` to be invoked while the store is still entered.
  it("keeps the context for a LAZY thenable whose work starts only when awaited", async () => {
    const lazy = () => ({
      then(resolve: (value: string | undefined) => void) {
        // Runs when something awaits this object. Under the naive
        // implementation, that happens after run() has already exited.
        setTimeout(() => resolve(getLogContext().event_id), 5);
      },
    });

    const seen = await runWithLogContext({ event_id: "evt_lazy" }, lazy as () => Promise<string | undefined>);

    expect(seen).toBe("evt_lazy");
  });

  it("keeps two concurrently-running records' contexts separate", async () => {
    // The batch is processed serially today, but nothing in the store enforces
    // that. If the loop were ever parallelized, an implementation sharing one
    // store would interleave the two records' identities.
    const [a, b] = await Promise.all([
      runWithLogContext({ event_id: "evt_a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getLogContext().event_id;
      }),
      runWithLogContext({ event_id: "evt_b" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getLogContext().event_id;
      }),
    ]);

    expect(a).toBe("evt_a");
    expect(b).toBe("evt_b");
  });
});

describe("setLogContext", () => {
  it("merges into the active store, keeping the fields already there", async () => {
    await runWithLogContext({ event_id: "evt_1" }, async () => {
      setLogContext({ order_id: "ord_1" });
      expect(getLogContext()).toEqual({ event_id: "evt_1", order_id: "ord_1" });
    });
  });

  it("is visible to a continuation that captured the store before the merge", async () => {
    // Mutating in place (rather than replacing the store) is what makes this
    // work: a continuation suspended before the merge still sees the update.
    const seen = await runWithLogContext({ event_id: "evt_1" }, async () => {
      const later = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getLogContext().order_id;
      })();
      setLogContext({ order_id: "ord_late" });
      return later;
    });

    expect(seen).toBe("ord_late");
  });

  it("is a no-op outside a record rather than throwing", () => {
    expect(() => setLogContext({ event_id: "evt_orphan" })).not.toThrow();
    expect(getLogContext()).toEqual({});
  });
});
