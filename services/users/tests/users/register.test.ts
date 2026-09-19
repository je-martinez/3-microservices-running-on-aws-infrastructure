import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { AUTH_PROVIDER, DB, EVENT_PUBLISHER } from "#shared/tokens";
import { RegisterCommand, RegisterHandler } from "../../src/users/commands/register.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { EmailAlreadyExistsError } from "#shared/auth/auth-errors";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { CaptureCognitoIdentityCommand } from "#features/users/webhooks/capture-cognito-identity";

const CREATED_AT = new Date("2026-01-15T10:30:00.000Z");
const SUB = "7904d681-f590-4b4d-bbce-15348a898873";

async function buildBus(
  overrides: {
    signUp?: unknown;
    create?: unknown;
    publishUserCreated?: unknown;
    metricsPublish?: unknown;
    capture?: unknown;
    nodeEnv?: string;
  } = {},
) {
  const prevNodeEnv = process.env.NODE_ENV;
  if (overrides.nodeEnv !== undefined) process.env.NODE_ENV = overrides.nodeEnv;
  const created: Record<string, unknown> = {};
  const db = {
    user: {
      create:
        overrides.create ??
        vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(created, data);
          created._actor = getActor();
          return { ...data, createdAt: CREATED_AT };
        }),
    },
  };
  const auth = {
    signUp:
      overrides.signUp ??
      vi.fn(async () => ({
        sub: SUB,
        email: "a@b.c",
        emailVerified: "true",
        userPoolId: "pool",
        clientId: "cli_1",
      })),
  };
  const events = {
    publishUserCreated: overrides.publishUserCreated ?? vi.fn(async () => {}),
  };
  const metrics = {
    publish: overrides.metricsPublish ?? vi.fn(async () => {}),
  };
  const capture = {
    execute: overrides.capture ?? vi.fn(async () => ({ status: "captured" as const })),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: AUTH_PROVIDER, useValue: auth },
      { provide: EVENT_PUBLISHER, useValue: events },
      { provide: MetricsPublisher, useValue: metrics },
      { provide: CaptureCognitoIdentityCommand, useValue: capture },
      RegisterHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return {
    bus: moduleRef.get(CommandBus),
    db,
    auth,
    events,
    metrics,
    capture,
    created,
    close: async () => {
      process.env.NODE_ENV = prevNodeEnv;
      await moduleRef.close();
    },
  };
}

function registerSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "register");
}

const baseInput = {
  email: "a@b.c",
  password: "P!1",
  fullName: "A",
  e2eSource: false,
};

