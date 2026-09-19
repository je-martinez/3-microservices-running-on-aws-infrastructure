import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { DB, EVENT_PUBLISHER } from "#shared/tokens";
import {
  ForgotPasswordCommand,
  ForgotPasswordHandler,
} from "../../src/users/commands/forgot-password.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";

const EMAIL = "jose@example.com";
const USER = { id: "usr_1", email: EMAIL, fullName: "Jose", cognitoSub: "sub-1" };

async function buildBus(overrides: { user?: unknown; publishRejects?: boolean; storeRejects?: boolean } = {}) {
  const db = {
    user: { findFirst: vi.fn(async () => ("user" in overrides ? overrides.user : USER)) },
  };
  const events = {
    publishPasswordResetRequested: vi.fn(async () => {
      if (overrides.publishRejects) throw new Error("sqs down");
    }),
  };
  const resetCodeStore = {
    store: vi.fn(async () => {
      if (overrides.storeRejects) throw new Error("redis down");
    }),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: EVENT_PUBLISHER, useValue: events },
      { provide: ResetCodeStore, useValue: resetCodeStore },
      ForgotPasswordHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return {
    bus: moduleRef.get(CommandBus),
    db,
    events,
    resetCodeStore,
    close: () => moduleRef.close(),
  };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "password_reset_requested");
}

describe("ForgotPasswordCommand through the CommandBus", () => {
  beforeEach(() => {
    testSpanExporter.reset();
    vi.clearAllMocks();
  });

  it("stores a 6-digit code in the reset-code store for a known email", async () => {
    const { bus, resetCodeStore, close } = await buildBus();
    await bus.execute(new ForgotPasswordCommand({ email: EMAIL }));
    expect(resetCodeStore.store).toHaveBeenCalledTimes(1);
    const [email, code] = resetCodeStore.store.mock.calls[0]!;
    expect(email).toBe(EMAIL);
    expect(code).toMatch(/^\d{6}$/);
    await close();
  });

  it("publishes PASSWORD_RESET_REQUESTED with the SAME code it stored", async () => {
    const { bus, resetCodeStore, events, close } = await buildBus();
    await bus.execute(new ForgotPasswordCommand({ email: EMAIL }));
    const [, storedCode] = resetCodeStore.store.mock.calls[0]!;
    expect(events.publishPasswordResetRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        email: EMAIL,
        fullName: "Jose",
        code: storedCode,
        ttlSeconds: RESET_CODE_TTL_SECONDS,
      }),
    );
    await close();
  });

  it("resolves silently for an unknown email (no throw)", async () => {
    const { bus, close } = await buildBus({ user: null });
    await expect(
      bus.execute(new ForgotPasswordCommand({ email: "nobody@example.com" })),
    ).resolves.toBeUndefined();
    await close();
  });

  it("mints, stores and publishes NOTHING for an unknown email", async () => {
    const { bus, resetCodeStore, events, close } = await buildBus({ user: null });
    await bus.execute(new ForgotPasswordCommand({ email: "nobody@example.com" }));
    expect(resetCodeStore.store).not.toHaveBeenCalled();
    expect(events.publishPasswordResetRequested).not.toHaveBeenCalled();
    await close();
  });

  it("swallows a publish failure (best-effort, never rethrown)", async () => {
    const { bus, resetCodeStore, close } = await buildBus({ publishRejects: true });
    await expect(bus.execute(new ForgotPasswordCommand({ email: EMAIL }))).resolves.toBeUndefined();
    expect(resetCodeStore.store).toHaveBeenCalledTimes(1);
    await close();
  });

  it("emits password_reset_requested_succeeded for a known email", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new ForgotPasswordCommand({ email: EMAIL }));
    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("password_reset_requested_succeeded");
    expect(span()!.attributes.user_id).toBe("usr_1");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("marks an unknown email as a success with reason=unknown_email", async () => {
    const { bus, close } = await buildBus({ user: null });
    await bus.execute(new ForgotPasswordCommand({ email: "nobody@example.com" }));
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    expect(span()!.attributes.app_event).toBe("password_reset_requested_succeeded");
    expect(span()!.attributes.reason).toBe("unknown_email");
    await close();
  });

  it("emits an ERROR span when the store throws, with the span closed", async () => {
    const { bus, close } = await buildBus({ storeRejects: true });
    await expect(bus.execute(new ForgotPasswordCommand({ email: EMAIL }))).rejects.toThrow(
      "redis down",
    );
    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("never puts the minted code or the plaintext email on the span", async () => {
    const { bus, resetCodeStore, close } = await buildBus();
    await bus.execute(new ForgotPasswordCommand({ email: EMAIL }));
    const [, code] = resetCodeStore.store.mock.calls[0]!;
    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain(code as string);
    expect(serialized).not.toContain(EMAIL);
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });
});
