import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CommandHandler, CqrsModule, type ICommandHandler } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { trace } from "@opentelemetry/api";

// WORKAROUND(test): #shared/config/env is owned by another worker and may be
// absent while this suite runs. appLogger pulls env at module load.
vi.mock("#shared/config/env", () => ({
  env: { DEPLOYMENT_ENVIRONMENT: "test" },
}));

import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";

class HappyCommand {}
class ThrowingWithReasonCommand {}
class ThrowingBareCommand {}
class RoutineCommand {}

@Workflow("happy_flow")
@CommandHandler(HappyCommand)
class HappyHandler implements ICommandHandler<HappyCommand> {
  async execute(): Promise<string> {
    return "ok";
  }
}

@Workflow("reasoned_flow")
@CommandHandler(ThrowingWithReasonCommand)
class ThrowingWithReasonHandler implements ICommandHandler<ThrowingWithReasonCommand> {
  async execute(): Promise<never> {
    // The handler records its own specific reason and logs its own line, exactly
    // as login.ts and change-password.ts do today.
    trace.getActiveSpan()?.setAttributes({
      app_event: "reasoned_flow_failed",
      reason: "invalid_credentials",
    });
    appLogger.error(
      { app_event: "reasoned_flow_failed", reason: "invalid_credentials" },
      "handler logged its own failure",
    );
    throw new Error("rejected");
  }
}

@Workflow("bare_flow")
@CommandHandler(ThrowingBareCommand)
class ThrowingBareHandler implements ICommandHandler<ThrowingBareCommand> {
  async execute(): Promise<never> {
    throw new Error("boom");
  }
}

@Workflow("routine_flow")
@CommandHandler(RoutineCommand)
class RoutineHandler implements ICommandHandler<RoutineCommand> {
  async execute(): Promise<RoutineFailure> {
    return new RoutineFailure("user_not_found");
  }
}

@Module({
  imports: [CqrsModule],
  providers: [
    HappyHandler,
    ThrowingWithReasonHandler,
    ThrowingBareHandler,
    RoutineHandler,
    { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
  ],
})
class WorkflowTestModule {}

async function bus() {
  const moduleRef = await Test.createTestingModule({ imports: [WorkflowTestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), close: () => moduleRef.close() };
}

function spanNamed(name: string) {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === name);
}

describe("WorkflowInterceptor", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits a span with app_event=<flow>_succeeded and OK status on success", async () => {
    const { bus: b, close } = await bus();

    expect(await b.execute(new HappyCommand())).toBe("ok");

    const span = spanNamed("happy_flow");
    expect(span!.attributes.app_event).toBe("happy_flow_succeeded");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.attributes.reason).toBeUndefined();
    await close();
  });

  it("does NOT clobber a reason the handler already recorded", async () => {
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingWithReasonCommand())).rejects.toThrow("rejected");

    const span = spanNamed("reasoned_flow");
    expect(span!.attributes.reason).toBe("invalid_credentials");
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("stamps reason=unhandled_error only when the handler recorded none", async () => {
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingBareCommand())).rejects.toThrow("boom");

    const span = spanNamed("bare_flow");
    expect(span!.attributes.reason).toBe("unhandled_error");
    expect(span!.attributes.app_event).toBe("bare_flow_failed");
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("leaves span status OK for a routine (non-throwing) failure", async () => {
    const { bus: b, close } = await bus();

    await b.execute(new RoutineCommand());

    const span = spanNamed("routine_flow");
    expect(span!.attributes.app_event).toBe("routine_flow_failed");
    expect(span!.attributes.reason).toBe("user_not_found");
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("logs exactly ONE *_failed line when the handler logged its own", async () => {
    const lines: Array<Record<string, unknown>> = [];
    // Call through so noteLoggedEvent still runs — a silent mock would make
    // hasLoggedEvent always false and the suppression assertion vacuous.
    const original = appLogger.error.bind(appLogger);
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      lines.push(args[0] as Record<string, unknown>);
      return original(...(args as Parameters<typeof original>));
    }) as never);
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingWithReasonCommand())).rejects.toThrow("rejected");

    spy.mockRestore();
    expect(lines.filter((l) => l.app_event === "reasoned_flow_failed")).toHaveLength(1);
    await close();
  });

  it("logs its own *_failed line when the handler logged none", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const original = appLogger.error.bind(appLogger);
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      lines.push(args[0] as Record<string, unknown>);
      return original(...(args as Parameters<typeof original>));
    }) as never);
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingBareCommand())).rejects.toThrow("boom");

    spy.mockRestore();
    expect(lines.filter((l) => l.app_event === "bare_flow_failed")).toHaveLength(1);
    await close();
  });
});
