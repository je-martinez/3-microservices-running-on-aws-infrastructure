import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChangePasswordCommand } from "#features/users/commands/change-password";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");
const NEW_PASSWORD = "N3wP@ssw0rd!";

const ROW = {
  id: "usr_1",
  email: "jose@example.com",
  fullName: "Jose",
  address: null,
  phoneNumber: null,
  tags: [] as string[],
  authType: "PASSWORD" as const,
  mustChangePassword: false,
  createdBy: "usr_1",
  createdAt: FIXED_DATE,
  updatedBy: "usr_1",
  updatedAt: FIXED_DATE,
  deletedBy: null,
  deletedAt: null,
  isDeleted: false,
};

function build(overrides: { resolved?: unknown; cognitoRejects?: boolean } = {}) {
  const db = { user: { update: vi.fn(async () => ROW) } };
  const auth = {
    setPassword: vi.fn(async () => {
      if (overrides.cognitoRejects) throw new Error("cognito down");
    }),
  };
  const currentUser = {
    resolve: vi.fn(async () =>
      "resolved" in overrides ? overrides.resolved : { id: "usr_1", email: "jose@example.com" },
    ),
  };

  const command = new ChangePasswordCommand({ db: db as never, auth: auth as never });
  return { command, db, auth, currentUser };
}

beforeEach(() => vi.clearAllMocks());

describe("ChangePasswordCommand", () => {
  it("sets the password and clears mustChangePassword", async () => {
    const { command, auth, db, currentUser } = build();

    const result = await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });

    expect(auth.setPassword).toHaveBeenCalledWith("jose@example.com", NEW_PASSWORD);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "usr_1" },
      data: { mustChangePassword: false },
    });
    expect(result).toMatchObject({ id: "usr_1", mustChangePassword: false });
  });

  it("writes ONLY mustChangePassword — no other profile field", async () => {
    // The endpoint's whole reason to exist separately from PATCH /v1/users/me:
    // it must not be able to double as a profile update.
    const { command, db, currentUser } = build();

    await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });

    const [{ data }] = db.user.update.mock.calls[0]!;
    expect(Object.keys(data)).toEqual(["mustChangePassword"]);
  });

  it("returns null when the caller resolves to no user (route answers 404)", async () => {
    const { command, auth, db, currentUser } = build({ resolved: null });

    expect(await command.execute(currentUser as never, { newPassword: NEW_PASSWORD })).toBeNull();
    expect(auth.setPassword).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("does not clear the flag when Cognito rejects the password", async () => {
    const { command, db, currentUser } = build({ cognitoRejects: true });

    await expect(
      command.execute(currentUser as never, { newPassword: NEW_PASSWORD }),
    ).rejects.toThrow("cognito down");
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
