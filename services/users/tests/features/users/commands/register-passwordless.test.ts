import { describe, it, expect, vi } from "vitest";
import { RegisterPasswordlessCommand } from "#features/users/commands/register-passwordless";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { EmailAlreadyExistsError } from "#shared/auth/auth-errors";

// The row timestamp the fake `create` returns — the same value the publish
// payload must carry, since the welcome email's "Member Since" row is rendered
// from it.
const CREATED_AT = new Date("2026-01-01");

function deps(overrides: Record<string, unknown> = {}) {
  const created: any = {};
  return {
    // Capture the audit actor the extension would read (getActor) at the moment
    // of the create call, plus the full row shape the domain mapper needs.
    db: {
      user: {
        create: vi.fn(async ({ data }: any) => {
          Object.assign(created, data);
          created._actor = getActor();
          return {
            ...data,
            createdBy: AuditActor.RegisterPasswordless,
            createdAt: CREATED_AT,
            updatedBy: AuditActor.RegisterPasswordless,
            updatedAt: CREATED_AT,
            deletedBy: null,
            deletedAt: null,
          };
        }),
      },
    },
    auth: {
      signUp: vi.fn(async () => ({
        sub: "7904d681-f590-4b4d-bbce-15348a898873",
        email: "a@b.co",
        emailVerified: "true",
        userPoolId: "pool",
        clientId: "cli_1",
      })),
    },
    events: { publishUserCreated: vi.fn(async () => undefined) },
    metricsPublisher: { publish: vi.fn(async () => undefined) },
    env: { NODE_ENV: "development", AWS_REGION: "us-east-1" },
    captureCognitoIdentityCommand: { execute: vi.fn(async () => ({ status: "captured" as const })) },
    _created: created,
    ...overrides,
  } as any;
}

const input = { email: "a@b.co", fullName: "Ada", e2eSource: false };

describe("RegisterPasswordlessCommand", () => {
  it("creates a user with authType PASSWORDLESS", async () => {
    const d = deps();
    const user = await new RegisterPasswordlessCommand(d).execute(input);

    expect(user.authType).toBe("PASSWORDLESS");
    expect(d.db.user.create.mock.calls[0][0].data.authType).toBe("PASSWORDLESS");
  });

  // This path matters more than the password one for the name: a passwordless
  // user signs in ONLY through the OTP flow, so they are guaranteed to receive
  // the login-code email that greets them. Losing the name here means every
  // such user is greeted namelessly, forever, on every sign-in.
  it("forwards the full name to signUp, so Cognito can carry it to the OTP email", async () => {
    const d = deps();

    await new RegisterPasswordlessCommand(d).execute(input);

    const [, , , fullName] = d.auth.signUp.mock.calls[0];
    expect(fullName).toBe(input.fullName);
  });

  it("calls auth.signUp with a random password never exposed on the returned user", async () => {
    const d = deps();
    const user = await new RegisterPasswordlessCommand(d).execute(input);

    expect(d.auth.signUp).toHaveBeenCalledOnce();
    const [, password] = d.auth.signUp.mock.calls[0];
    expect(typeof password).toBe("string");
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(user)).not.toContain(password);
    // Nor is it persisted anywhere on the row.
    expect(JSON.stringify(d._created)).not.toContain(password);
  });

  it("generates a different random password on every call", async () => {
    const first = deps();
    const second = deps();
    await new RegisterPasswordlessCommand(first).execute(input);
    await new RegisterPasswordlessCommand(second).execute(input);

    expect(first.auth.signUp.mock.calls[0][1]).not.toBe(second.auth.signUp.mock.calls[0][1]);
  });

  it("tags the row 'E2E Source' only when e2eSource is true", async () => {
    const tagged = deps();
    await new RegisterPasswordlessCommand(tagged).execute({ ...input, e2eSource: true });
    expect(tagged.db.user.create.mock.calls[0][0].data.tags).toContain("E2E Source");

    const untagged = deps();
    await new RegisterPasswordlessCommand(untagged).execute(input);
    expect(untagged.db.user.create.mock.calls[0][0].data.tags).toEqual([]);
  });

  it("generates a usr_-prefixed id and passes it to signUp as the app user id", async () => {
    const d = deps();
    const user = await new RegisterPasswordlessCommand(d).execute(input);

    expect(user.id).toMatch(/^usr_/);
    expect(d._created.id).toBe(user.id);
    expect(d.auth.signUp.mock.calls[0][2]).toBe(user.id);
  });

  it("stamps the audit actor as AuditActor.RegisterPasswordless", async () => {
    const d = deps();
    await new RegisterPasswordlessCommand(d).execute(input);
    expect(d._created._actor).toBe(AuditActor.RegisterPasswordless);
  });

  it("publishes USER_CREATED the same way register() does", async () => {
    const d = deps();
    const user = await new RegisterPasswordlessCommand(d).execute(input);
    // Same payload shape as the password path, createdAt included: a
    // passwordless signup gets the same welcome email, so it cannot carry less
    // than what that email renders.
    expect(d.events.publishUserCreated).toHaveBeenCalledWith({
      id: user.id,
      email: "a@b.co",
      fullName: "Ada",
      createdAt: CREATED_AT,
      cognitoSub: "7904d681-f590-4b4d-bbce-15348a898873",
    });
  });

  it("takes createdAt off the created row rather than re-reading the user", async () => {
    const d = deps();
    await new RegisterPasswordlessCommand(d).execute(input);

    const published = d.events.publishUserCreated.mock.calls[0][0];
    expect(published.createdAt).toEqual(CREATED_AT);
    expect(d.db.user.create).toHaveBeenCalledOnce();
    expect(Object.keys(d.db.user)).toEqual(["create"]);
  });

  it("propagates EmailAlreadyExistsError from Cognito without writing a row", async () => {
    const d = deps({
      auth: {
        signUp: vi.fn(async () => {
          throw new EmailAlreadyExistsError();
        }),
      },
    });
    await expect(new RegisterPasswordlessCommand(d).execute(input)).rejects.toBeInstanceOf(
      EmailAlreadyExistsError,
    );
    expect(d.db.user.create).not.toHaveBeenCalled();
  });

  it("does NOT capture identity in production — the Lambda shim does", async () => {
    const d = deps({ env: { NODE_ENV: "production", AWS_REGION: "us-east-1" } });
    await new RegisterPasswordlessCommand(d).execute(input);
    expect(d.captureCognitoIdentityCommand.execute).not.toHaveBeenCalled();
  });

  it("still returns the user when identity capture fails (best-effort)", async () => {
    const d = deps({
      captureCognitoIdentityCommand: {
        execute: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    });
    const user = await new RegisterPasswordlessCommand(d).execute(input);
    expect(user.email).toBe("a@b.co");
  });

  it("publishes users_registered_total on success — the same series as the password path", async () => {
    const publish = vi.fn(async () => undefined);
    const d = deps({ metricsPublisher: { publish } });

    await new RegisterPasswordlessCommand(d).execute(input);

    // Same name AND same dimensions as register.ts: a passwordless signup is
    // still a registration. The split lives in users_total's HasPassword
    // dimension, not in a second counter.
    expect(publish).toHaveBeenCalledWith("users_registered_total", 1, { Service: "users" });
  });
});
