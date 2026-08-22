import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { ChangePasswordCommand } from "#features/users/commands/change-password";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { captureAppLogs, lineFor } from "../../../helpers/capture-app-logs.ts";

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

function build(
  overrides: { resolved?: unknown; cognitoRejects?: boolean; mirrorRejects?: boolean } = {},
) {
  const db = { user: { update: vi.fn(async () => ROW) } };
  const auth = {
    setPassword: vi.fn(async () => {
      if (overrides.cognitoRejects) throw new Error("cognito down");
    }),
    setMustChangePassword: vi.fn(async () => {
      if (overrides.mirrorRejects) throw new Error("attribute write failed");
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

  it("mirrors the cleared flag onto Cognito so the next token's claim is false", async () => {
    const { command, auth, currentUser } = build();

    await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });

    expect(auth.setMustChangePassword).toHaveBeenCalledWith("jose@example.com", false);
  });

  it("still succeeds when the Cognito mirror fails — the durable write already happened", async () => {
    // The mirror is a projection for the token claim, not the source of truth.
    // Failing the request here would report an error for a password change that
    // did happen, and GET /v1/users/me still answers correctly from Postgres.
    const { command, db, currentUser } = build({ mirrorRejects: true });

    const result = await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });

    expect(result).toMatchObject({ id: "usr_1", mustChangePassword: false });
    expect(db.user.update).toHaveBeenCalled();
  });

  it("does not mirror when the password set failed", async () => {
    const { command, auth, currentUser } = build({ cognitoRejects: true });

    await expect(
      command.execute(currentUser as never, { newPassword: NEW_PASSWORD }),
    ).rejects.toThrow("cognito down");
    expect(auth.setMustChangePassword).not.toHaveBeenCalled();
  });
});

describe("ChangePasswordCommand tracing", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits a 'change_password' span with app_event=change_password_succeeded on success", async () => {
    const { command, currentUser } = build();

    await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
    expect(span).toBeDefined();
    expect(span!.attributes.app_event).toBe("change_password_succeeded");
    expect(span!.attributes.user_id).toBe("usr_1");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits a 'change_password' span with ERROR status and reason=cognito_error when Cognito rejects", async () => {
    const { command, currentUser } = build({ cognitoRejects: true });

    await expect(
      command.execute(currentUser as never, { newPassword: NEW_PASSWORD }),
    ).rejects.toThrow("cognito down");

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
    expect(span!.ended).toBe(true);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes.app_event).toBe("change_password_failed");
    expect(span!.attributes.reason).toBe("cognito_error");
  });

  it("marks the unresolved-caller 404 on the span rather than leaving it untraced", async () => {
    // Returning null is a real outcome of this workflow, and the only one with
    // no flow log of its own — so it gets a reason instead of a blank span.
    const { command, currentUser } = build({ resolved: null });

    expect(await command.execute(currentUser as never, { newPassword: NEW_PASSWORD })).toBeNull();

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
    expect(span!.attributes.reason).toBe("unknown_user");
  });

  it("never puts the new password or the plaintext email on the span", async () => {
    const { command, currentUser } = build();

    await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain("jose@example.com");
    expect(span!.attributes.email_hash).toBeDefined();
  });
});

describe("ChangePasswordCommand logging", () => {
  beforeEach(() => testSpanExporter.reset());

  it("logs change_password_failed/unknown_user for the 404 branch, which used to return silently", async () => {
    // The only path of this flow with no log line at all: the `_started` line
    // needs the email this resolve failed to find, so a 404 here left nothing
    // but the generic `request completed` behind.
    const { command, currentUser } = build({ resolved: null });

    const lines = await captureAppLogs(async () => {
      await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });
    });

    const line = lineFor(lines, "change_password_failed");
    expect(line).toBeDefined();
    expect(line!.reason).toBe("unknown_user");
    expect(line!.severity_text).toBe("WARN");
  });

  it("emits that line INSIDE the change_password span", async () => {
    const { command, currentUser } = build({ resolved: null });

    const lines = await captureAppLogs(async () => {
      await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });
    });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
    expect(lineFor(lines, "change_password_failed")!.span_id).toBe(span!.spanContext().spanId);
  });

  it("carries the same app_event/reason pair on the span as on the line", async () => {
    const { command, currentUser } = build({ resolved: null });

    await captureAppLogs(async () => {
      await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });
    });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
    expect(span!.attributes.app_event).toBe("change_password_failed");
    expect(span!.attributes.reason).toBe("unknown_user");
  });

  it("never logs the new password on the unresolved-caller path", async () => {
    const { command, currentUser } = build({ resolved: null });

    const lines = await captureAppLogs(async () => {
      await command.execute(currentUser as never, { newPassword: NEW_PASSWORD });
    });

    expect(JSON.stringify(lines)).not.toContain(NEW_PASSWORD);
  });
});
