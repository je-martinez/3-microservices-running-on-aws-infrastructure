import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmPasswordResetCommand } from "#features/users/commands/confirm-password-reset";
import { InvalidResetCodeError } from "#shared/auth/auth-errors";

const EMAIL = "jose@example.com";
const CODE = "123456";
const NEW_PASSWORD = "N3wP@ssw0rd!";

const USER = { id: "usr_1", email: EMAIL, fullName: "Jose" };

function build(
  overrides: {
    user?: unknown;
    accepted?: boolean;
    cognitoRejects?: boolean;
    mirrorRejects?: boolean;
  } = {},
) {
  const db = {
    user: {
      findFirst: vi.fn(async () => ("user" in overrides ? overrides.user : USER)),
      update: vi.fn(async () => USER),
    },
  };
  const auth = {
    setPassword: vi.fn(async () => {
      if (overrides.cognitoRejects) throw new Error("cognito down");
    }),
    setMustChangePassword: vi.fn(async () => {
      if (overrides.mirrorRejects) throw new Error("attribute write failed");
    }),
  };
  const resetCodeStore = {
    verifyAndConsume: vi.fn(async () => overrides.accepted ?? true),
  };

  const command = new ConfirmPasswordResetCommand({
    db: db as never,
    auth: auth as never,
    resetCodeStore: resetCodeStore as never,
  });

  return { command, db, auth, resetCodeStore };
}

const input = { email: EMAIL, code: CODE, newPassword: NEW_PASSWORD };

beforeEach(() => vi.clearAllMocks());

describe("ConfirmPasswordResetCommand", () => {
  it("verifies the code, sets the password and clears mustChangePassword", async () => {
    const { command, auth, db, resetCodeStore } = build();

    await command.execute(input);

    expect(resetCodeStore.verifyAndConsume).toHaveBeenCalledWith(EMAIL, CODE);
    expect(auth.setPassword).toHaveBeenCalledWith(EMAIL, NEW_PASSWORD);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "usr_1" },
      data: { mustChangePassword: false },
    });
  });

  it("writes ONLY mustChangePassword — never the password itself", async () => {
    const { command, db } = build();

    await command.execute(input);

    // The password lives in Cognito. A password column appearing in this write
    // would mean the service had started storing credentials.
    const [{ data }] = db.user.update.mock.calls[0]!;
    expect(Object.keys(data)).toEqual(["mustChangePassword"]);
  });

  // ==== NO USER ENUMERATION ====
  // A rejected code and an unknown email must be the SAME error to the caller,
  // or this endpoint becomes the oracle /password/forgot refuses to be.
  it("throws InvalidResetCodeError when the store rejects the code", async () => {
    const { command } = build({ accepted: false });
    await expect(command.execute(input)).rejects.toBeInstanceOf(InvalidResetCodeError);
  });

  it("throws the SAME InvalidResetCodeError for an unknown email", async () => {
    const { command } = build({ user: null });
    await expect(command.execute(input)).rejects.toBeInstanceOf(InvalidResetCodeError);
  });

  it("never verifies a code for an unknown email", async () => {
    const { command, resetCodeStore, auth } = build({ user: null });

    await expect(command.execute(input)).rejects.toThrow();
    expect(resetCodeStore.verifyAndConsume).not.toHaveBeenCalled();
    expect(auth.setPassword).not.toHaveBeenCalled();
  });

  it("does not set a password when the code is rejected", async () => {
    const { command, auth, db } = build({ accepted: false });

    await expect(command.execute(input)).rejects.toThrow();
    expect(auth.setPassword).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("does not clear the flag when Cognito rejects the new password", async () => {
    // Telling the frontend to stop asking for a change that never happened
    // would strand the user.
    const { command, db } = build({ cognitoRejects: true });

    await expect(command.execute(input)).rejects.toThrow("cognito down");
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("mirrors the cleared flag onto Cognito so the next token's claim is false", async () => {
    const { command, auth } = build();

    await command.execute(input);

    expect(auth.setMustChangePassword).toHaveBeenCalledWith(EMAIL, false);
  });

  it("still succeeds when the Cognito mirror fails — the password is already set", async () => {
    // The reset code has been consumed and the password applied by this point.
    // Throwing here would tell the user their reset failed and send them for a
    // new code, when in fact the new password works.
    const { command, db } = build({ mirrorRejects: true });

    await expect(command.execute(input)).resolves.toBeUndefined();
    expect(db.user.update).toHaveBeenCalled();
  });
});
