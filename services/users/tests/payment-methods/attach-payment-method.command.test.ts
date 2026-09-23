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

function dbWithUser(overrides: Record<string, unknown> = {}) {
  const user = {
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", email: "a@b.com", stripeCustomerId: "cus_1" }),
    updateMany: vi.fn(),
  };
  return {
    user,
    // ensureStripeCustomer reads via `$primary()` — see I1 in
    // [[2026-09-19-stripe-payments-design]].
    $primary: () => ({ user }),
    stripePaymentMethod: { upsert: vi.fn().mockResolvedValue({ stripePaymentMethodId: "pm_1" }) },
    ...overrides,
  };
}

describe("AttachPaymentMethodHandler", () => {
  beforeEach(() => testSpanExporter.reset());

  it("ensures the customer, attaches the payment method, and upserts the local row", async () => {
    const attach = vi.fn().mockResolvedValue(CARD_PM);
    const upsert = vi.fn().mockResolvedValue({ stripePaymentMethodId: "pm_1" });
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn(), update: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser({ stripePaymentMethod: { upsert } });

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
    const upsert = vi.fn();
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve } },
    };
    const db = dbWithUser({ stripePaymentMethod: { upsert } });

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
    const db = dbWithUser({ stripePaymentMethod: { upsert: vi.fn() } });

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
    const db = dbWithUser({ stripePaymentMethod: { upsert: vi.fn() } });

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
    const db = dbWithUser({ stripePaymentMethod: { upsert: vi.fn() } });

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
    const upsert = vi.fn().mockResolvedValue({ stripePaymentMethodId: "pm_link_1" });
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, paymentMethods: { attach, retrieve: vi.fn() } },
    };
    const db = dbWithUser({ stripePaymentMethod: { upsert } });

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
    const db = dbWithUser({ stripePaymentMethod: { upsert: vi.fn() } });

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
    const db = dbWithUser({ stripePaymentMethod: { upsert: vi.fn() } });

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
});
