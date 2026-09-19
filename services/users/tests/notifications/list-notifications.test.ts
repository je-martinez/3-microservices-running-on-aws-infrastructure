import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CqrsModule, QueryBus } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { DB } from "#shared/tokens";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { RoutineFailure } from "#shared/observability/workflow-metadata";
import {
  ListNotificationsHandler,
  ListNotificationsQuery,
  NOTIFICATIONS_LIMIT,
  WINDOW_DAYS,
} from "../../src/notifications/queries/list-notifications.query.ts";

function row(id: string, readAt: Date | null) {
  return {
    id,
    userId: "usr_alice",
    type: "ORDER_STATUS",
    title: "Your order has shipped",
    body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
    metadata: { status: "SHIPPED", occurred_at: "2026-08-01T17:48:03" },
    readAt,
    createdAt: new Date("2026-08-01T17:48:03Z"),
  };
}

function fakeDb(rows = [row("ntf_1", null)], counts = { unread: 1, window: 1 }) {
  const findManyArgs: Array<Record<string, unknown>> = [];
  const countArgs: Array<Record<string, unknown>> = [];
  return {
    findManyArgs,
    countArgs,
    db: {
      notification: {
        findMany: async (args: Record<string, unknown>) => {
          findManyArgs.push(args);
          return rows;
        },
        count: async (args: Record<string, unknown>) => {
          countArgs.push(args);
          const where = args.where as Record<string, unknown>;
          return where.readAt === null ? counts.unread : counts.window;
        },
      },
    } as never,
  };
}

async function buildBus(db: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      ListNotificationsHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(QueryBus), close: () => moduleRef.close() };
}

function listSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "list_notifications");
}

describe("ListNotificationsQuery through the QueryBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns the newest 50 by createdAt desc, scoped to the caller", async () => {
    const { db, findManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const page = await bus.execute(new ListNotificationsQuery(currentUser as never, "all"));

    expect(findManyArgs[0]).toMatchObject({
      where: { userId: "usr_alice" },
      orderBy: { createdAt: "desc" },
      take: NOTIFICATIONS_LIMIT,
    });
    expect(page.items).toHaveLength(1);
    expect(page.window_days).toBe(WINDOW_DAYS);
    await close();
  });

  it("caps the list at 50", () => {
    expect(NOTIFICATIONS_LIMIT).toBe(50);
  });

  // CONTRACT: The list query carries NO date bound — only window_total is scoped
  // to 90 days. A date-filtered list would hide the WELCOME row the All screen
  // shows in its EARLIER group.
  it("applies no date bound to the list itself", async () => {
    const { db, findManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    await bus.execute(new ListNotificationsQuery(currentUser as never, "all"));

    expect(JSON.stringify(findManyArgs[0]!.where)).not.toContain("createdAt");
    await close();
  });

  it.each([
    ["unread", null],
    ["read", { not: null }],
  ] as const)("filters %s on readAt", async (filter, expected) => {
    const { db, findManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    await bus.execute(new ListNotificationsQuery(currentUser as never, filter));

    expect((findManyArgs[0]!.where as Record<string, unknown>).readAt).toEqual(expected);
    await close();
  });

  it("does not filter on readAt for all", async () => {
    const { db, findManyArgs } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    await bus.execute(new ListNotificationsQuery(currentUser as never, "all"));

    expect("readAt" in (findManyArgs[0]!.where as Record<string, unknown>)).toBe(false);
    await close();
  });

  // CONTRACT: window_total is a 90-day count WITHOUT the cap, so it can exceed
  // items.length. That divergence is exactly why the counters are separate.
  it("counts the 90-day window without the cap", async () => {
    const { db, countArgs } = fakeDb([row("ntf_1", null)], { unread: 3, window: 120 });
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const page = await bus.execute(new ListNotificationsQuery(currentUser as never, "all"));

    expect(page.unread_count).toBe(3);
    expect(page.window_total).toBe(120);
    expect(page.window_total).toBeGreaterThan(page.items.length);

    const windowCall = countArgs.find(
      (args) => (args.where as Record<string, unknown>).readAt !== null,
    );
    expect(JSON.stringify(windowCall!.where)).toContain("createdAt");
    await close();
  });

  // The unread and window counts are BOTH unfiltered by the requested filter: the
  // pill on the Unread tab must still read the same totals as on All.
  it("keeps both counts independent of the requested filter", async () => {
    const { db, countArgs } = fakeDb([row("ntf_1", null)], { unread: 3, window: 120 });
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const page = await bus.execute(new ListNotificationsQuery(currentUser as never, "read"));

    expect(page.unread_count).toBe(3);
    expect(page.window_total).toBe(120);
    for (const args of countArgs) {
      expect((args.where as Record<string, unknown>).userId).toBe("usr_alice");
    }
    await close();
  });

  it("maps rows through toDomain rather than leaking the raw row", async () => {
    const { db } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    const page = await bus.execute(new ListNotificationsQuery(currentUser as never, "all"));

    expect(page.items[0]).toEqual({
      id: "ntf_1",
      userId: "usr_alice",
      type: "ORDER_STATUS",
      title: "Your order has shipped",
      body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
      metadata: { status: "SHIPPED", occurred_at: "2026-08-01T17:48:03" },
      readAt: null,
      createdAt: new Date("2026-08-01T17:48:03Z"),
    });
    await close();
  });

  it("returns an empty page for a missing user as ROUTINE failure — reason set, span NOT error", async () => {
    // CONTRACT: The interceptor unwraps RoutineFailure to its value (EMPTY_PAGE)
    // and leaves span status OK. Only a THROW sets ERROR.
    const { db } = fakeDb();
    const { bus, close } = await buildBus(db);
    const unknown = { identity: "sub-nobody", resolve: vi.fn(async () => null) };

    const page = await bus.execute(new ListNotificationsQuery(unknown as never, "all"));

    expect(page).toEqual({ items: [], unread_count: 0, window_total: 0, window_days: WINDOW_DAYS });
    expect(page).not.toBeInstanceOf(RoutineFailure);
    expect(listSpan()!.attributes.app_event).toBe("list_notifications_failed");
    expect(listSpan()!.attributes.reason).toBe("user_not_found");
    expect(listSpan()!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("emits list_notifications_succeeded with the resolved user_id on success", async () => {
    const { db } = fakeDb();
    const { bus, close } = await buildBus(db);
    const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) };

    await bus.execute(new ListNotificationsQuery(currentUser as never, "all"));

    expect(listSpan()!.attributes.app_event).toBe("list_notifications_succeeded");
    expect(listSpan()!.attributes.user_id).toBe("usr_alice");
    expect(listSpan()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });
});
