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
  VerifyOtpChallengeCommand,
  VerifyOtpChallengeHandler,
} from "../../src/users/commands/verify-otp-challenge.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { InvalidOtpError } from "#shared/auth/auth-errors";

const TOKENS = { idToken: "id1", accessToken: "acc1", refreshToken: "rt1" };

async function buildBus(overrides: { respondToOtpChallenge?: unknown } = {}) {
  const auth = {
    respondToOtpChallenge: overrides.respondToOtpChallenge ?? vi.fn(async () => TOKENS),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: AUTH_PROVIDER, useValue: auth },
      VerifyOtpChallengeHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), auth, close: () => moduleRef.close() };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_verify");
}

describe("VerifyOtpChallengeCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns AuthTokens on a correct code", async () => {
    const { bus, close } = await buildBus();
    expect(
      await bus.execute(
        new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "042817" }),
      ),
    ).toEqual(TOKENS);
    await close();
  });

  it("passes email, session and code through to the auth provider in that order", async () => {
    const { bus, auth, close } = await buildBus();
    await bus.execute(
      new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "042817" }),
    );
    expect(auth.respondToOtpChallenge).toHaveBeenCalledWith("a@b.co", "sess_1", "042817");
    await close();
  });

  it("rethrows InvalidOtpError untouched on an incorrect code", async () => {
    const { bus, close } = await buildBus({
      respondToOtpChallenge: vi.fn(async () => {
        throw new InvalidOtpError();
      }),
    });
    const err = await bus
      .execute(new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "000000" }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOtpError);
    expect((err as InvalidOtpError).statusCode).toBe(401);
    expect((err as InvalidOtpError).code).toBe("invalid_otp");
    await close();
  });

  it("never logs the submitted code — on the success path", async () => {
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { bus, close } = await buildBus();
    await bus.execute(
      new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "042817" }),
    );
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("042817");
    expect(serialized).not.toContain("sess_1");
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    await close();
  });

  it("never logs the submitted code — on the failure path", async () => {
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { bus, close } = await buildBus({
      respondToOtpChallenge: vi.fn(async () => {
        throw new InvalidOtpError();
      }),
    });
    await bus
      .execute(new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "999123" }))
      .catch(() => undefined);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("999123");
    expect(serialized).not.toContain("sess_1");
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    await close();
  });

  it("logs reason invalid_otp for a wrong code and cognito_error otherwise", async () => {
    const calls: unknown[] = [];
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const a = await buildBus({
      respondToOtpChallenge: vi.fn(async () => {
        throw new InvalidOtpError();
      }),
    });
    await a.bus
      .execute(new VerifyOtpChallengeCommand({ email: "a@b.co", session: "s", code: "000000" }))
      .catch(() => undefined);
    await a.close();

    const b = await buildBus({
      respondToOtpChallenge: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });
    await b.bus
      .execute(new VerifyOtpChallengeCommand({ email: "a@b.co", session: "s", code: "000000" }))
      .catch(() => undefined);
    await b.close();

    errorSpy.mockRestore();
    const reasons = [
      ...new Set(calls.map((c) => (c as [Record<string, unknown>])[0]!.reason)),
    ];
    expect(reasons).toEqual(["invalid_otp", "cognito_error"]);
  });

  it("emits an 'otp_verify' span with app_event=otp_verify_succeeded on success", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(
      new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "042817" }),
    );
    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("otp_verify_succeeded");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("emits an 'otp_verify' span with ERROR status and reason=invalid_otp on a wrong code", async () => {
    const { bus, close } = await buildBus({
      respondToOtpChallenge: vi.fn(async () => {
        throw new InvalidOtpError();
      }),
    });
    await expect(
      bus.execute(
        new VerifyOtpChallengeCommand({ email: "a@b.co", session: "sess_1", code: "000000" }),
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);
    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.app_event).toBe("otp_verify_failed");
    expect(span()!.attributes.reason).toBe("invalid_otp");
    await close();
  });

  it("never puts the submitted code or session on the span — success path", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(
      new VerifyOtpChallengeCommand({
        email: "ada@example.com",
        session: "sess_1",
        code: "042817",
      }),
    );
    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain("042817");
    expect(serialized).not.toContain("sess_1");
    expect(serialized).not.toContain("ada@example.com");
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });

  it("never puts the submitted code or session on the span — failure path", async () => {
    const { bus, close } = await buildBus({
      respondToOtpChallenge: vi.fn(async () => {
        throw new InvalidOtpError();
      }),
    });
    await bus
      .execute(
        new VerifyOtpChallengeCommand({
          email: "ada@example.com",
          session: "sess_1",
          code: "999123",
        }),
      )
      .catch(() => undefined);
    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain("999123");
    expect(serialized).not.toContain("sess_1");
    expect(serialized).not.toContain("ada@example.com");
    await close();
  });
});
