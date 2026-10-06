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
const { APP_INTERCEPTOR } = await import("@nestjs/core");
const { CqrsModule, CommandBus } = await import("@nestjs/cqrs");
const Stripe = (await import("stripe")).default;
const { SpanStatusCode } = await import("@opentelemetry/api");
const { testSpanExporter } = await import("../setup.ts");
const { appLogger } = await import("#shared/logging/app-logger");
const { WorkflowInterceptor } = await import("#shared/observability/workflow.interceptor");
const { DB, STRIPE_CLIENT } = await import("#shared/tokens");
const { STRIPE_TIMEOUT_MS, TRANSACTION_TIMEOUT_MS } = await import("#shared/stripe/stripe-tx-lock");
const {
  AttachPaymentMethodCommand,
  AttachPaymentMethodHandler,
  PaymentMethodRejectedException,
  PaymentMethodDeclinedException,
} = await import("#payment-methods/commands/attach-payment-method.command");

const CARD_PM = {
  id: "pm_1",
  type: "card",
  customer: "cus_1",
  card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, funding: "credit", country: "US", fingerprint: "fp1" },
  billing_details: { name: "Ada", email: "ada@example.com", address: { line1: "1 Main St" } },
};

// A dynamic payment method with no `card` object (spec D16) — Link, bank
// debits, etc. never carry brand/last4/exp fields.
const LINK_PM = {
  id: "pm_link_1",
  type: "link",
  customer: "cus_1",
  billing_details: { name: "Ada", email: "ada@example.com", address: null },
};

// Default fixture: the caller already has another active card, so attach
// leaves isDefault false and never touches the Stripe customer.
const OTHER_ACTIVE_CARD: FakeRow[] = [
  { stripePaymentMethodId: "pm_other", userId: "usr_1", isDefault: true, deletedAt: null },
];

async function buildBus(db: unknown, stripeHolder: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      AttachPaymentMethodHandler,
      { provide: DB, useValue: db },
      { provide: STRIPE_CLIENT, useValue: stripeHolder },
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), close: () => moduleRef.close() };
}

function workflowSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "attach_payment_method");
}

function stripeSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "stripe.payment_method.attach");
}

interface FakeRow {
  stripePaymentMethodId: string;
  userId: string;
  isDefault: boolean;
  deletedAt: Date | null;
}

type CountWhere = { userId: string; deletedAt: null; NOT: { stripePaymentMethodId: string } };

// An in-memory stripe_payment_methods table plus a fake interactive
// transaction whose `$queryRaw` (the FOR UPDATE lock) is a real per-user mutex
// held until the callback settles — so two concurrent attaches for one user
// serialize exactly as Postgres would serialize them, and a count taken
// outside the lock is observably wrong. `callOrder` records lock/count/upsert.
function fakeTable(initial: FakeRow[] = [], callOrder: string[] = []) {
  const rows = [...initial];
  const locks = new Map<string, Promise<void>>();

  const count = vi.fn(async ({ where }: { where: CountWhere }) => {
    callOrder.push("count");
    return rows.filter(
      (r) =>
        r.userId === where.userId &&
        r.deletedAt === null &&
        r.stripePaymentMethodId !== where.NOT.stripePaymentMethodId,
    ).length;
  });
  const upsert = vi.fn(
    async (args: {
      where: { stripePaymentMethodId: string };
      create: Record<string, unknown> & { stripePaymentMethodId: string; userId: string; isDefault: boolean };
      update: Record<string, unknown> & { isDefault?: boolean };
    }) => {
      callOrder.push("upsert");
      const existing = rows.find((r) => r.stripePaymentMethodId === args.where.stripePaymentMethodId);
      if (existing) {
        if (args.update.isDefault !== undefined) existing.isDefault = args.update.isDefault;
        return existing;
      }
      const created = { ...args.create, deletedAt: null };
      rows.push(created);
      return created;
    },
  );

  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
    let release: () => void = () => undefined;
    let heldKey: string | null = null;
    const tx = {
      $queryRaw: vi.fn(async (query: { values: unknown[] }) => {
        callOrder.push("lock");
        const key = String(query.values[0]);
        const previous = locks.get(key) ?? Promise.resolve();
        const mine = new Promise<void>((resolve) => (release = resolve));
        locks.set(key, previous.then(() => mine));
        heldKey = key;
        await previous;
        return [];
      }),
      stripePaymentMethod: { count, upsert },
    };
    try {
      return await fn(tx);
    } finally {
      if (heldKey) release();
    }
  });

  return { rows, count, upsert, $transaction };
}

