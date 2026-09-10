import { describe, it, expect, vi } from "vitest";
import { SignOutCommand } from "#features/users/commands/sign-out";

describe("SignOutCommand", () => {
  it("delegates to auth.signOut with the access token", async () => {
    const signOut = vi.fn(async () => undefined);
    const cmd = new SignOutCommand({ auth: { signOut } as any });

    await expect(cmd.execute({ accessToken: "at" })).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledWith("at");
  });

  // The provider swallows an already-revoked token, so the command sees a plain
  // resolve. Asserted here too because the idempotency is a contract of the flow,
  // not an implementation detail of one layer.
  it("resolves when the session was already revoked", async () => {
    const signOut = vi.fn(async () => undefined);
    const cmd = new SignOutCommand({ auth: { signOut } as any });

    await cmd.execute({ accessToken: "already-dead" });
    await expect(cmd.execute({ accessToken: "already-dead" })).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it("rethrows an unexpected provider failure untouched", async () => {
    const boom = new Error("TooManyRequestsException");
    const cmd = new SignOutCommand({
      auth: { signOut: vi.fn(async () => { throw boom; }) } as any,
    });

    await expect(cmd.execute({ accessToken: "at" })).rejects.toBe(boom);
  });
});
