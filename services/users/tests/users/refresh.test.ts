import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { AUTH_PROVIDER } from "#shared/tokens";
import { RefreshCommand, RefreshHandler } from "../../src/users/commands/refresh.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";

async function buildBus(overrides: { refresh?: unknown } = {}) {
  const auth = {
    refresh:
      overrides.refresh ?? vi.fn(async () => ({ idToken: "id", accessToken: "acc" })),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: AUTH_PROVIDER, useValue: auth },
      RefreshHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), auth, close: () => moduleRef.close() };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "refresh");
}

describe("RefreshCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("delegates to auth.refresh with the token", async () => {
    const { bus, auth, close } = await buildBus();
    const res = await bus.execute(new RefreshCommand({ refreshToken: "rt" }));
    expect(auth.refresh).toHaveBeenCalledWith("rt");
    expect(res).toEqual({ idToken: "id", accessToken: "acc" });
    await close();
  });

  it("emits a 'refresh' span with reason=cognito_error on failure", async () => {
    const { bus, close } = await buildBus({
      refresh: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });
    await expect(bus.execute(new RefreshCommand({ refreshToken: "rt" }))).rejects.toThrow(
      "cognito down",
    );
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("never puts the refresh token on the span", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new RefreshCommand({ refreshToken: "super-secret-rt" }));
    expect(JSON.stringify(span()!.attributes)).not.toContain("super-secret-rt");
    expect(span()!.attributes.app_event).toBe("refresh_succeeded");
    await close();
  });
});
