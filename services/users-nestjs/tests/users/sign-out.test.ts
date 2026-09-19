import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { AUTH_PROVIDER } from "#shared/tokens";
import { SignOutCommand, SignOutHandler } from "../../src/users/commands/sign-out.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";

async function buildBus(overrides: { signOut?: unknown } = {}) {
  const auth = {
    signOut: overrides.signOut ?? vi.fn(async () => undefined),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: AUTH_PROVIDER, useValue: auth },
      SignOutHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), auth, close: () => moduleRef.close() };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "sign_out");
}

describe("SignOutCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("delegates to auth.signOut with the access token", async () => {
    const { bus, auth, close } = await buildBus();
    await expect(bus.execute(new SignOutCommand({ accessToken: "at" }))).resolves.toBeUndefined();
    expect(auth.signOut).toHaveBeenCalledWith("at");
    await close();
  });

  it("resolves when the session was already revoked", async () => {
    const { bus, auth, close } = await buildBus();
    await bus.execute(new SignOutCommand({ accessToken: "already-dead" }));
    await expect(
      bus.execute(new SignOutCommand({ accessToken: "already-dead" })),
    ).resolves.toBeUndefined();
    expect(auth.signOut).toHaveBeenCalledTimes(2);
    await close();
  });

  it("rethrows an unexpected provider failure untouched", async () => {
    const boom = new Error("TooManyRequestsException");
    const { bus, close } = await buildBus({
      signOut: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(bus.execute(new SignOutCommand({ accessToken: "at" }))).rejects.toBe(boom);
    await close();
  });

  it("emits reason=cognito_error on the span when Cognito rejects", async () => {
    const { bus, close } = await buildBus({
      signOut: vi.fn(async () => {
        throw new Error("TooManyRequestsException");
      }),
    });
    await bus.execute(new SignOutCommand({ accessToken: "at" })).catch(() => undefined);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("never puts the access token on the span", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new SignOutCommand({ accessToken: "super-secret-at" }));
    expect(JSON.stringify(span()!.attributes)).not.toContain("super-secret-at");
    expect(span()!.attributes.app_event).toBe("sign_out_succeeded");
    await close();
  });
});
