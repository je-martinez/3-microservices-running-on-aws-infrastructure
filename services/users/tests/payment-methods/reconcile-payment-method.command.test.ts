import "reflect-metadata";

Object.assign(process.env, {
  DATABASE_WRITER_URL: "http://127.0.0.1/db",
  DATABASE_READER_URL: "http://127.0.0.1/db",
  COGNITO_USER_POOL_ID: "pool",
  COGNITO_CLIENT_ID: "client",
  AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
  AWS_REGION: "us-east-1",
  WEBHOOK_SECRET: "test-webhook-secret",
  INTERNAL_API_KEY: "test-api-key",
  ORDERS_BASE_URL: "http://127.0.0.1:3001",
  TRACKING_BASE_URL: "http://127.0.0.1:3002",
  EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:events",
  NOTIFICATIONS_QUEUE_URL: "http://127.0.0.1:4566/queue",
  WS_MANAGEMENT_ENDPOINT: "http://127.0.0.1:4566/execute-api/api/$default",
  WS_CONNECTIONS_TABLE: "ws-connections",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
});

const { describe, expect, it, vi, beforeEach } = await import("vitest");
const { Module } = await import("@nestjs/common");
const { Test } = await import("@nestjs/testing");
const { CqrsModule, CommandBus } = await import("@nestjs/cqrs");
const Stripe = (await import("stripe")).default;
const { appLogger } = await import("#shared/logging/app-logger");
const { DB, STRIPE_CLIENT } = await import("#shared/tokens");
const {
  ReconcilePaymentMethodCommand,
  ReconcilePaymentMethodHandler,
} = await import("#payment-methods/commands/reconcile-payment-method.command");

async function buildBus(db: unknown, stripeHolder: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      ReconcilePaymentMethodHandler,
      { provide: DB, useValue: db },
      { provide: STRIPE_CLIENT, useValue: stripeHolder },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), close: () => moduleRef.close() };
}

// A `$primary()` call must resolve to a client whose model methods are the
// SAME mocks the rest of the test wires up, so assertions on `findFirst`
// etc. see calls made through EITHER path.
function dbWithPrimary(overrides: Record<string, unknown> = {}) {
  const base = { ...overrides };
  return { ...base, $primary: vi.fn(() => base) };
}

function attachedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "payment_method.attached",
    data: { object: { id: "pm_1", ...overrides } },
  } as unknown as import("stripe").default.Event;
}

function detachedEvent() {
  return {
    id: "evt_2",
    type: "payment_method.detached",
    data: { object: { id: "pm_1" } },
  } as unknown as import("stripe").default.Event;
}

function customerUpdatedEvent() {
  return {
    id: "evt_3",
    type: "customer.updated",
    data: { object: { id: "cus_1" } },
  } as unknown as import("stripe").default.Event;
}

const CARD_PM = {
  id: "pm_1",
  type: "card",
  customer: "cus_1",
  card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030, funding: "credit" },
  billing_details: {},
};

// A dynamic payment method with no `card` object (spec D16).
const LINK_PM = {
  id: "pm_link_1",
  type: "link",
  customer: "cus_1",
  billing_details: {},
};

function stripeHolderWith(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    client: {
      paymentMethods: { retrieve: vi.fn().mockResolvedValue(CARD_PM) },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          deleted: false,
          invoice_settings: { default_payment_method: null },
        }),
      },
      ...overrides,
    },
  };
}

