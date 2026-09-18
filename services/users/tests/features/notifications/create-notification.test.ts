import { describe, it, expect, vi, beforeEach } from "vitest";

const publishToUser = vi.fn<(sub: string, message: unknown) => Promise<void>>();
vi.mock("#shared/realtime/websocket-publisher", () => ({
  publishToUser: (sub: string, message: unknown) => publishToUser(sub, message),
}));

const { CreateNotificationCommand } = await import(
  "#features/notifications/commands/create-notification"
);

// A Prisma double narrow enough to type-check against the two calls the command
// makes, and no wider — a fake that accepts anything hides a schema mismatch.
function fakeDb(overrides?: { unreadCount?: number; findUser?: { cognitoSub: string | null } | null }) {
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
  payload: { email: "a@b.c", fullName: "Alice B", userId: "usr_alice", createdAt: "2026-09-10T10:00:00.000Z" },
};

// The payload ORDER_CREATED really carries, per OrderCreatedPayloadSchema at
// functions/events-pipeline/src/handlers/order-created.ts:24. Only four of its
// fields matter here; the rest ride along untouched.
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

describe("CreateNotificationCommand", () => {
  beforeEach(() => {
    publishToUser.mockReset();
    publishToUser.mockResolvedValue(undefined);
  });

  it("stores a WELCOME row from USER_CREATED", async () => {
    const { db, created } = fakeDb();
    const result = await new CreateNotificationCommand({ db }).execute(USER_CREATED as never);

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
    // WELCOME carries no order_id, consistent with the envelope.
    expect((created[0]!.metadata as Record<string, unknown>).order_id).toBeUndefined();
    expect((created[0]!.metadata as Record<string, unknown>).occurred_at).toBe(
      "2026-09-10T10:00:00.000Z",
    );
  });

  it("stores an ORDER_STATUS row from TRACKING_STATUS_CHANGED", async () => {
    const { db, created } = fakeDb();
    const result = await new CreateNotificationCommand({ db }).execute(TRACKING_SHIPPED as never);

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
  });

  it("tolerates a tracking payload with no order number", async () => {
    const { db, created } = fakeDb();
    const withoutNumber = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, order_number: undefined },
    };

    await new CreateNotificationCommand({ db }).execute(withoutNumber as never);

    expect(created[0]!.body).toBe("Handed to the carrier and on its way to you.");
    expect((created[0]!.metadata as Record<string, unknown>).order_number).toBeUndefined();
  });

  // CONTRACT: ORDER_CREATED is the trigger for the PLACED variant. PLACED is never
  // emitted as a tracking status, so this is the ONLY path that writes it.
  // See [[2026-09-10-in-app-notifications-design]]
  it("stores the PLACED ORDER_STATUS row from ORDER_CREATED", async () => {
    const { db, created } = fakeDb();
    const result = await new CreateNotificationCommand({ db }).execute(ORDER_CREATED as never);

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
      // occurred_at comes from the payload's `created_at`, the confirmed field name.
      occurred_at: "2026-09-10T11:20:00.000Z",
    });
  });

  // CONTRACT: `order_number` is `OrderNumberSchema.optional()` on ORDER_CREATED's
  // payload — an order predating the backfill omits the key entirely, and the body
  // must degrade to the bare sentence rather than rendering "undefined · ".
  it("tolerates an ORDER_CREATED payload with no order number", async () => {
    const { db, created } = fakeDb();
    const withoutNumber = {
      ...ORDER_CREATED,
      payload: { ...ORDER_CREATED.payload, order_number: undefined },
    };

    await new CreateNotificationCommand({ db }).execute(withoutNumber as never);

    expect(created[0]!.title).toBe("Order placed");
    expect(created[0]!.body).toBe("Received and confirmed. We'll email your receipt.");
    expect(created[0]!.body).not.toContain("undefined");
    expect((created[0]!.metadata as Record<string, unknown>).order_number).toBeUndefined();
    expect((created[0]!.metadata as Record<string, unknown>).status).toBe("PLACED");
  });

  it("discards an ORDER_CREATED payload missing created_at", async () => {
    const { db, created } = fakeDb();
    const bogus = {
      ...ORDER_CREATED,
      payload: { ...ORDER_CREATED.payload, created_at: undefined },
    };

    const result = await new CreateNotificationCommand({ db }).execute(bogus as never);

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
  });

  // CONTRACT: PLACED can only ever arrive via ORDER_CREATED. A tracking event
  // carrying it is impossible in production, and accepting it here would mask a
  // producer regression — so it is discarded, not mapped.
  it("discards a TRACKING_STATUS_CHANGED carrying PLACED", async () => {
    const { db, created } = fakeDb();
    const placedTransition = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, status: "PLACED" },
    };

    const result = await new CreateNotificationCommand({ db }).execute(placedTransition as never);

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
  });

  // Defence in depth alongside the SNS filter policy. ORDER_CREATED is NOT in this
  // list any more — it is handled, per the spec's 2026-09-10 correction.
  it.each(["AUTH_OTP_REQUESTED", "PASSWORD_RESET_REQUESTED"])(
    "discards %s without writing a row",
    async (type) => {
      const { db, created } = fakeDb();
      const result = await new CreateNotificationCommand({ db }).execute({
        ...USER_CREATED,
        type,
      } as never);

      expect(result).toBe("discarded");
      expect(created).toHaveLength(0);
      expect(publishToUser).not.toHaveBeenCalled();
    },
  );

  it("pushes the notification and the unread count to the owner's sockets", async () => {
    const { db } = fakeDb({ unreadCount: 4 });
    await new CreateNotificationCommand({ db }).execute(TRACKING_SHIPPED as never);

    expect(publishToUser).toHaveBeenCalledTimes(1);
    const [sub, message] = publishToUser.mock.calls[0]!;
    expect(sub).toBe("sub-abc");
    expect(message).toMatchObject({
      type: "NOTIFICATION_CREATED",
      unread_count: 4,
      notification: { type: "ORDER_STATUS", title: "Your order has shipped", read_at: null },
    });
  });

  // CONTRACT: The push must never fail the persistence.
  it("still reports created when the push throws", async () => {
    const { db, created } = fakeDb();
    publishToUser.mockRejectedValue(new Error("socket layer down"));

    const result = await new CreateNotificationCommand({ db }).execute(TRACKING_SHIPPED as never);

    expect(result).toBe("created");
    expect(created).toHaveLength(1);
  });

  // The envelope's author.cognito_sub is absent on a carrier-webhook transition,
  // so the command resolves it from its OWN users table — no remote call.
  it("resolves cognito_sub locally when the envelope omits it", async () => {
    const { db } = fakeDb();
    const noSub = { ...TRACKING_SHIPPED, author: { actor: "tracking:carrier_webhook" } };

    await new CreateNotificationCommand({ db }).execute(noSub as never);

    expect(publishToUser).toHaveBeenCalledWith("sub-abc", expect.anything());
  });

  it("skips the push when the user has no cognito_sub at all", async () => {
    const { db, created } = fakeDb({ findUser: null });
    const noSub = { ...TRACKING_SHIPPED, author: { actor: "tracking:carrier_webhook" } };

    const result = await new CreateNotificationCommand({ db }).execute(noSub as never);

    // The row is still stored — it appears when the panel is opened.
    expect(result).toBe("created");
    expect(created).toHaveLength(1);
    expect(publishToUser).not.toHaveBeenCalled();
  });

  // An invalid payload is a PERMANENT error: logged and consumed, never thrown,
  // because retrying it to the DLQ has no chance of success.
  it("discards a tracking payload with an unknown status", async () => {
    const { db, created } = fakeDb();
    const bogus = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, status: "TELEPORTED" },
    };

    const result = await new CreateNotificationCommand({ db }).execute(bogus as never);

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
  });
});
