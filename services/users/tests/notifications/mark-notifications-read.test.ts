import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { AuditActor } from "#shared/audit/audit-actor";
import { DB } from "#shared/tokens";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { RoutineFailure } from "#shared/observability/workflow-metadata";
import {
  MarkNotificationsReadCommand,
  MarkNotificationsReadHandler,
} from "../../src/notifications/commands/mark-notifications-read.command.ts";

function fakeDb(updatedCount = 2, unreadAfter = 1) {
  const updateManyArgs: Array<Record<string, unknown>> = [];
  return {
    updateManyArgs,
    db: {
      notification: {
        updateMany: async (args: Record<string, unknown>) => {
          updateManyArgs.push(args);
          return { count: updatedCount };
        },
        count: async () => unreadAfter,
      },
    } as never,
  };
}

async function buildBus(db: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      MarkNotificationsReadHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), close: () => moduleRef.close() };
}

function markSpan() {
  return testSpanExporter
    .getFinishedSpans()
    .find((s) => s.name === "notifications_marked_read");
}

describe("MarkNotificationsReadCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("stamps read_at on the caller's unread rows only", async () => {
    const { db, updateManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const result = await bus.execute(
      new MarkNotificationsReadCommand(currentUser as never, { ids: ["ntf_1", "ntf_2"] }),
    );

    expect(result).toEqual({ updated: 2, unread_count: 1 });
    const where = updateManyArgs[0]!.where as Record<string, unknown>;
    // CONTRACT: The user_id clause IS the ownership check — another user's ids
    // simply do not match and are not counted.
    expect(where).toMatchObject({ id: { in: ["ntf_1", "ntf_2"] }, userId: "usr_alice" });
    // CONTRACT: readAt IS NULL makes it idempotent, which matters because
    // mark-on-enter can fire twice on an Angular remount.
    expect(where.readAt).toBeNull();
    await close();
  });

  // The audit actor is passed explicitly: this write can run inside a request, but
  // stamping it here keeps the column readable as the action rather than the caller.
  it("stamps the mark-read audit actor", async () => {
    const { db, updateManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    await bus.execute(
      new MarkNotificationsReadCommand(currentUser as never, { ids: ["ntf_1"] }),
    );

    const data = updateManyArgs[0]!.data as Record<string, unknown>;
    expect(data.updatedBy).toBe(AuditActor.NotificationsMarkedRead);
    expect(data.readAt).toBeInstanceOf(Date);
    await close();
  });

  // An empty list is the NORMAL case: arriving with nothing unread.
  it("returns 200-shaped zero for an empty id list without touching updateMany", async () => {
    const { db, updateManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const result = await bus.execute(
      new MarkNotificationsReadCommand(currentUser as never, { ids: [] }),
    );

    expect(result.updated).toBe(0);
    expect(updateManyArgs).toHaveLength(0);
    await close();
  });

  it("reports zero updated when the ids belong to someone else", async () => {
    const { db } = fakeDb(0, 5);
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const result = await bus.execute(
      new MarkNotificationsReadCommand(currentUser as never, { ids: ["ntf_x"] }),
    );

    expect(result).toEqual({ updated: 0, unread_count: 5 });
    await close();
  });

  it("returns zero for a caller with no user row and records reason=user_not_found", async () => {
    const { db, updateManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const unknown = { identity: "sub-nobody", resolve: vi.fn(async () => null) };

    const result = await bus.execute(
      new MarkNotificationsReadCommand(unknown as never, { ids: ["ntf_1"] }),
    );

    expect(result).toEqual({ updated: 0, unread_count: 0 });
    expect(result).not.toBeInstanceOf(RoutineFailure);
    expect(updateManyArgs).toHaveLength(0);
    expect(markSpan()!.attributes.reason).toBe("user_not_found");
    expect(markSpan()!.attributes.app_event).toBe("notifications_marked_read_failed");
    expect(markSpan()!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });
});
