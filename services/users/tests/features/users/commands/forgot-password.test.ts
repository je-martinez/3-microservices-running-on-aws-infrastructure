import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForgotPasswordCommand } from "#features/users/commands/forgot-password";
import { RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";

const EMAIL = "jose@example.com";

const USER = {
  id: "usr_1",
  email: EMAIL,
  fullName: "Jose",
  cognitoSub: "sub-1",
};

function build(overrides: { user?: unknown; publishRejects?: boolean } = {}) {
  const db = {
    user: { findFirst: vi.fn(async () => ("user" in overrides ? overrides.user : USER)) },
  };
  const events = {
    publishPasswordResetRequested: vi.fn(async () => {
      if (overrides.publishRejects) throw new Error("sqs down");
    }),
  };
  const resetCodeStore = { store: vi.fn(async () => undefined) };

  const command = new ForgotPasswordCommand({
    db: db as never,
    events: events as never,
    resetCodeStore: resetCodeStore as never,
  });

  return { command, db, events, resetCodeStore };
}

beforeEach(() => vi.clearAllMocks());

describe("ForgotPasswordCommand", () => {
  it("stores a 6-digit code in the reset-code store for a known email", async () => {
    const { command, resetCodeStore } = build();

    await command.execute({ email: EMAIL });

    expect(resetCodeStore.store).toHaveBeenCalledTimes(1);
    const [email, code] = resetCodeStore.store.mock.calls[0]!;
    expect(email).toBe(EMAIL);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("publishes PASSWORD_RESET_REQUESTED with the SAME code it stored", async () => {
    const { command, resetCodeStore, events } = build();

    await command.execute({ email: EMAIL });

    const [, storedCode] = resetCodeStore.store.mock.calls[0]!;
    // The code the user receives by email must be the one that will verify.
    // Two independently generated codes would pass a per-side test each and
    // still make every reset fail for real users.
    expect(events.publishPasswordResetRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        email: EMAIL,
        fullName: "Jose",
        code: storedCode,
        ttlSeconds: RESET_CODE_TTL_SECONDS,
      }),
    );
  });

  // ==== NO USER ENUMERATION ====
  // These two are the security property of the endpoint, not incidental cases:
  // an unknown email must be indistinguishable from a known one to the caller.
  it("resolves silently for an unknown email (no throw)", async () => {
    const { command } = build({ user: null });
    await expect(command.execute({ email: "nobody@example.com" })).resolves.toBeUndefined();
  });

  it("mints, stores and publishes NOTHING for an unknown email", async () => {
    const { command, resetCodeStore, events } = build({ user: null });

    await command.execute({ email: "nobody@example.com" });

    expect(resetCodeStore.store).not.toHaveBeenCalled();
    expect(events.publishPasswordResetRequested).not.toHaveBeenCalled();
  });

  it("swallows a publish failure (best-effort, never rethrown)", async () => {
    // A rethrow here would surface a 500 ONLY for emails that exist — which is
    // itself the enumeration oracle the flow avoids everywhere else.
    const { command, resetCodeStore } = build({ publishRejects: true });

    await expect(command.execute({ email: EMAIL })).resolves.toBeUndefined();
    expect(resetCodeStore.store).toHaveBeenCalledTimes(1);
  });
});