describe("ReconcilePaymentMethodHandler", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("re-reads the PaymentMethod from Stripe and upserts the local row keyed on stripePaymentMethodId", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const db = dbWithPrimary({
      user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) },
      stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), upsert },
    });
    const stripeHolder = stripeHolderWith();
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()));

    expect(stripeHolder.client.paymentMethods.retrieve).toHaveBeenCalledWith(
      "pm_1",
      {},
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripePaymentMethodId: "pm_1" },
        create: expect.objectContaining({ stripePaymentMethodId: "pm_1", userId: "usr_1", isDefault: false }),
      }),
    );
    expect(upsert.mock.calls[0][0].create.id).toMatch(/^spm_/);
    await close();
  });

  it("processing the SAME attached event twice leaves the same state (idempotent)", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const db = dbWithPrimary({
      user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) },
      stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), upsert },
    });
    const { bus, close } = await buildBus(db, stripeHolderWith());

    await bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()));
    await bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()));

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0].where).toEqual(upsert.mock.calls[1][0].where);
    await close();
  });

  it("ignores an event for an unknown Stripe customer (ack, no throw, no write)", async () => {
    const upsert = vi.fn();
    const warnSpy = vi.spyOn(appLogger, "warn");
    const db = dbWithPrimary({
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      stripePaymentMethod: { findFirst: vi.fn(), upsert },
    });
    const { bus, close } = await buildBus(db, stripeHolderWith());

    await expect(bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()))).resolves.toBeUndefined();

    expect(upsert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "payment_method_reconciled", reason: "unknown_customer" }),
      expect.any(String),
    );
    await close();
  });

  it("never reassigns userId of a row owned by a different user (owner mismatch is ignored)", async () => {
    const upsert = vi.fn();
    const warnSpy = vi.spyOn(appLogger, "warn");
    const db = dbWithPrimary({
      user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) },
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", userId: "usr_OTHER" }),
        upsert,
      },
    });
    const { bus, close } = await buildBus(db, stripeHolderWith());

    await bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()));

    expect(upsert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "payment_method_reconciled", reason: "owner_mismatch" }),
      expect.any(String),
    );
    await close();
  });

  it("upserts a non-card payment method (type=link) with null card fields", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const db = dbWithPrimary({
      user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) },
      stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), upsert },
    });
    const stripeHolder = stripeHolderWith({
      paymentMethods: { retrieve: vi.fn().mockResolvedValue(LINK_PM) },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(attachedEvent({ id: "pm_link_1" })));

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "link",
          brand: null,
          last4: null,
          expMonth: null,
          expYear: null,
          funding: null,
        }),
      }),
    );
    await close();
  });

  it("out-of-order delivery — event says attached but Stripe's CURRENT state has customer=null — soft-deletes instead of re-creating", async () => {
    const del = vi.fn().mockResolvedValue({});
    const findFirst = vi.fn().mockResolvedValue({ id: "spm_1", userId: "usr_1" });
    const upsert = vi.fn();
    const db = dbWithPrimary({ stripePaymentMethod: { findFirst, delete: del, upsert } });
    const stripeHolder = stripeHolderWith({
      paymentMethods: { retrieve: vi.fn().mockResolvedValue({ ...CARD_PM, customer: null }) },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()));

    expect(upsert).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ where: { id: "spm_1" } });
    await close();
  });

  it("resource_missing on retrieve soft-deletes the local row if present, and acks (does not throw)", async () => {
    const del = vi.fn().mockResolvedValue({});
    const findFirst = vi.fn().mockResolvedValue({ id: "spm_1", userId: "usr_1" });
    const db = dbWithPrimary({ stripePaymentMethod: { findFirst, delete: del } });
    const missingError = new Stripe.errors.StripeInvalidRequestError({
      message: "No such PaymentMethod",
      code: "resource_missing",
    });
    const stripeHolder = stripeHolderWith({
      paymentMethods: { retrieve: vi.fn().mockRejectedValue(missingError) },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(bus.execute(new ReconcilePaymentMethodCommand(detachedEvent()))).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith({ where: { id: "spm_1" } });
    await close();
  });

  it("detach is idempotent: a second delivery for an already-deleted row is a no-op, not an error", async () => {
    const del = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = dbWithPrimary({ stripePaymentMethod: { findFirst, delete: del } });
    const stripeHolder = stripeHolderWith({
      paymentMethods: { retrieve: vi.fn().mockResolvedValue({ ...CARD_PM, customer: null }) },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(bus.execute(new ReconcilePaymentMethodCommand(detachedEvent()))).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
    await close();
  });

  it("a Stripe retrieve failure (non resource_missing) propagates so Stripe retries the delivery (never acked)", async () => {
    const apiError = new Stripe.errors.StripeAPIError({ message: "internal stripe error" });
    const db = dbWithPrimary({ stripePaymentMethod: { findFirst: vi.fn(), upsert: vi.fn() } });
    const stripeHolder = stripeHolderWith({
      paymentMethods: { retrieve: vi.fn().mockRejectedValue(apiError) },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(bus.execute(new ReconcilePaymentMethodCommand(attachedEvent()))).rejects.toBe(apiError);
    await close();
  });

  it("customer.updated: locks the user row, THEN retrieves Stripe's current state, THEN writes — in that order", async () => {
    const callOrder: string[] = [];
    const updateMany = vi.fn().mockImplementation(() => {
      callOrder.push("write");
      return Promise.resolve({});
    });
    const txFindFirst = vi.fn().mockResolvedValue(null);
    const queryRaw = vi.fn().mockImplementation(() => {
      callOrder.push("lock");
      return Promise.resolve([]);
    });
    const $transaction = vi.fn().mockImplementation((cb) =>
      cb({ $queryRaw: queryRaw, stripePaymentMethod: { updateMany, findFirst: txFindFirst } }),
    );
    const db = dbWithPrimary({ user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) }, $transaction });
    const retrieve = vi.fn().mockImplementation(() => {
      callOrder.push("retrieve");
      return Promise.resolve({
        id: "cus_1",
        deleted: false,
        invoice_settings: { default_payment_method: "pm_1" },
      });
    });
    const stripeHolder = stripeHolderWith({ customers: { retrieve } });
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(customerUpdatedEvent()));

    expect(callOrder[0]).toBe("lock");
    expect(callOrder[1]).toBe("retrieve");
    expect(callOrder.slice(2)).toEqual(["write", "write"]);
    expect(retrieve).toHaveBeenCalledWith("cus_1", {}, expect.objectContaining({ timeout: expect.any(Number) }));
    await close();
  });

  it("customer.updated sets isDefault from the CURRENT invoice_settings.default_payment_method, unsetting others", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    const txFindFirst = vi.fn().mockResolvedValue(null);
    const $transaction = vi.fn().mockImplementation((cb) =>
      cb({ $queryRaw: vi.fn(), stripePaymentMethod: { updateMany, findFirst: txFindFirst } }),
    );
    const db = dbWithPrimary({ user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) }, $transaction });
    const stripeHolder = stripeHolderWith({
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          deleted: false,
          invoice_settings: { default_payment_method: "pm_1" },
        }),
      },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(customerUpdatedEvent()));

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { userId: "usr_1", isDefault: true },
      data: { isDefault: false },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: "usr_1", stripePaymentMethodId: "pm_1" },
      data: { isDefault: true },
    });
    await close();
  });

  it("customer.updated with a default not stored locally unsets all local defaults and does not throw", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    const txFindFirst = vi.fn().mockResolvedValue({ id: "spm_old", stripePaymentMethodId: "pm_old" });
    const $transaction = vi.fn().mockImplementation((cb) =>
      cb({ $queryRaw: vi.fn(), stripePaymentMethod: { updateMany, findFirst: txFindFirst } }),
    );
    const db = dbWithPrimary({ user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) }, $transaction });
    const stripeHolder = stripeHolderWith({
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          deleted: false,
          invoice_settings: { default_payment_method: "pm_not_stored_locally" },
        }),
      },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(bus.execute(new ReconcilePaymentMethodCommand(customerUpdatedEvent()))).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { userId: "usr_1", isDefault: true },
      data: { isDefault: false },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: "usr_1", stripePaymentMethodId: "pm_not_stored_locally" },
      data: { isDefault: true },
    });
    await close();
  });

  it("customer.updated with a null default unsets all local defaults", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    const txFindFirst = vi.fn().mockResolvedValue({ id: "spm_old", stripePaymentMethodId: "pm_old" });
    const $transaction = vi.fn().mockImplementation((cb) =>
      cb({ $queryRaw: vi.fn(), stripePaymentMethod: { updateMany, findFirst: txFindFirst } }),
    );
    const db = dbWithPrimary({ user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) }, $transaction });
    const stripeHolder = stripeHolderWith();
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(customerUpdatedEvent()));

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: "usr_1", isDefault: true },
      data: { isDefault: false },
    });
    await close();
  });

  it("skips writes entirely when the local default already matches Stripe's current state", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    const txFindFirst = vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" });
    const $transaction = vi.fn().mockImplementation((cb) =>
      cb({ $queryRaw: vi.fn(), stripePaymentMethod: { updateMany, findFirst: txFindFirst } }),
    );
    const db = dbWithPrimary({ user: { findFirst: vi.fn().mockResolvedValue({ id: "usr_1" }) }, $transaction });
    const stripeHolder = stripeHolderWith({
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: "cus_1",
          deleted: false,
          invoice_settings: { default_payment_method: "pm_1" },
        }),
      },
    });
    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new ReconcilePaymentMethodCommand(customerUpdatedEvent()));

    expect(updateMany).not.toHaveBeenCalled();
    await close();
  });

  it("ignores customer.updated for an unknown customer (ack, no throw)", async () => {
    const $transaction = vi.fn();
    const db = dbWithPrimary({ user: { findFirst: vi.fn().mockResolvedValue(null) }, $transaction });
    const { bus, close } = await buildBus(db, stripeHolderWith());

    await expect(
      bus.execute(new ReconcilePaymentMethodCommand(customerUpdatedEvent())),
    ).resolves.toBeUndefined();
    expect($transaction).not.toHaveBeenCalled();
    await close();
  });

  it("throws StripeUnavailableException when the client is null", async () => {
    const { StripeUnavailableException } = await import(
      "../../src/shared/stripe/stripe-unavailable.exception.ts"
    );
    const db = dbWithPrimary();
    const { bus, close } = await buildBus(db, { enabled: true, client: null });

    await expect(
      bus.execute(new ReconcilePaymentMethodCommand(attachedEvent())),
    ).rejects.toBeInstanceOf(StripeUnavailableException);
    await close();
  });
});
