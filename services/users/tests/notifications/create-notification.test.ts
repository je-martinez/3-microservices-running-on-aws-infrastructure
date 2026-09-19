import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { DB } from "#shared/tokens";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import {
  CreateNotificationCommand,
  CreateNotificationHandler,
  PUBLISH_TO_USER,
} from "../../src/notifications/commands/create-notification.command.ts";

function fakeDb(overrides?: {
  unreadCount?: number;
  findUser?: { cognitoSub: string | null } | null;
}) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    db: {
      notification: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "ntf_test000000000000000000", ...data, readAt: null, createdAt: new Date() };
        },
        count: async () => overrides?.unreadCount ?? 1,
      },
      user: {
        findFirst: async () =>
          overrides?.findUser === undefined ? { cognitoSub: "sub-abc" } : overrides.findUser,
      },
    } as never,
  };
}

const USER_CREATED = {
  type: "USER_CREATED",
  user_id: "usr_alice",
  order_id: null,
  author: { actor: "users_api:register", user_id: "usr_alice", cognito_sub: "sub-abc" },
  payload: {
    email: "a@b.c",
    fullName: "Alice B",
    userId: "usr_alice",
    createdAt: "2026-09-10T10:00:00.000Z",
  },
};

const ORDER_CREATED = {
  type: "ORDER_CREATED",
  user_id: "usr_alice",
  order_id: "ord_1",
  author: { actor: "orders_api:checkout", user_id: "usr_alice", cognito_sub: "sub-abc" },
  payload: {
    order_id: "ord_1",
    order_number: { raw: "3MRAI10482", formatted: "ORD-3MRAI-10482" },
    user_id: "usr_alice",
    email: "a@b.c",
    full_name: "Alice B",
    subtotal_cents: 4200,
    tax_cents: 336,
    shipping_cents: 0,
    total_cents: 4536,
    items: [{ name: "Widget", quantity: 1, unit_price_cents: 4200 }],
    created_at: "2026-09-10T11:20:00.000Z",
  },
};

const TRACKING_SHIPPED = {
  type: "TRACKING_STATUS_CHANGED",
  user_id: "usr_alice",
  order_id: "ord_1",
  author: { actor: "tracking:carrier_webhook", cognito_sub: "sub-abc" },
  payload: {
    status: "SHIPPED",
    previous_status: "PROCESSING",
    changed_at: "2026-08-01T17:48:03",
    order_id: "ord_1",
    order_number: { raw: "3MRAI10482", formatted: "ORD-3MRAI-10482" },
  },
};

async function buildBus(db: unknown, publish: ReturnType<typeof vi.fn>) {
  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: PUBLISH_TO_USER, useValue: publish },
      CreateNotificationHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), close: () => moduleRef.close() };
}

function createdSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "notification_created");
}

