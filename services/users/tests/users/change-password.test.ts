import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { symbols } from "pino";
import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import {
  ChangePasswordCommand,
  ChangePasswordHandler,
} from "../../src/users/commands/change-password.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { RoutineFailure } from "#shared/observability/workflow-metadata";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");
const NEW_PASSWORD = "N3wP@ssw0rd!";

const ROW = {
  id: "usr_1",
  email: "jose@example.com",
  fullName: "Jose",
  cognitoSub: "cognito-sub-1",
  address: null,
  phoneNumber: null,
  tags: [] as string[],
  authType: "PASSWORD" as const,
  mustChangePassword: false,
  createdBy: "usr_1",
  createdAt: FIXED_DATE,
  updatedBy: "usr_1",
  updatedAt: FIXED_DATE,
  deletedBy: null,
  deletedAt: null,
};

type CapturedLine = Record<string, unknown>;

// CONTRACT: Capture the STREAM, not a method spy — `span_id` is added by
// formatters.log on the way out, so a spy cannot prove the line ran inside the span.
async function captureAppLogs(fn: () => Promise<void>): Promise<CapturedLine[]> {
  const lines: string[] = [];
  const logger = appLogger as unknown as Record<symbol, unknown>;
  const original = logger[symbols.streamSym];
  logger[symbols.streamSym] = { write: (s: string) => lines.push(s) };
  try {
    await fn();
  } finally {
    logger[symbols.streamSym] = original;
  }
  return lines.map((line) => JSON.parse(line) as CapturedLine);
}

function lineFor(lines: CapturedLine[], appEvent: string): CapturedLine | undefined {
  return lines.find((l) => l.app_event === appEvent);
}

async function buildBus(
  overrides: { resolved?: unknown; cognitoRejects?: boolean; mirrorRejects?: boolean } = {},
) {
  const resolved =
    "resolved" in overrides
      ? overrides.resolved
      : { id: "usr_1", email: "jose@example.com" };
  const db = { user: { update: vi.fn(async () => ROW) } };
  const auth = {
    setPassword: vi.fn(async () => {
      if (overrides.cognitoRejects) throw new Error("cognito down");
    }),
    setMustChangePassword: vi.fn(async () => {
      if (overrides.mirrorRejects) throw new Error("attribute write failed");
    }),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: AUTH_PROVIDER, useValue: auth },
      ChangePasswordHandler,
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
    currentUser: { resolve: vi.fn(async () => resolved) },
    close: () => moduleRef.close(),
  };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
}

describe("ChangePasswordCommand through the CommandBus", () => {
  beforeEach(() => {
    testSpanExporter.reset();
    vi.clearAllMocks();
  });

  it("sets the password and clears mustChangePassword", async () => {
    const { bus, auth, db, currentUser, close } = await buildBus();

    const result = await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(auth.setPassword).toHaveBeenCalledWith("jose@example.com", NEW_PASSWORD);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "usr_1" },
      data: { mustChangePassword: false },
    });
    expect(result).toMatchObject({ id: "usr_1", mustChangePassword: false });
    await close();
  });

  it("writes ONLY mustChangePassword — no other profile field", async () => {
    const { bus, db, currentUser, close } = await buildBus();

    await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    const [{ data }] = db.user.update.mock.calls[0]!;
    expect(Object.keys(data)).toEqual(["mustChangePassword"]);
    await close();
  });

  it("returns null when the caller resolves to no user (route answers 404)", async () => {
    const { bus, auth, db, currentUser, close } = await buildBus({ resolved: null });

    const result = await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(result).toBeNull();
    expect(result).not.toBeInstanceOf(RoutineFailure);
    expect(auth.setPassword).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("does not clear the flag when Cognito rejects the password", async () => {
    const { bus, db, currentUser, close } = await buildBus({ cognitoRejects: true });

    await expect(
      bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD })),
    ).rejects.toThrow("cognito down");
    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("mirrors the cleared flag onto Cognito so the next token's claim is false", async () => {
    const { bus, auth, currentUser, close } = await buildBus();

    await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(auth.setMustChangePassword).toHaveBeenCalledWith("jose@example.com", false);
    await close();
  });

  it("still succeeds when the Cognito mirror fails — the durable write already happened", async () => {
    const { bus, db, currentUser, close } = await buildBus({ mirrorRejects: true });

    const result = await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(result).toMatchObject({ id: "usr_1", mustChangePassword: false });
    expect(db.user.update).toHaveBeenCalled();
    await close();
  });

  it("does not mirror when the password set failed", async () => {
    const { bus, auth, currentUser, close } = await buildBus({ cognitoRejects: true });

    await expect(
      bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD })),
    ).rejects.toThrow("cognito down");
    expect(auth.setMustChangePassword).not.toHaveBeenCalled();
    await close();
  });

  it("emits a 'change_password' span with app_event=change_password_succeeded on success", async () => {
    const { bus, currentUser, close } = await buildBus();

    await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("change_password_succeeded");
    expect(span()!.attributes.user_id).toBe("usr_1");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("sets ERROR status and reason=cognito_error when Cognito rejects", async () => {
    const { bus, currentUser, close } = await buildBus({ cognitoRejects: true });

    await expect(
      bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD })),
    ).rejects.toThrow("cognito down");

    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.app_event).toBe("change_password_failed");
    expect(span()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("marks the unresolved caller with reason=unknown_user and does NOT mark the span ERROR", async () => {
    // Returning null is a real outcome of this workflow — the route answers the
    // same 404 the other /me routes do, so this is routine, not a fault.
    const { bus, currentUser, close } = await buildBus({ resolved: null });

    const result = await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(result).toBeNull();
    expect(span()!.attributes.reason).toBe("unknown_user");
    expect(span()!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("calls Cognito BEFORE the database write", async () => {
    // If Cognito fails, nothing has changed anywhere and a retry is clean.
    const { bus, db, currentUser, close } = await buildBus({ cognitoRejects: true });

    await bus
      .execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }))
      .catch(() => undefined);

    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("never puts the new password or the plaintext email on the span", async () => {
    const { bus, currentUser, close } = await buildBus();

    await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain("jose@example.com");
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });

  it("logs change_password_failed/unknown_user for the 404 branch", async () => {
    const { bus, currentUser, close } = await buildBus({ resolved: null });

    const lines = await captureAppLogs(async () => {
      await bus.execute(
        new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
      );
    });

    const line = lineFor(lines, "change_password_failed");
    expect(line).toBeDefined();
    expect(line!.reason).toBe("unknown_user");
    expect(line!.severity_text).toBe("WARN");
    await close();
  });

  it("emits that line INSIDE the change_password span", async () => {
    const { bus, currentUser, close } = await buildBus({ resolved: null });

    const lines = await captureAppLogs(async () => {
      await bus.execute(
        new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
      );
    });

    expect(lineFor(lines, "change_password_failed")!.span_id).toBe(span()!.spanContext().spanId);
    await close();
  });

  it("carries the same app_event/reason pair on the span as on the line", async () => {
    const { bus, currentUser, close } = await buildBus({ resolved: null });

    await captureAppLogs(async () => {
      await bus.execute(
        new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
      );
    });

    expect(span()!.attributes.app_event).toBe("change_password_failed");
    expect(span()!.attributes.reason).toBe("unknown_user");
    await close();
  });

  it("never logs the new password on the unresolved-caller path", async () => {
    const { bus, currentUser, close } = await buildBus({ resolved: null });

    const lines = await captureAppLogs(async () => {
      await bus.execute(
        new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
      );
    });

    expect(JSON.stringify(lines)).not.toContain(NEW_PASSWORD);
    await close();
  });
});
