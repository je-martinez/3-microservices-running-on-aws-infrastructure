import { describe, it, expect, vi } from "vitest";
import { CurrentUser } from "#shared/auth/current-user";
import { getLogContext, logContext } from "#shared/logging/log-context";

function currentUserWith(findByIdOrCognitoSub: ReturnType<typeof vi.fn>, identity = "sub-1") {
  return new CurrentUser({ db: { user: { findByIdOrCognitoSub } } as never, identity });
}

describe("CurrentUser", () => {
  it("exposes the raw identity without resolving", () => {
    const findByIdOrCognitoSub = vi.fn();
    const cu = currentUserWith(findByIdOrCognitoSub, "sub-2");

    expect(cu.identity).toBe("sub-2");
    expect(findByIdOrCognitoSub).not.toHaveBeenCalled();
  });

  it("looks the user up by the raw identity and caches the row", async () => {
    const row = { id: "usr_1", cognitoSub: "sub-1" };
    const findByIdOrCognitoSub = vi.fn().mockResolvedValue(row);
    const cu = currentUserWith(findByIdOrCognitoSub);

    expect(await cu.resolve()).toBe(row);
    expect(await cu.resolve()).toBe(row);
    expect(findByIdOrCognitoSub).toHaveBeenCalledTimes(1);
    expect(findByIdOrCognitoSub).toHaveBeenCalledWith("sub-1");
  });

  // CONTRACT: Cache the PROMISE, not the settled value — concurrent consumers in one
  // request issue a single lookup instead of racing two.
  it("shares one lookup between concurrent callers", async () => {
    const findByIdOrCognitoSub = vi.fn().mockResolvedValue({ id: "usr_1" });
    const cu = currentUserWith(findByIdOrCognitoSub);

    await Promise.all([cu.resolve(), cu.resolve(), cu.resolve()]);

    expect(findByIdOrCognitoSub).toHaveBeenCalledTimes(1);
  });

  // CONTRACT: This is where a request learns its `usr_` id; without the enrichment no
  // later log line of the request carries `user_id`. See [[logging-context]]
  it("adds the resolved user_id to the request's log context", async () => {
    const findByIdOrCognitoSub = vi.fn().mockResolvedValue({ id: "usr_1" });
    const cu = currentUserWith(findByIdOrCognitoSub);

    const after = await logContext.run({ cognito_sub: "sub-1" }, async () => {
      await cu.resolve();
      return getLogContext();
    });

    expect(after).toEqual({ cognito_sub: "sub-1", user_id: "usr_1" });
  });

  // CONTRACT: Unknown fields are omitted, never null — `user_id: null` reads as a
  // resolved value. See [[logging-context]]
  it("resolves to null and leaves user_id absent when the user does not exist", async () => {
    const findByIdOrCognitoSub = vi.fn().mockResolvedValue(null);
    const cu = currentUserWith(findByIdOrCognitoSub);

    const result = await logContext.run({ cognito_sub: "sub-1" }, async () => ({
      row: await cu.resolve(),
      ctx: getLogContext(),
    }));

    expect(result.row).toBeNull();
    expect(result.ctx).not.toHaveProperty("user_id");
  });
});
