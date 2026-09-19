import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { AUTH_PROVIDER } from "#shared/tokens";
import {
  StartOtpChallengeCommand,
  StartOtpChallengeHandler,
} from "../../src/users/commands/start-otp-challenge.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

async function buildBus(overrides: { startOtpChallenge?: unknown } = {}) {
  const auth = {
    startOtpChallenge:
      overrides.startOtpChallenge ?? vi.fn(async () => ({ session: "sess_abc" })),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: AUTH_PROVIDER, useValue: auth },
      StartOtpChallengeHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), auth, close: () => moduleRef.close() };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_challenge");
}

describe("StartOtpChallengeCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns the session from the auth provider", async () => {
    const { bus, close } = await buildBus();
    expect(await bus.execute(new StartOtpChallengeCommand({ email: "a@b.co" }))).toEqual({
      session: "sess_abc",
    });
    await close();
  });

  it("passes the email through to the auth provider", async () => {
    const { bus, auth, close } = await buildBus();
    await bus.execute(new StartOtpChallengeCommand({ email: "a@b.co" }));
    expect(auth.startOtpChallenge).toHaveBeenCalledWith("a@b.co");
    await close();
  });

  it("propagates the auth provider's error untouched", async () => {
    const { bus, close } = await buildBus({
      startOtpChallenge: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });
    await expect(bus.execute(new StartOtpChallengeCommand({ email: "a@b.co" }))).rejects.toThrow(
      "cognito down",
    );
    await close();
  });

  it("rethrows InvalidCredentialsError untouched for an unknown user", async () => {
    const { bus, close } = await buildBus({
      startOtpChallenge: vi.fn(async () => {
        throw new InvalidCredentialsError();
      }),
    });
    await expect(
      bus.execute(new StartOtpChallengeCommand({ email: "ghost@b.co" })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await close();
  });

  it("never logs the returned session", async () => {
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { bus, close } = await buildBus();
    await bus.execute(new StartOtpChallengeCommand({ email: "a@b.co" }));
    expect(JSON.stringify(calls)).not.toContain("sess_abc");
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    await close();
  });

  it("emits an 'otp_challenge' span with app_event=otp_challenge_succeeded on success", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new StartOtpChallengeCommand({ email: "a@b.co" }));
    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("otp_challenge_succeeded");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("emits an 'otp_challenge' span with ERROR status and reason=cognito_error on failure", async () => {
    const { bus, close } = await buildBus({
      startOtpChallenge: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });
    await expect(bus.execute(new StartOtpChallengeCommand({ email: "a@b.co" }))).rejects.toThrow(
      "cognito down",
    );
    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.app_event).toBe("otp_challenge_failed");
    expect(span()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("never puts the session or the plaintext email on the span", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new StartOtpChallengeCommand({ email: "ada@example.com" }));
    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain("sess_abc");
    expect(serialized).not.toContain("ada@example.com");
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });
});