describe("RegisterCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("adds 'E2E Source' to tags when e2eSource is true", async () => {
    const { bus, events, close } = await buildBus();
    const user = await bus.execute(new RegisterCommand({ ...baseInput, e2eSource: true }));
    expect(user.tags).toContain("E2E Source");
    expect(events.publishUserCreated).toHaveBeenCalledOnce();
    await close();
  });

  it("publishes USER_CREATED with the id, email, fullName AND createdAt the welcome email renders", async () => {
    const { bus, events, close } = await buildBus();
    const user = await bus.execute(
      new RegisterCommand({ ...baseInput, email: "a@b.c", fullName: "Ada L" }),
    );
    expect(events.publishUserCreated).toHaveBeenCalledWith({
      id: user.id,
      email: "a@b.c",
      fullName: "Ada L",
      createdAt: CREATED_AT,
      cognitoSub: SUB,
    });
    await close();
  });

  it("takes createdAt off the row the create returned, without a second database read", async () => {
    const { bus, events, db, close } = await buildBus();
    await bus.execute(new RegisterCommand({ ...baseInput, fullName: "Ada L" }));
    const published = events.publishUserCreated.mock.calls[0]![0];
    expect(published.createdAt).toBe(CREATED_AT);
    expect(db.user.create).toHaveBeenCalledOnce();
    expect(Object.keys(db.user)).toEqual(["create"]);
    await close();
  });

  it("hands the publisher the Cognito sub it already has, so the envelope's author can carry it", async () => {
    const { bus, events, created, close } = await buildBus();
    await bus.execute(new RegisterCommand({ ...baseInput, fullName: "Ada L" }));
    const published = events.publishUserCreated.mock.calls[0]![0];
    expect(published.cognitoSub).toBe(created.cognitoSub);
    expect(published.cognitoSub).toBe(SUB);
    await close();
  });

  it("leaves tags empty when e2eSource is false", async () => {
    const { bus, close } = await buildBus();
    const user = await bus.execute(new RegisterCommand(baseInput));
    expect(user.tags).toEqual([]);
    await close();
  });

  it("generates a usr_-prefixed id and passes it explicitly as the create data id", async () => {
    const { bus, created, close } = await buildBus();
    const user = await bus.execute(new RegisterCommand(baseInput));
    expect(user.id).toMatch(/^usr_/);
    expect(created.id).toBe(user.id);
    await close();
  });

  it("stamps the audit actor as AuditActor.Register (not the user's id)", async () => {
    const { bus, created, close } = await buildBus();
    await bus.execute(new RegisterCommand(baseInput));
    expect(created._actor).toBe(AuditActor.Register);
    await close();
  });

  it("stamps cognitoSub from the Cognito signUp response on the created user", async () => {
    const { bus, created, close } = await buildBus();
    await bus.execute(new RegisterCommand(baseInput));
    expect(created.cognitoSub).toBe(SUB);
    await close();
  });

  it("passes the generated usr_ id to signUp (so it lands in custom:app_user_id)", async () => {
    const { bus, auth, close } = await buildBus();
    const created = await bus.execute(new RegisterCommand(baseInput));
    const appUserIdArg = auth.signUp.mock.calls[0]![2];
    expect(appUserIdArg).toMatch(/^usr_/);
    expect(created.id).toBe(appUserIdArg);
    await close();
  });

  it("publishes users_registered_total on success", async () => {
    const publish = vi.fn(async () => {});
    const { bus, close } = await buildBus({ metricsPublish: publish });
    await bus.execute(
      new RegisterCommand({
        email: "ada@example.com",
        password: "Complexpass#123",
        fullName: "Ada Lovelace",
        e2eSource: false,
      }),
    );
    expect(publish).toHaveBeenCalledWith("users_registered_total", 1, { Service: "users" });
    await close();
  });

  it("captures identity in-process when not production", async () => {
    const { bus, capture, close } = await buildBus({ nodeEnv: "development" });
    await bus.execute(new RegisterCommand({ ...baseInput, email: "a@b.com", fullName: "A B" }));
    expect(capture.execute).toHaveBeenCalledOnce();
    const evt = capture.execute.mock.calls[0]![0];
    expect(evt.triggerSource).toBe("PostConfirmation_ConfirmSignUp");
    expect(evt.request.userAttributes.sub).toBe(SUB);
    await close();
  });

  it("does NOT capture in production — the Lambda shim does", async () => {
    const { bus, capture, close } = await buildBus({ nodeEnv: "production" });
    await bus.execute(new RegisterCommand({ ...baseInput, email: "a@b.com", fullName: "A B" }));
    expect(capture.execute).not.toHaveBeenCalled();
    await close();
  });

  it("still returns the user when capture fails (best-effort)", async () => {
    const { bus, close } = await buildBus({
      nodeEnv: "development",
      capture: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const user = await bus.execute(
      new RegisterCommand({ ...baseInput, email: "a@b.com", fullName: "A B" }),
    );
    expect(user.email).toBe("a@b.com");
    await close();
  });

  it("emits a 'register' span with app_event=register_succeeded on success", async () => {
    const { bus, close } = await buildBus();
    const user = await bus.execute(new RegisterCommand(baseInput));
    expect(registerSpan()).toBeDefined();
    expect(registerSpan()!.attributes.app_event).toBe("register_succeeded");
    expect(registerSpan()!.attributes.auth_type).toBe("PASSWORD");
    expect(registerSpan()!.attributes.user_id).toBe(user.id);
    expect(registerSpan()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("emits a 'register' span with ERROR status and reason=duplicate_email when the email is taken", async () => {
    const { bus, close } = await buildBus({
      signUp: vi.fn(async () => {
        throw new EmailAlreadyExistsError();
      }),
    });
    await expect(bus.execute(new RegisterCommand(baseInput))).rejects.toBeInstanceOf(
      EmailAlreadyExistsError,
    );
    expect(registerSpan()!.ended).toBe(true);
    expect(registerSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(registerSpan()!.attributes.app_event).toBe("register_failed");
    expect(registerSpan()!.attributes.reason).toBe("duplicate_email");
    await close();
  });

  it("reports reason=cognito_error when signUp fails for another reason", async () => {
    const { bus, close } = await buildBus({
      signUp: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });
    await expect(bus.execute(new RegisterCommand(baseInput))).rejects.toThrow("cognito down");
    expect(registerSpan()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("reports reason=database_error when the create fails", async () => {
    const { bus, close } = await buildBus({
      create: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(bus.execute(new RegisterCommand(baseInput))).rejects.toThrow("db down");
    expect(registerSpan()!.attributes.reason).toBe("database_error");
    await close();
  });

  it("never puts the plaintext email or the password on the span", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(
      new RegisterCommand({
        email: "ada@example.com",
        password: "Sup3rS3cret!",
        fullName: "Ada",
        e2eSource: false,
      }),
    );
    const serialized = JSON.stringify(registerSpan()!.attributes);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Sup3rS3cret!");
    expect(registerSpan()!.attributes.email_hash).toBeDefined();
    await close();
  });
});
