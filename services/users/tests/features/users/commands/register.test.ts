import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { RegisterUserCommand } from "#features/users/commands/register";
import { EmailAlreadyExistsError } from "#shared/auth/auth-errors";
import { testSpanExporter } from "../../../setup-tracing.ts";
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
    // Default double so every test in this file can construct the command; the
    // counter assertion below overrides it with its own spy.
    metricsPublisher: { publish: vi.fn(async () => {}) },
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

  it("publishes users_registered_total on success", async () => {
    const publish = vi.fn(async () => {});
    const d = deps({ metricsPublisher: { publish } });
    const cmd = new RegisterUserCommand(d as any);

    await cmd.execute({
      email: "ada@example.com",
      password: "Complexpass#123",
      fullName: "Ada Lovelace",
      e2eSource: false,
    });

    // The exact dimension set is asserted, not just the name: dashboards query
    // { Service: "users" } and a mismatch returns silently-empty results.
    expect(publish).toHaveBeenCalledWith("users_registered_total", 1, { Service: "users" });
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
    metricsPublisher: { publish: vi.fn(async () => {}) } as any,
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

// The workflow span for this flow. Asserted against a REAL exporter (registered
// in tests/setup-tracing.ts), not a mock: the point is the shape of the span
// that actually reaches a backend — its name, its status, and above all that it
// was ended, since an unended span silently never reaches Jaeger at all.
describe("RegisterUserCommand tracing", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits a 'register' span with app_event=register_succeeded on success", async () => {
    const command = new RegisterUserCommand(deps());
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "register");
    expect(span).toBeDefined();
    expect(span!.attributes.app_event).toBe("register_succeeded");
    expect(span!.attributes.auth_type).toBe("PASSWORD");
    expect(span!.attributes.user_id).toBe(user.id);
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits a 'register' span with ERROR status and reason=duplicate_email when the email is taken", async () => {
    const d = deps({
      auth: {
        signUp: vi.fn(async () => {
          throw new EmailAlreadyExistsError();
        }),
      },
    });

    await expect(
      new RegisterUserCommand(d).execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false }),
    ).rejects.toBeInstanceOf(EmailAlreadyExistsError);

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "register");
    expect(span!.ended).toBe(true);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    // The SAME reason the register_failed log line carries on this branch.
    expect(span!.attributes.app_event).toBe("register_failed");
    expect(span!.attributes.reason).toBe("duplicate_email");
  });

  it("never puts the plaintext email or the password on the span", async () => {
    // Span attributes reach a tracing backend exactly as log fields reach a log
    // backend, so the PII rules in [[logging-context]] apply unchanged.
    await new RegisterUserCommand(deps()).execute({
      email: "ada@example.com",
      password: "Sup3rS3cret!",
      fullName: "Ada",
      e2eSource: false,
    });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "register");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Sup3rS3cret!");
    expect(span!.attributes.email_hash).toBeDefined();
  });
});
