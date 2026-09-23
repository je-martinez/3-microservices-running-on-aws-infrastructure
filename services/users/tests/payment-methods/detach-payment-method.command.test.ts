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
const { DetachPaymentMethodCommand, DetachPaymentMethodHandler } = await import(
  "#payment-methods/commands/detach-payment-method.command"
);

async function buildBus(db: unknown, stripeHolder: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      DetachPaymentMethodHandler,
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
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "detach_payment_method");
}

describe("DetachPaymentMethodHandler", () => {
  beforeEach(() => testSpanExporter.reset());

  it("resolves to RoutineFailure.value ('not_found') for a payment method that does not belong to the caller, before any Stripe call", async () => {
    const detach = vi.fn();
    const db = { stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), delete: vi.fn() } };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    // CONTRACT: WorkflowInterceptor unwraps RoutineFailure to its `.value`
    // before returning from bus.execute (mirrors DeleteAccountHandler) — the
    // controller distinguishes this from "detached" the same way deleteMe
    // does: `if (result !== "detached") throw new NotFoundException(...)`.
    const result = await bus.execute(
      new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_other_user" }),
    );

    expect(result).toBe("not_found");
    expect(detach).not.toHaveBeenCalled();
    await close();
  });

  it("keeps the workflow span OK (not ERROR) for the routine not-found outcome, with reason=not_found on both span and log", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn");
    const db = { stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), delete: vi.fn() } };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach: vi.fn() } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_x" }));

    const [fields] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("not_found");
    expect(workflowSpan()!.attributes.reason).toBe("not_found");
    expect(workflowSpan()!.attributes.app_event).toBe("detach_payment_method_failed");
    // CONTRACT: RoutineFailure leaves span status UNSET, never ERROR — a 404 a
    // caller can act on is not a fault. See RoutineFailure's class comment.
    expect(workflowSpan()!.status.code).not.toBe(SpanStatusCode.ERROR);
    warnSpy.mockRestore();
    await close();
  });

  it("detaches from Stripe and soft-deletes the local row when owned by the caller", async () => {
    const detach = vi.fn().mockResolvedValue({ id: "pm_1" });
    const deleteFn = vi.fn().mockResolvedValue({});
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        delete: deleteFn,
      },
    };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }));

    expect(detach).toHaveBeenCalledWith("pm_1");
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "spm_1" } });

    const stripeSpan = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "stripe.payment_method.detach");
    expect(stripeSpan).toBeDefined();
    expect(stripeSpan!.attributes["stripe.payment_method_id"]).toBe("pm_1");
    await close();
  });

  it("propagates a StripeInvalidRequestError that is NOT resource_missing, rather than treating it as already-detached", async () => {
    const otherInvalidRequestError = new Stripe.errors.StripeInvalidRequestError({
      message: "Something else is wrong with this request",
      code: "parameter_invalid_empty",
    });
    const detach = vi.fn().mockRejectedValue(otherInvalidRequestError);
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        delete: vi.fn(),
      },
    };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(
      bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" })),
    ).rejects.toBe(otherInvalidRequestError);
    expect(db.stripePaymentMethod.delete).not.toHaveBeenCalled();
    await close();
  });

  it("reconciles idempotently when Stripe reports the PM already detached (resource_missing) AFTER ownership passed, not a 4xx", async () => {
    const alreadyDetachedError = new Stripe.errors.StripeInvalidRequestError({
      message: "No such PaymentMethod: 'pm_1'",
      code: "resource_missing",
    });
    const detach = vi.fn().mockRejectedValue(alreadyDetachedError);
    const deleteFn = vi.fn().mockResolvedValue({});
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        delete: deleteFn,
      },
    };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    // Idempotent success — must NOT throw, must NOT be a 4xx.
    await expect(
      bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" })),
    ).resolves.toBe("detached");
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "spm_1" } });
    await close();
  });

  it("propagates a non-InvalidRequest Stripe error untouched (never forced into a 4xx)", async () => {
    const apiError = new Stripe.errors.StripeAPIError({ message: "internal stripe error" });
    const detach = vi.fn().mockRejectedValue(apiError);
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        delete: vi.fn(),
      },
    };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(
      bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" })),
    ).rejects.toBe(apiError);
    expect(db.stripePaymentMethod.delete).not.toHaveBeenCalled();
    await close();
  });

  it("throws StripeUnavailableException when the client is null", async () => {
    const { StripeUnavailableException } = await import(
      "../../src/shared/stripe/stripe-unavailable.exception.ts"
    );
    const db = { stripePaymentMethod: { findFirst: vi.fn(), delete: vi.fn() } };
    const stripeHolder = { enabled: true, client: null };

    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(
      bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" })),
    ).rejects.toBeInstanceOf(StripeUnavailableException);
    await close();
  });

  it("logs app_event=payment_method_detached on success", async () => {
    const infoSpy = vi.spyOn(appLogger, "info");
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    const stripeHolder = { enabled: true, client: { paymentMethods: { detach: vi.fn().mockResolvedValue({}) } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }));

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "payment_method_detached", user_id: "usr_1" }),
      expect.any(String),
    );
    infoSpy.mockRestore();
    await close();
  });
});
