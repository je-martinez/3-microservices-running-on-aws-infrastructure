import { describe, it, expect, vi } from "vitest";
import { RefreshTokenCommand } from "#features/users/commands/refresh";

describe("RefreshTokenCommand", () => {
  it("delegates to auth.refresh with the token", async () => {
    const refresh = vi.fn(async () => ({ idToken: "id", accessToken: "acc" }));
    const cmd = new RefreshTokenCommand({ auth: { refresh } as any });
    const res = await cmd.execute({ refreshToken: "rt" });
    expect(refresh).toHaveBeenCalledWith("rt");
    expect(res).toEqual({ idToken: "id", accessToken: "acc" });
  });
});