describe("CreateNotificationCommand through the CommandBus", () => {
  const publishToUser = vi.fn<(sub: string, message: unknown) => Promise<void>>();

  beforeEach(() => {
    testSpanExporter.reset();
    publishToUser.mockReset();
    publishToUser.mockResolvedValue(undefined);
  });

  it("stores a WELCOME row from USER_CREATED", async () => {
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);

    const result = await bus.execute(new CreateNotificationCommand(USER_CREATED as never));

    expect(result).toBe("created");
    expect(created[0]).toMatchObject({
      userId: "usr_alice",
      type: "WELCOME",
      title: "Welcome to 3MRAI!",
      body: "Your account is ready. Start exploring orders, tracking and more.",
      // CONTRACT: `createdBy` is passed EXPLICITLY. The consumer runs outside any
      // request, so the extension's AsyncLocalStorage actor is undefined and would
      // stamp null on a non-nullable column.
      createdBy: "users_api:notification_created",
    });
    expect((created[0]!.metadata as Record<string, unknown>).order_id).toBeUndefined();
    expect((created[0]!.metadata as Record<string, unknown>).occurred_at).toBe(
      "2026-09-10T10:00:00.000Z",
    );
    await close();
  });

  it("stores an ORDER_STATUS row from TRACKING_STATUS_CHANGED", async () => {
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);

    const result = await bus.execute(new CreateNotificationCommand(TRACKING_SHIPPED as never));

    expect(result).toBe("created");
    expect(created[0]).toMatchObject({
      userId: "usr_alice",
      type: "ORDER_STATUS",
      title: "Your order has shipped",
      body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
    });
    expect(created[0]!.metadata).toMatchObject({
      status: "SHIPPED",
      order_id: "ord_1",
      order_number: "ORD-3MRAI-10482",
      occurred_at: "2026-08-01T17:48:03",
    });
    await close();
  });

  it("tolerates a tracking payload with no order number", async () => {
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);
    const withoutNumber = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, order_number: undefined },
    };

    await bus.execute(new CreateNotificationCommand(withoutNumber as never));

    expect(created[0]!.body).toBe("Handed to the carrier and on its way to you.");
    expect((created[0]!.metadata as Record<string, unknown>).order_number).toBeUndefined();
    await close();
  });

  // CONTRACT: ORDER_CREATED is the trigger for the PLACED variant. PLACED is never
  // emitted as a tracking status, so this is the ONLY path that writes it.
  // See [[2026-09-10-in-app-notifications-design]]
  it("stores the PLACED ORDER_STATUS row from ORDER_CREATED", async () => {
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);

    const result = await bus.execute(new CreateNotificationCommand(ORDER_CREATED as never));

    expect(result).toBe("created");
    expect(created[0]).toMatchObject({
      userId: "usr_alice",
      type: "ORDER_STATUS",
      title: "Order placed",
      body: "ORD-3MRAI-10482 · Received and confirmed. We'll email your receipt.",
    });
    expect(created[0]!.metadata).toMatchObject({
      status: "PLACED",
      order_id: "ord_1",
      order_number: "ORD-3MRAI-10482",
      occurred_at: "2026-09-10T11:20:00.000Z",
    });
    await close();
  });

  // CONTRACT: `order_number` is `OrderNumberSchema.optional()` on ORDER_CREATED's
  // payload — an order predating the backfill omits the key entirely, and the body
  // must degrade to the bare sentence rather than rendering "undefined · ".
  it("tolerates an ORDER_CREATED payload with no order number", async () => {
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);
    const withoutNumber = {
      ...ORDER_CREATED,
      payload: { ...ORDER_CREATED.payload, order_number: undefined },
    };

    await bus.execute(new CreateNotificationCommand(withoutNumber as never));

    expect(created[0]!.title).toBe("Order placed");
    expect(created[0]!.body).toBe("Received and confirmed. We'll email your receipt.");
    expect(created[0]!.body).not.toContain("undefined");
    expect((created[0]!.metadata as Record<string, unknown>).order_number).toBeUndefined();
    expect((created[0]!.metadata as Record<string, unknown>).status).toBe("PLACED");
    await close();
  });

  it("discards an ORDER_CREATED payload missing created_at with reason=missing_created_at", async () => {
    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);
    const bogus = {
      ...ORDER_CREATED,
      payload: { ...ORDER_CREATED.payload, created_at: undefined },
    };

    const result = await bus.execute(new CreateNotificationCommand(bogus as never));

    spy.mockRestore();
    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
    const [fields] = calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("missing_created_at");
    expect(createdSpan()!.attributes.reason).toBe("missing_created_at");
    await close();
  });

  // CONTRACT: PLACED can only ever arrive via ORDER_CREATED. A tracking event
  // carrying it is impossible in production, and accepting it here would mask a
  // producer regression — so it is discarded, not mapped.
  it("discards a TRACKING_STATUS_CHANGED carrying PLACED", async () => {
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);
    const placedTransition = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, status: "PLACED" },
    };

    const result = await bus.execute(new CreateNotificationCommand(placedTransition as never));

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
    await close();
  });

  // Defence in depth alongside the SNS filter policy. ORDER_CREATED is NOT in this
  // list any more — it is handled, per the spec's 2026-09-10 correction.
  it.each(["AUTH_OTP_REQUESTED", "PASSWORD_RESET_REQUESTED"])(
    "discards %s without writing a row and records reason=not_a_notification_type",
    async (type) => {
      const calls: unknown[] = [];
      const spy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);
      const { db, created } = fakeDb();
      const { bus, close } = await buildBus(db, publishToUser);

      const result = await bus.execute(
        new CreateNotificationCommand({ ...USER_CREATED, type } as never),
      );

      spy.mockRestore();
      expect(result).toBe("discarded");
      expect(created).toHaveLength(0);
      expect(publishToUser).not.toHaveBeenCalled();
      const discarded = calls.find(
        (args) => (args as [Record<string, unknown>])[0]?.reason === "not_a_notification_type",
      );
      expect(discarded).toBeDefined();
      expect(createdSpan()!.attributes.reason).toBe("not_a_notification_type");
      await close();
    },
  );

  it("pushes the notification and the unread count to the owner's sockets", async () => {
    const { db } = fakeDb({ unreadCount: 4 });
    const { bus, close } = await buildBus(db, publishToUser);

    await bus.execute(new CreateNotificationCommand(TRACKING_SHIPPED as never));

    expect(publishToUser).toHaveBeenCalledTimes(1);
    const [sub, message] = publishToUser.mock.calls[0]!;
    expect(sub).toBe("sub-abc");
    expect(message).toMatchObject({
      type: "NOTIFICATION_CREATED",
      unread_count: 4,
      notification: { type: "ORDER_STATUS", title: "Your order has shipped", read_at: null },
    });
    await close();
  });

  // CONTRACT: The push must never fail the persistence.
  it("still reports created when the push throws, with reason=push_preparation_failed", async () => {
    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { db, created } = fakeDb();
    publishToUser.mockRejectedValue(new Error("socket layer down"));
    const { bus, close } = await buildBus(db, publishToUser);

    const result = await bus.execute(new CreateNotificationCommand(TRACKING_SHIPPED as never));

    spy.mockRestore();
    expect(result).toBe("created");
    expect(created).toHaveLength(1);
    const [fields] = calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("push_preparation_failed");
    expect(createdSpan()!.attributes.reason).toBe("push_preparation_failed");
    expect(createdSpan()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  // The envelope's author.cognito_sub is absent on a carrier-webhook transition,
  // so the command resolves it from its OWN users table — no remote call.
  it("resolves cognito_sub locally when the envelope omits it", async () => {
    const { db } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);
    const noSub = { ...TRACKING_SHIPPED, author: { actor: "tracking:carrier_webhook" } };

    await bus.execute(new CreateNotificationCommand(noSub as never));

    expect(publishToUser).toHaveBeenCalledWith("sub-abc", expect.anything());
    await close();
  });

  it("skips the push when the user has no cognito_sub at all", async () => {
    const { db, created } = fakeDb({ findUser: null });
    const { bus, close } = await buildBus(db, publishToUser);
    const noSub = { ...TRACKING_SHIPPED, author: { actor: "tracking:carrier_webhook" } };

    const result = await bus.execute(new CreateNotificationCommand(noSub as never));

    expect(result).toBe("created");
    expect(created).toHaveLength(1);
    expect(publishToUser).not.toHaveBeenCalled();
    await close();
  });

  // An invalid payload is a PERMANENT error: logged and consumed, never thrown,
  // because retrying it to the DLQ has no chance of success.
  it("discards a tracking payload with an unknown status and reason=unknown_tracking_status", async () => {
    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { db, created } = fakeDb();
    const { bus, close } = await buildBus(db, publishToUser);
    const bogus = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, status: "TELEPORTED" },
    };

    const result = await bus.execute(new CreateNotificationCommand(bogus as never));

    spy.mockRestore();
    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
    const [fields] = calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("unknown_tracking_status");
    expect(createdSpan()!.attributes.reason).toBe("unknown_tracking_status");
    await close();
  });
});
