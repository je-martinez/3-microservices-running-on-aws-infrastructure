import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { AUTH_PROVIDER, DB, EVENT_PUBLISHER } from "#shared/tokens";
import { RegisterPasswordlessCommand, RegisterPasswordlessHandler } from "../../src/users/commands/register-passwordless.command.ts";
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
      RegisterPasswordlessHandler,
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

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "register_passwordless");
}

const baseInput = {
  email: "a@b.c",
  fullName: "A",
  e2eSource: false,
};

describe("RegisterPasswordlessCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("adds 'E2E Source' to tags when e2eSource is true", async () => {
    const { bus, events, close } = await buildBus();
    const user = await bus.execute(new RegisterPasswordlessCommand({ ...baseInput, e2eSource: true }));
    expect(user.tags).toContain("E2E Source");
    expect(events.publishUserCreated).toHaveBeenCalledOnce();
    await close();
  });

  it("publishes USER_CREATED with the id, email, fullName AND createdAt the welcome email renders", async () => {
    const { bus, events, close } = await buildBus();
    const user = await bus.execute(
      new RegisterPasswordlessCommand({ ...baseInput, email: "a@b.c", fullName: "Ada L" }),
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
    await bus.execute(new RegisterPasswordlessCommand({ ...baseInput, fullName: "Ada L" }));
    const published = events.publishUserCreated.mock.calls[0]![0];
    expect(published.createdAt).toBe(CREATED_AT);
    expect(db.user.create).toHaveBeenCalledOnce();
    expect(Object.keys(db.user)).toEqual(["create"]);
    await close();
  });

  it("hands the publisher the Cognito sub it already has, so the envelope's author can carry it", async () => {
    const { bus, events, created, close } = await buildBus();
    await bus.execute(new RegisterPasswordlessCommand({ ...baseInput, fullName: "Ada L" }));
    const published = events.publishUserCreated.mock.calls[0]![0];
    expect(published.cognitoSub).toBe(created.cognitoSub);
    expect(published.cognitoSub).toBe(SUB);
    await close();
  });

  it("leaves tags empty when e2eSource is false", async () => {
    const { bus, close } = await buildBus();
    const user = await bus.execute(new RegisterPasswordlessCommand(baseInput));
    expect(user.tags).toEqual([]);
    await close();
  });

  it("generates a usr_-prefixed id and passes it explicitly as the create data id", async () => {
    const { bus, created, close } = await buildBus();
    const user = await bus.execute(new RegisterPasswordlessCommand(baseInput));
    expect(user.id).toMatch(/^usr_/);
    expect(created.id).toBe(user.id);
    await close();
  });

  it("stamps the audit actor as AuditActor.RegisterPasswordless (not the user's id)", async () => {
    const { bus, created, close } = await buildBus();
    await bus.execute(new RegisterPasswordlessCommand(baseInput));
    expect(created._actor).toBe(AuditActor.RegisterPasswordless);
    await close();
  });

  it("stamps cognitoSub from the Cognito signUp response on the created user", async () => {
    const { bus, created, close } = await buildBus();
    await bus.execute(new RegisterPasswordlessCommand(baseInput));
    expect(created.cognitoSub).toBe(SUB);
    await close();
  });

  it("passes the generated usr_ id to signUp (so it lands in custom:app_user_id)", async () => {
    const { bus, auth, close } = await buildBus();
    const created = await bus.execute(new RegisterPasswordlessCommand(baseInput));
    const appUserIdArg = auth.signUp.mock.calls[0]![2];
    expect(appUserIdArg).toMatch(/^usr_/);
    expect(created.id).toBe(appUserIdArg);
    await close();
  });

  it("publishes users_registered_total on success", async () => {
    const publish = vi.fn(async () => {});
    const { bus, close } = await buildBus({ metricsPublish: publish });
    await bus.execute(
      new RegisterPasswordlessCommand({
        email: "ada@example.com",
        fullName: "Ada Lovelace",
        e2eSource: false,
      }),
    );
    expect(publish).toHaveBeenCalledWith("users_registered_total", 1, { Service: "users" });
    await close();
  });

  it("captures identity in-process when not production", async () => {
    const { bus, capture, close } = await buildBus({ nodeEnv: "development" });
    await bus.execute(new RegisterPasswordlessCommand({ ...baseInput, email: "a@b.com", fullName: "A B" }));
    expect(capture.execute).toHaveBeenCalledOnce();
    const evt = capture.execute.mock.calls[0]![0];
    expect(evt.triggerSource).toBe("PostConfirmation_ConfirmSignUp");
    expect(evt.request.userAttributes.sub).toBe(SUB);
    await close();
  });

  it("does NOT capture in production — the Lambda shim does", async () => {
    const { bus, capture, close } = await buildBus({ nodeEnv: "production" });
    await bus.execute(new RegisterPasswordlessCommand({ ...baseInput, email: "a@b.com", fullName: "A B" }));
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
      new RegisterPasswordlessCommand({ ...baseInput, email: "a@b.com", fullName: "A B" }),
    );
    expect(user.email).toBe("a@b.com");
    await close();
  });

  it("creates a user with authType PASSWORDLESS", async () => {
    const { bus, created, close } = await buildBus();
    const user = await bus.execute(new RegisterPasswordlessCommand(baseInput));
    expect(created.authType).toBe("PASSWORDLESS");
    expect(user.authType).toBe("PASSWORDLESS");
    await close();
  });

  it("calls auth.signUp with a random password never exposed on the returned user", async () => {
    const { bus, auth, close } = await buildBus();
    const user = await bus.execute(new RegisterPasswordlessCommand(baseInput));
    const passwordArg = auth.signUp.mock.calls[0]![1] as string;
    expect(passwordArg.length).toBeGreaterThan(16);
    expect(JSON.stringify(user)).not.toContain(passwordArg);
    await close();
  });

  it("generates a different random password on every call", async () => {
    const { bus, auth, close } = await buildBus();
    await bus.execute(new RegisterPasswordlessCommand(baseInput));
    await bus.execute(new RegisterPasswordlessCommand({ ...baseInput, email: "b@b.c" }));
    expect(auth.signUp.mock.calls[0]![1]).not.toBe(auth.signUp.mock.calls[1]![1]);
    await close();
  });

  it("emits a register_passwordless span with auth_type=PASSWORDLESS on success", async () => {
    const { bus, close } = await buildBus();
    const user = await bus.execute(new RegisterPasswordlessCommand(baseInput));
    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("register_passwordless_succeeded");
    expect(span()!.attributes.auth_type).toBe("PASSWORDLESS");
    expect(span()!.attributes.user_id).toBe(user.id);
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("emits ERROR status and reason=duplicate_email when the email is taken", async () => {
    const { bus, close } = await buildBus({
      signUp: vi.fn(async () => {
        throw new EmailAlreadyExistsError();
      }),
    });
    await expect(bus.execute(new RegisterPasswordlessCommand(baseInput))).rejects.toBeInstanceOf(
      EmailAlreadyExistsError,
    );
    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.app_event).toBe("register_passwordless_failed");
    expect(span()!.attributes.reason).toBe("duplicate_email");
    await close();
  });

  it("reports reason=cognito_error when signUp fails for another reason", async () => {
    const { bus, close } = await buildBus({
      signUp: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });
    await expect(bus.execute(new RegisterPasswordlessCommand(baseInput))).rejects.toThrow("cognito down");
    expect(span()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("reports reason=database_error when the create fails", async () => {
    const { bus, close } = await buildBus({
      create: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(bus.execute(new RegisterPasswordlessCommand(baseInput))).rejects.toThrow("db down");
    expect(span()!.attributes.reason).toBe("database_error");
    await close();
  });

  it("never puts the plaintext email or the password on the span", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(
      new RegisterPasswordlessCommand({
        email: "ada@example.com",
        fullName: "Ada",
        e2eSource: false,
      }),
    );
    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Sup3rS3cret!");
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });
});
