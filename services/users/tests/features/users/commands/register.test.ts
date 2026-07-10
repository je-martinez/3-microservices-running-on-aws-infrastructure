import { describe, it, expect, vi } from "vitest";
import { RegisterUserCommand } from "#features/users/commands/register";

function deps(overrides: Record<string, unknown> = {}) {
  const created: any = {};
  return {
    db: { user: { create: vi.fn(async ({ data }: any) => { Object.assign(created, data); return data; }) } },
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

  it("leaves tags empty when e2eSource is false", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.tags).toEqual([]);
  });

  it("generates a usr_-prefixed id and passes it explicitly in create data (self-actor semantics)", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.id).toMatch(/^usr_/);
    expect(d._created.id).toBe(user.id);
  });

  it("stamps cognitoSub from the Cognito signUp response on the created user (JE-38)", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(d._created.cognitoSub).toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });
});

function identityDeps(nodeEnv: "development" | "production", capture = vi.fn(async () => ({ status: "captured" as const }))) {
  return {
    db: { user: { create: vi.fn(async (a: any) => ({ ...a.data, tags: a.data.tags })) } } as any,
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
