import { describe, it, expect, vi } from "vitest";
import { CurrentUser } from "#shared/auth/current-user";

describe("CurrentUser", () => {
  it("resolves the user once and caches it", async () => {
    const row = { id: "usr_1", cognitoSub: "sub-1" };
    const findByIdOrCognitoSub = vi.fn().mockResolvedValue(row);
    const db = { user: { findByIdOrCognitoSub } } as never;
    const cu = new CurrentUser({ db, identity: "sub-1" });
    const a = await cu.resolve();
    const b = await cu.resolve();
    expect(a).toBe(row);
    expect(b).toBe(row);
    expect(findByIdOrCognitoSub).toHaveBeenCalledTimes(1); // cached
  });

  it("exposes the raw identity without resolving", () => {
    const findByIdOrCognitoSub = vi.fn();
    const cu = new CurrentUser({ db: { user: { findByIdOrCognitoSub } } as never, identity: "sub-2" });
    expect(cu.identity).toBe("sub-2");
    expect(findByIdOrCognitoSub).not.toHaveBeenCalled(); // lazy
  });
});
