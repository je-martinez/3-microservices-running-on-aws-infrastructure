import { describe, it, expect, vi } from "vitest";
import { StartOtpChallengeCommand } from "#features/users/commands/start-otp-challenge";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      startOtpChallenge: vi.fn(async () => ({ session: "sess_abc" })),
      ...overrides,
    },
  } as any;
}

describe("StartOtpChallengeCommand", () => {
  it("returns the session from the auth provider", async () => {
    const command = new StartOtpChallengeCommand(deps());
    const result = await command.execute({ email: "a@b.co" });
    expect(result).toEqual({ session: "sess_abc" });
  });

  it("passes the email through to the auth provider", async () => {
    const d = deps();
    const command = new StartOtpChallengeCommand(d);
    await command.execute({ email: "a@b.co" });
    expect(d.auth.startOtpChallenge).toHaveBeenCalledWith("a@b.co");
  });

  it("propagates the auth provider's error untouched", async () => {
    const command = new StartOtpChallengeCommand(
      deps({
        startOtpChallenge: vi.fn(async () => {
          throw new Error("cognito down");
        }),
      }),
    );
    await expect(command.execute({ email: "a@b.co" })).rejects.toThrow("cognito down");
  });

  // An unknown email surfaces as the generic invalid-credentials error, not a
  // distinct "no such user" — the HTTP contract must not confirm existence.
  it("rethrows InvalidCredentialsError untouched for an unknown user", async () => {
    const command = new StartOtpChallengeCommand(
      deps({
        startOtpChallenge: vi.fn(async () => {
          throw new InvalidCredentialsError();
        }),
      }),
    );
    await expect(command.execute({ email: "ghost@b.co" })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  // The session is what respondToOtpChallenge trades for real tokens, so it is
  // credential-adjacent and must never reach a log line.
  it("never logs the returned session", async () => {
    const { appLogger } = await import("#shared/logging/app-logger");
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const command = new StartOtpChallengeCommand(deps());
    await command.execute({ email: "a@b.co" });

    expect(JSON.stringify(calls)).not.toContain("sess_abc");

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
