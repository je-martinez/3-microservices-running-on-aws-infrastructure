import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import {
  ConfirmPasswordResetCommand,
  ConfirmPasswordResetHandler,
} from "../../src/users/commands/confirm-password-reset.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { InvalidResetCodeError } from "#shared/auth/auth-errors";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";

const EMAIL = "jose@example.com";
const CODE = "123456";
const NEW_PASSWORD = "N3wP@ssw0rd!";
const USER = {
  id: "usr_1",
  email: EMAIL,
  fullName: "Jose",
  cognitoSub: "sub-1",
};

async function buildBus(
  overrides: {
    user?: unknown;
    accepted?: boolean;
    setPasswordRejects?: boolean;
    mirrorRejects?: boolean;
  } = {},
) {
  const db = {
    user: {
      findFirst: vi.fn(async () => ("user" in overrides ? overrides.user : USER)),
      update: vi.fn(async () => USER),
    },
  };
  const auth = {
    setPassword: vi.fn(async () => {
      if (overrides.setPasswordRejects) throw new Error("cognito down");
    }),
    setMustChangePassword: vi.fn(async () => {
      if (overrides.mirrorRejects) throw new Error("attribute write failed");
    }),
  };
  const resetCodeStore = {
    verifyAndConsume: vi.fn(async () => overrides.accepted ?? true),
  };
  const cacheGateway = { invalidate: vi.fn(async () => undefined) };
  const metrics = { publish: vi.fn(async () => {}) };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: AUTH_PROVIDER, useValue: auth },
      { provide: ResetCodeStore, useValue: resetCodeStore },
      { provide: CacheGateway, useValue: cacheGateway },
      { provide: MetricsPublisher, useValue: metrics },
      ConfirmPasswordResetHandler,
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
    resetCodeStore,
    cacheGateway,
    metrics,
    close: () => moduleRef.close(),
  };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "password_reset_confirm");
}

const input = { email: EMAIL, code: CODE, newPassword: NEW_PASSWORD };

describe("ConfirmPasswordResetCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("verifies the code, sets the password and clears mustChangePassword", async () => {
    const { bus, auth, db, resetCodeStore, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(resetCodeStore.verifyAndConsume).toHaveBeenCalledWith(EMAIL, CODE);
    expect(auth.setPassword).toHaveBeenCalledWith(EMAIL, NEW_PASSWORD);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "usr_1" },
      data: { mustChangePassword: false },
    });
    await close();
  });

  it("writes ONLY mustChangePassword — never the password itself", async () => {
    const { bus, db, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(Object.keys(db.user.update.mock.calls[0]![0].data)).toEqual(["mustChangePassword"]);
    await close();
  });

  it("throws InvalidResetCodeError when the store rejects the code", async () => {
    const { bus, close } = await buildBus({ accepted: false });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).rejects.toBeInstanceOf(
      InvalidResetCodeError,
    );
    await close();
  });

  it("throws the SAME InvalidResetCodeError for an unknown email", async () => {
    const { bus, close } = await buildBus({ user: null });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).rejects.toBeInstanceOf(
      InvalidResetCodeError,
    );
    await close();
  });

  it("never verifies a code for an unknown email", async () => {
    const { bus, resetCodeStore, auth, close } = await buildBus({ user: null });
    await bus.execute(new ConfirmPasswordResetCommand(input)).catch(() => undefined);
    expect(resetCodeStore.verifyAndConsume).not.toHaveBeenCalled();
    expect(auth.setPassword).not.toHaveBeenCalled();
    await close();
  });

  it("does not set a password when the code is rejected", async () => {
    const { bus, auth, db, close } = await buildBus({ accepted: false });
    await bus.execute(new ConfirmPasswordResetCommand(input)).catch(() => undefined);
    expect(auth.setPassword).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("does not clear the flag when Cognito rejects the new password", async () => {
    const { bus, db, close } = await buildBus({ setPasswordRejects: true });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).rejects.toThrow("cognito down");
    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("mirrors the cleared flag onto Cognito so the next token's claim is false", async () => {
    const { bus, auth, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(auth.setMustChangePassword).toHaveBeenCalledWith(EMAIL, false);
    await close();
  });

  it("still succeeds when the Cognito mirror fails — the password is already set", async () => {
    const { bus, db, close } = await buildBus({ mirrorRejects: true });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).resolves.toBeUndefined();
    expect(db.user.update).toHaveBeenCalled();
    await close();
  });

  it("publishes password_resets_total on success", async () => {
    const { bus, metrics, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(metrics.publish).toHaveBeenCalledWith("password_resets_total", 1, { Service: "users" });
    await close();
  });

  it("does NOT count a reset that was rejected", async () => {
    const { bus, metrics, close } = await buildBus({ accepted: false });
    await bus.execute(new ConfirmPasswordResetCommand(input)).catch(() => undefined);
    expect(metrics.publish).not.toHaveBeenCalled();
    await close();
  });

  it("emits password_reset_confirm_succeeded on success", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("password_reset_confirm_succeeded");
    expect(span()!.attributes.user_id).toBe("usr_1");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("emits ERROR with reason=invalid_or_expired_code when the store rejects", async () => {
    const { bus, close } = await buildBus({ accepted: false });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).rejects.toBeInstanceOf(
      InvalidResetCodeError,
    );
    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.app_event).toBe("password_reset_confirm_failed");
    expect(span()!.attributes.reason).toBe("invalid_or_expired_code");
    await close();
  });

  it("emits reason=unknown_email on the span for an unknown email", async () => {
    const { bus, close } = await buildBus({ user: null });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).rejects.toBeInstanceOf(
      InvalidResetCodeError,
    );
    expect(span()!.attributes.reason).toBe("unknown_email");
    await close();
  });

  it("never puts the submitted code, the new password or the plaintext email on the span", async () => {
    const { bus, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain(EMAIL);
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });

  it("drops the caller's cached profile after clearing mustChangePassword", async () => {
    const { bus, cacheGateway, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(cacheGateway.invalidate).toHaveBeenCalledWith(ME_KEY_PREFIX, meCacheKey("sub-1", "usr_1"));
    await close();
  });

  it("skips invalidation for a user whose Cognito identity was never captured", async () => {
    const { bus, cacheGateway, close } = await buildBus({
      user: { ...USER, cognitoSub: null },
    });
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(cacheGateway.invalidate).not.toHaveBeenCalled();
    await close();
  });

  it("does not invalidate when the code is rejected", async () => {
    const { bus, cacheGateway, close } = await buildBus({ accepted: false });
    await expect(bus.execute(new ConfirmPasswordResetCommand(input))).rejects.toBeInstanceOf(
      InvalidResetCodeError,
    );
    expect(cacheGateway.invalidate).not.toHaveBeenCalled();
    await close();
  });

  it("passes email and userId to the publish payload via the store-verified path", async () => {
    const { bus, auth, resetCodeStore, db, close } = await buildBus();
    await bus.execute(new ConfirmPasswordResetCommand(input));
    expect(resetCodeStore.verifyAndConsume).toHaveBeenCalledOnce();
    expect(auth.setPassword).toHaveBeenCalledOnce();
    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { email: EMAIL } });
    expect(db.user.update).toHaveBeenCalledOnce();
    await close();
  });
});
