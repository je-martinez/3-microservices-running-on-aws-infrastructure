import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import { LoginCommand, LoginHandler } from "../../src/users/commands/login.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

const TOKENS = { idToken: "id1", accessToken: "acc1", refreshToken: "rt1" };

async function buildBus(overrides: { findUnique?: unknown; login?: unknown } = {}) {
  const db = {
    user: { findUnique: overrides.findUnique ?? vi.fn(async () => ({ authType: "PASSWORD" })) },
  };
  const auth = { login: overrides.login ?? vi.fn(async () => TOKENS) };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: AUTH_PROVIDER, useValue: auth },
      LoginHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), db, auth, close: () => moduleRef.close() };
}

function loginSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "login");
}

describe("LoginCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns AuthTokens for a PASSWORD user with correct credentials", async () => {
    const { bus, close } = await buildBus();

    expect(await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }))).toEqual(
      TOKENS,
    );
    await close();
  });

  it("rejects a PASSWORDLESS user with generic 401 invalid_credentials, before calling Cognito", async () => {
    const { bus, auth, close } = await buildBus({
      findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })),
    });

    const err = await bus
      .execute(new LoginCommand({ email: "a@b.co", password: "x" }))
      .catch((e: unknown) => e);

    // NOT a 403: per auth-error-mapping's anti-enumeration rule the response
    // must be indistinguishable from a wrong password.
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect((err as InvalidCredentialsError).statusCode).toBe(401);
    expect((err as InvalidCredentialsError).code).toBe("invalid_credentials");
    // The guard must short-circuit BEFORE any Cognito call — a passwordless
    // account's random password must never even be tried.
    expect(auth.login).not.toHaveBeenCalled();
    await close();
  });

  it("logs reason: passwordless_user for the guard rejection, never a distinct status/code", async () => {
    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { bus, close } = await buildBus({
      findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })),
    });

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" })).catch(() => undefined);

    spy.mockRestore();
    const [fields] = calls[0] as [Record<string, unknown>];
    expect(fields.app_event).toBe("login_failed");
    expect(fields.reason).toBe("passwordless_user");
    // The password never reaches a log line, guard path included.
    expect(JSON.stringify(calls)).not.toContain('"x"');
    await close();
  });

  it("still rejects with invalid_credentials when no user row exists for the email", async () => {
    const { bus, auth, close } = await buildBus({
      findUnique: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw new InvalidCredentialsError();
      }),
    });

    await expect(
      bus.execute(new LoginCommand({ email: "nouser@b.co", password: "x" })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(auth.login).toHaveBeenCalledOnce();
    await close();
  });

  it("looks the user up by email exactly once per login", async () => {
    const { bus, db, close } = await buildBus();

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }));

    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "a@b.co" } });
    await close();
  });

  it("emits a 'login' span with app_event=login_succeeded on success", async () => {
    const { bus, close } = await buildBus();

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }));

    expect(loginSpan()).toBeDefined();
    expect(loginSpan()!.attributes.app_event).toBe("login_succeeded");
    expect(loginSpan()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("keeps reason=invalid_credentials on the span THROUGH the bus pipeline", async () => {
    // CONTRACT: This is the clobber guard. A generic interceptor catch that
    // stamps `unhandled_error` unconditionally destroys this value, and
    // `setAttributes` is last-write-wins per key. See [[logging-context]]
    const { bus, close } = await buildBus({
      login: vi.fn(async () => {
        throw new InvalidCredentialsError();
      }),
    });

    await expect(
      bus.execute(new LoginCommand({ email: "a@b.co", password: "wrong" })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(loginSpan()!.ended).toBe(true);
    expect(loginSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(loginSpan()!.attributes.app_event).toBe("login_failed");
    expect(loginSpan()!.attributes.reason).toBe("invalid_credentials");
    await close();
  });

  it("carries reason=passwordless_user on the span for the guard rejection, matching the log", async () => {
    const { bus, close } = await buildBus({
      findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })),
    });

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" })).catch(() => undefined);

    expect(loginSpan()!.attributes.reason).toBe("passwordless_user");
    expect(loginSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("reports reason=cognito_error when the provider fails for another reason", async () => {
    const { bus, close } = await buildBus({
      login: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });

    await expect(bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }))).rejects.toThrow(
      "cognito down",
    );

    expect(loginSpan()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("never puts the plaintext email or the password on the span", async () => {
    const { bus, close } = await buildBus();

    await bus.execute(new LoginCommand({ email: "ada@example.com", password: "Sup3rS3cret!" }));

    const serialized = JSON.stringify(loginSpan()!.attributes);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Sup3rS3cret!");
    expect(loginSpan()!.attributes.email_hash).toBeDefined();
    await close();
  });
});
