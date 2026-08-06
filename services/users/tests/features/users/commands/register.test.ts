import { describe, it, expect, vi } from "vitest";
import { RegisterUserCommand } from "#features/users/commands/register";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";

// The timestamp the fake `create` stamps on the returned row. A real Prisma row
// always carries `createdAt`, so the double has to as well — the publish payload
// reads it off the created row, and a mock that omitted it would let a broken
// "Member Since" field pass (see [[mocks-hide-schema-bugs]]).
const CREATED_AT = new Date("2026-01-15T10:30:00.000Z");

function deps(overrides: Record<string, unknown> = {}) {
  const created: any = {};
  return {
    // Capture the audit actor the extension would read (getActor) at the moment
    // of the create call — register wraps it in runAsActor(AuditActor.Register).
    db: { user: { create: vi.fn(async ({ data }: any) => { Object.assign(created, data); created._actor = getActor(); return { ...data, createdAt: CREATED_AT }; }) } },
    auth: {
      signUp: vi.fn(async () => ({
        sub: "7904d681-f590-4b4d-bbce-15348a898873",
        email: "a@b.c",
        emailVerified: "true",
        userPoolId: "pool",
        clientId: "cli_1",
      })),
      login: vi.fn(),
    },
    events: { publishUserCreated: vi.fn(async () => {}) },
    env: { NODE_ENV: "development", AWS_REGION: "us-east-1" },
    captureCognitoIdentityCommand: { execute: vi.fn(async () => ({ status: "captured" as const })) },
    _created: created,
    ...overrides,
  } as any;
}

describe("RegisterUserCommand", () => {
  it("adds 'E2E Source' to tags when e2eSource is true", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: true });
    expect(user.tags).toContain("E2E Source");
    expect(d.events.publishUserCreated).toHaveBeenCalledOnce();
  });

  it("publishes USER_CREATED with the id, email, fullName AND createdAt the welcome email renders", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "Ada L", e2eSource: false });
    // Asserted as the WHOLE object, not with objectContaining: an extra field
    // reaching the publisher is a wire-contract change and should fail here.
    expect(d.events.publishUserCreated).toHaveBeenCalledWith({
      id: user.id,
      email: "a@b.c",
      fullName: "Ada L",
      createdAt: CREATED_AT,
      cognitoSub: "7904d681-f590-4b4d-bbce-15348a898873",
    });
  });

  it("takes createdAt off the row the create returned, without a second database read", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    await command.execute({ email: "a@b.c", password: "P!1", fullName: "Ada L", e2eSource: false });

    // The value must come from the created row (the email's "Member Since"
    // row), and `create` must be the ONLY call made — no findUnique/findFirst
    // was added to fetch a timestamp the command already had.
    const published = d.events.publishUserCreated.mock.calls[0][0];
    expect(published.createdAt).toBe(CREATED_AT);
    expect(d.db.user.create).toHaveBeenCalledOnce();
    expect(Object.keys(d.db.user)).toEqual(["create"]);
  });

  it("hands the publisher the Cognito sub it already has, so the envelope's author can carry it", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    await command.execute({ email: "a@b.c", password: "P!1", fullName: "Ada L", e2eSource: false });

    // The SAME value signUp returned and the row was stamped with — not a
    // second lookup, and not the internal usr_ id wearing the wrong name.
    const published = d.events.publishUserCreated.mock.calls[0][0];
    expect(published.cognitoSub).toBe(d._created.cognitoSub);
    expect(published.cognitoSub).toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("leaves tags empty when e2eSource is false", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.tags).toEqual([]);
  });

  it("generates a usr_-prefixed id and passes it explicitly as the create data id", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.id).toMatch(/^usr_/);
    expect(d._created.id).toBe(user.id);
  });

  it("stamps the audit actor as AuditActor.Register (not the user's id)", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(d._created._actor).toBe(AuditActor.Register);
  });

  it("stamps cognitoSub from the Cognito signUp response on the created user (JE-38)", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(d._created.cognitoSub).toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("passes the generated usr_ id to signUp (so it lands in custom:app_user_id)", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const created = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    const appUserIdArg = d.auth.signUp.mock.calls[0][2];
    expect(appUserIdArg).toMatch(/^usr_/);
    expect(created.id).toBe(appUserIdArg);
  });
});

function identityDeps(nodeEnv: "development" | "production", capture = vi.fn(async () => ({ status: "captured" as const }))) {
  return {
    db: { user: { create: vi.fn(async (a: any) => ({ ...a.data, tags: a.data.tags, createdAt: CREATED_AT })) } } as any,
    auth: {
      signUp: vi.fn(async () => ({
        sub: "7904d681-f590-4b4d-bbce-15348a898873",
        email: "a@b.com",
        emailVerified: "true",
        userPoolId: "pool",
        clientId: "cli_1",
      })),
      login: vi.fn(),
    } as any,
    events: { publishUserCreated: vi.fn() } as any,
    env: { NODE_ENV: nodeEnv, AWS_REGION: "us-east-1" } as any,
    captureCognitoIdentityCommand: { execute: capture } as any,
  };
}

const identityInput = { email: "a@b.com", password: "P4ss!", fullName: "A B", e2eSource: false };

describe("RegisterUserCommand — Cognito identity capture (JE-38 Task 7)", () => {
  it("captures identity in-process when not production", async () => {
    const d = identityDeps("development");
    await new RegisterUserCommand(d).execute(identityInput);
    expect(d.captureCognitoIdentityCommand.execute).toHaveBeenCalledOnce();
    const evt = (d.captureCognitoIdentityCommand.execute as any).mock.calls[0][0];
    expect(evt.triggerSource).toBe("PostConfirmation_ConfirmSignUp");
    expect(evt.request.userAttributes.sub).toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("does NOT capture in production — the Lambda shim does", async () => {
    const d = identityDeps("production");
    await new RegisterUserCommand(d).execute(identityInput);
    expect(d.captureCognitoIdentityCommand.execute).not.toHaveBeenCalled();
  });

  it("still returns the user when capture fails (best-effort, spec D3)", async () => {
    const d = identityDeps("development", vi.fn(async () => { throw new Error("db down"); }));
    const user = await new RegisterUserCommand(d).execute(identityInput);
    expect(user.email).toBe("a@b.com");
  });
});