function transactionCalls(table: ReturnType<typeof fakeTable>) {
  return table.$transaction.mock.calls.length;
}

function dbWithUser(overrides: Record<string, unknown> = {}, table = fakeTable(OTHER_ACTIVE_CARD)) {
  const user = {
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", email: "a@b.com", stripeCustomerId: "cus_1" }),
    updateMany: vi.fn(),
  };
  return {
    user,
    // ensureStripeCustomer reads via `$primary()` — see I1 in
    // [[2026-09-19-stripe-payments-design]].
    $primary: () => ({ user }),
    $transaction: table.$transaction,
    stripePaymentMethod: { upsert: table.upsert, count: table.count },
    ...overrides,
  };
}

describe("AttachPaymentMethodHandler", () => {
  beforeEach(() => testSpanExporter.reset());

  it("ensures the customer, attaches the payment method, and upserts the local row", async () => {
    const attach = vi.fn().mockResolvedValue(CARD_PM);
    const table = fakeTable(OTHER_ACTIVE_CARD);
    const upsert = table.upsert;
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn(), update: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser({}, table);

    const { bus, close } = await buildBus(db, stripeHolder);

    const result = await bus.execute(
      new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }),
    );

    expect(attach).toHaveBeenCalledWith("pm_1", { customer: "cus_1" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripePaymentMethodId: "pm_1" },
        create: expect.objectContaining({ stripePaymentMethodId: "pm_1", userId: "usr_1", isDefault: false }),
      }),
    );
    // `id` has no DB default, so the generated create-input type requires one
    // even under upsert; it must be a freshly-minted spm_ id, never Stripe's pm_.
    expect(upsert.mock.calls[0][0].create.id).toMatch(/^spm_/);
    expect(result).toEqual({ id: "pm_1" });
    expect(stripeHolder.client.customers.update).not.toHaveBeenCalled();

    expect(stripeSpan()!.attributes["stripe.payment_method_id"]).toBe("pm_1");
    expect(workflowSpan()!.attributes.app_event).toBe("attach_payment_method_succeeded");
    expect(workflowSpan()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("retrieves and accepts a PM already attached to the SAME customer via a SetupIntent confirmation", async () => {
    const alreadyAttachedError = new Stripe.errors.StripeInvalidRequestError({
      message: "The payment method has already been attached to a customer.",
    });
    const attach = vi.fn().mockRejectedValue(alreadyAttachedError);
    const retrieve = vi.fn().mockResolvedValue(CARD_PM); // customer === cus_1
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    const result = await bus.execute(
      new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }),
    );

    expect(retrieve).toHaveBeenCalledWith("pm_1");
    expect(result).toEqual({ id: "pm_1" });
    await close();
  });

  it("rejects a payment method already attached to a DIFFERENT customer with 403 payment_method_rejected (no existence oracle)", async () => {
    const alreadyAttachedError = new Stripe.errors.StripeInvalidRequestError({
      message: "The payment method has already been attached to a customer.",
    });
    const attach = vi.fn().mockRejectedValue(alreadyAttachedError);
    const retrieve = vi.fn().mockResolvedValue({ ...CARD_PM, customer: "cus_other" });
    const table = fakeTable(OTHER_ACTIVE_CARD);
    const upsert = table.upsert;
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve } },
    };
    const db = dbWithUser({}, table);

    const { bus, close } = await buildBus(db, stripeHolder);

    const err = await bus
      .execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaymentMethodRejectedException);
    expect((err as InstanceType<typeof PaymentMethodRejectedException>).getStatus()).toBe(403);
    expect((err as InstanceType<typeof PaymentMethodRejectedException>).getResponse()).toEqual({
      error: "payment_method_rejected",
    });
    expect(upsert).not.toHaveBeenCalled();
    await close();
  });

  it("maps a resource_missing StripeInvalidRequestError to the SAME 403 payment_method_rejected as the ownership case (no existence oracle)", async () => {
    const notFoundError = new Stripe.errors.StripeInvalidRequestError({
      message: "No such PaymentMethod: 'pm_bogus'",
      code: "resource_missing",
    });
    const attach = vi.fn().mockRejectedValue(notFoundError);
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn().mockRejectedValue(notFoundError) } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    const err = await bus
      .execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_bogus", e2eSource: false }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaymentMethodRejectedException);
    expect((err as InstanceType<typeof PaymentMethodRejectedException>).getStatus()).toBe(403);
    expect((err as InstanceType<typeof PaymentMethodRejectedException>).getResponse()).toEqual({
      error: "payment_method_rejected",
    });
    await close();
  });

  it("maps a StripeCardError (decline) to 402 payment_method_declined, distinct from the ownership 403", async () => {
    const declineError = new Stripe.errors.StripeCardError({ message: "Your card was declined." });
    const attach = vi.fn().mockRejectedValue(declineError);
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    const err = await bus
      .execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaymentMethodDeclinedException);
    expect((err as InstanceType<typeof PaymentMethodDeclinedException>).getStatus()).toBe(402);
    expect((err as InstanceType<typeof PaymentMethodDeclinedException>).getResponse()).toEqual({
      error: "payment_method_declined",
    });
    await close();
  });

  it("propagates a non-InvalidRequest, non-Card Stripe error untouched (never forced into a 4xx)", async () => {
    const apiError = new Stripe.errors.StripeAPIError({ message: "internal stripe error" });
    const attach = vi.fn().mockRejectedValue(apiError);
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(
      bus.execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false })),
    ).rejects.toBe(apiError);
    await close();
  });

  it("throws StripeUnavailableException when the client is null", async () => {
    const { StripeUnavailableException } = await import(
      "../../src/shared/stripe/stripe-unavailable.exception.ts"
    );
    const db = dbWithUser();
    const stripeHolder = { enabled: true, client: null };

    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(
      bus.execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false })),
    ).rejects.toBeInstanceOf(StripeUnavailableException);
    await close();
  });

  it("logs app_event=payment_method_attached on success", async () => {
    const infoSpy = vi.spyOn(appLogger, "info");
    const attach = vi.fn().mockResolvedValue(CARD_PM);
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(
      new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }),
    );

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "payment_method_attached", user_id: "usr_1" }),
      expect.any(String),
    );
    infoSpy.mockRestore();
    await close();
  });

  it("attaches a non-card payment method (type=link) and upserts nulls for every card field", async () => {
    const attach = vi.fn().mockResolvedValue(LINK_PM);
    const table = fakeTable(OTHER_ACTIVE_CARD);
    const upsert = table.upsert;
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser({}, table);

    const { bus, close } = await buildBus(db, stripeHolder);

    const result = await bus.execute(
      new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_link_1", e2eSource: false }),
    );

    expect(result).toEqual({ id: "pm_link_1" });
    expect(upsert.mock.calls[0][0].create).toEqual(
      expect.objectContaining({
        type: "link",
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
        funding: null,
      }),
    );
    await close();
  });

  it("keeps reason=stripe_invalid_request on the WORKFLOW span, matching the log line (regression guard: the interceptor's generic catch would otherwise stamp reason=unhandled_error)", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn");
    const rejectedError = new Stripe.errors.StripeInvalidRequestError({ message: "No such PaymentMethod" });
    const attach = vi.fn().mockRejectedValue(rejectedError);
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn().mockRejectedValue(rejectedError) } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus
      .execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }))
      .catch(() => undefined);

    const [fields] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("stripe_invalid_request");
    // CONTRACT regression guard: WorkflowInterceptor's generic catch stamps
    // reason=unhandled_error UNLESS the handler already stamped the active span
    // — this must NOT be unhandled_error.
    expect(workflowSpan()!.attributes.reason).toBe(fields.reason);
    expect(workflowSpan()!.attributes.app_event).toBe("attach_payment_method_failed");
    warnSpy.mockRestore();
    await close();
  });

  it("keeps reason=stripe_card_declined on the WORKFLOW span for a decline, matching the log line", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn");
    const declineError = new Stripe.errors.StripeCardError({ message: "Your card was declined." });
    const attach = vi.fn().mockRejectedValue(declineError);
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser();

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus
      .execute(new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false }))
      .catch(() => undefined);

    const [fields] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("stripe_card_declined");
    expect(workflowSpan()!.attributes.reason).toBe("stripe_card_declined");
    warnSpy.mockRestore();
    await close();
  });

  describe("first active payment method becomes the default", () => {
    function stripeWith(pm: typeof CARD_PM, update = vi.fn().mockResolvedValue({ id: "cus_1" })) {
      const attach = vi.fn(async (id: string) => ({ ...pm, id }));
      return {
        update,
        holder: {
          enabled: true,
          client: { customers: { create: vi.fn(), update }, paymentMethods: { attach, retrieve: vi.fn() } },
        },
      };
    }

    function attachPm(paymentMethodId = "pm_1") {
      return new AttachPaymentMethodCommand({ userId: "usr_1", paymentMethodId, e2eSource: false });
    }

    it("sets the Stripe customer default and creates the row with isDefault=true when the caller has no other card", async () => {
      const callOrder: string[] = [];
      const table = fakeTable([], callOrder);
      const { update, holder } = stripeWith(CARD_PM);
      update.mockImplementation(async () => {
        callOrder.push("stripe_update");
        return { id: "cus_1" };
      });
      const db = dbWithUser({}, table);
      const { bus, close } = await buildBus(db, holder);

      await bus.execute(attachPm());

      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith(
        "cus_1",
        { invoice_settings: { default_payment_method: "pm_1" } },
        { timeout: STRIPE_TIMEOUT_MS },
      );
      expect(table.upsert.mock.calls[0][0].create.isDefault).toBe(true);
      expect(table.rows).toEqual([expect.objectContaining({ stripePaymentMethodId: "pm_1", isDefault: true })]);
      expect(db.$transaction).toHaveBeenCalledOnce();
      expect((db.$transaction as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
        timeout: TRANSACTION_TIMEOUT_MS,
      });
      expect(STRIPE_TIMEOUT_MS).toBeLessThan(TRANSACTION_TIMEOUT_MS);
      // The count runs after the lock, inside the same transaction.
      expect(callOrder).toEqual(["lock", "count", "stripe_update", "upsert"]);
      expect(
        testSpanExporter.getFinishedSpans().find((s) => s.name === "stripe.customer.update"),
      ).toBeDefined();
      await close();
    });

    it("counts only the caller's active cards other than the one being attached", async () => {
      const table = fakeTable([]);
      const { holder } = stripeWith(CARD_PM);
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      await bus.execute(attachPm());

      expect(table.count).toHaveBeenCalledWith({
        where: { userId: "usr_1", deletedAt: null, NOT: { stripePaymentMethodId: "pm_1" } },
      });
      await close();
    });

    it("leaves isDefault=false and never touches the Stripe customer when another active card exists", async () => {
      const table = fakeTable([
        { stripePaymentMethodId: "pm_other", userId: "usr_1", isDefault: true, deletedAt: null },
      ]);
      const { update, holder } = stripeWith(CARD_PM);
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      await bus.execute(attachPm());

      expect(update).not.toHaveBeenCalled();
      expect(table.upsert.mock.calls[0][0].create.isDefault).toBe(false);
      expect(table.upsert.mock.calls[0][0].update).not.toHaveProperty("isDefault");
      expect(table.rows.find((r) => r.stripePaymentMethodId === "pm_1")!.isDefault).toBe(false);
      await close();
    });

    it("treats a soft-deleted other card as absent — the new card still becomes the default", async () => {
      const table = fakeTable([
        { stripePaymentMethodId: "pm_old", userId: "usr_1", isDefault: true, deletedAt: new Date() },
      ]);
      const { update, holder } = stripeWith(CARD_PM);
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      await bus.execute(attachPm());

      expect(update).toHaveBeenCalledWith(
        "cus_1",
        { invoice_settings: { default_payment_method: "pm_1" } },
        { timeout: STRIPE_TIMEOUT_MS },
      );
      expect(table.rows.find((r) => r.stripePaymentMethodId === "pm_1")!.isDefault).toBe(true);
      await close();
    });

    it("ignores another user's active card", async () => {
      const table = fakeTable([
        { stripePaymentMethodId: "pm_theirs", userId: "usr_2", isDefault: true, deletedAt: null },
      ]);
      const { update, holder } = stripeWith(CARD_PM);
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      await bus.execute(attachPm());

      expect(update).toHaveBeenCalledOnce();
      expect(table.rows.find((r) => r.stripePaymentMethodId === "pm_1")!.isDefault).toBe(true);
      await close();
    });

    it("promotes a row the payment_method.attached webhook already wrote (isDefault=false) when it is the only card", async () => {
      const table = fakeTable([
        { stripePaymentMethodId: "pm_1", userId: "usr_1", isDefault: false, deletedAt: null },
      ]);
      const { update, holder } = stripeWith(CARD_PM);
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      await bus.execute(attachPm());

      expect(update).toHaveBeenCalledOnce();
      expect(table.upsert.mock.calls[0][0].update).toEqual(expect.objectContaining({ isDefault: true }));
      expect(table.rows).toEqual([expect.objectContaining({ stripePaymentMethodId: "pm_1", isDefault: true })]);
      await close();
    });

    it("serializes two concurrent first-card attaches for one user — exactly one becomes the default", async () => {
      const table = fakeTable([]);
      // Hold the first Stripe update open so the second attach reaches its
      // lock while the first transaction is still inside it.
      let releaseFirst: () => void = () => undefined;
      const update = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise((resolve) => (releaseFirst = () => resolve({ id: "cus_1" }))),
        )
        .mockResolvedValue({ id: "cus_1" });
      const { holder } = stripeWith(CARD_PM, update);
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      const first = bus.execute(attachPm("pm_1"));
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      const second = bus.execute(attachPm("pm_2"));
      await vi.waitFor(() => expect(transactionCalls(table)).toBe(2));
      // The second attach is parked on the lock: it has not counted yet.
      expect(table.count).toHaveBeenCalledOnce();
      releaseFirst();
      await Promise.all([first, second]);

      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.calls[0][1]).toEqual({ invoice_settings: { default_payment_method: "pm_1" } });
      expect(table.rows.filter((r) => r.isDefault).map((r) => r.stripePaymentMethodId)).toEqual(["pm_1"]);
      expect(table.rows.find((r) => r.stripePaymentMethodId === "pm_2")!.isDefault).toBe(false);
      await close();
    });

    it("logs reason=stripe_error and propagates when the Stripe customer update fails, writing no row", async () => {
      const errorSpy = vi.spyOn(appLogger, "error");
      const apiError = new Stripe.errors.StripeAPIError({ message: "internal stripe error" });
      const table = fakeTable([]);
      const { holder } = stripeWith(CARD_PM, vi.fn().mockRejectedValue(apiError));
      const { bus, close } = await buildBus(dbWithUser({}, table), holder);

      await expect(bus.execute(attachPm())).rejects.toBe(apiError);

      expect(table.upsert).not.toHaveBeenCalled();
      expect(table.rows).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          app_event: "attach_payment_method_failed",
          reason: "stripe_error",
          user_id: "usr_1",
        }),
        expect.any(String),
      );
      expect(workflowSpan()!.attributes.reason).toBe("stripe_error");
      expect(workflowSpan()!.attributes.app_event).toBe("attach_payment_method_failed");
      errorSpy.mockRestore();
      await close();
    });
  });
});
