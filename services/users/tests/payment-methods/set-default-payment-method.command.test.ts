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
  SetDefaultPaymentMethodCommand,
  SetDefaultPaymentMethodHandler,
  STRIPE_UPDATE_TIMEOUT_MS,
  TRANSACTION_TIMEOUT_MS,
} = await import("#payment-methods/commands/set-default-payment-method.command");

// A fake interactive transaction: runs the callback with a `tx` that reuses the
// same mock model clients as `db`, and records call ORDER across $queryRaw /
// customers.update / the two writes — the handler's lock-then-Stripe-then-flip
// contract. `vi.fn()` already records the SECOND arg (the `{ timeout }` options
// object) via its own `.mock.calls`, so the timeout assertions read that directly.
function fakeTransaction(db: { stripePaymentMethod: { updateMany: unknown; update: unknown } }, callOrder: string[]) {
  return vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
    const tx = {
      $queryRaw: vi.fn(async () => {
        callOrder.push("lock");
        return [];
      }),
      stripePaymentMethod: db.stripePaymentMethod,
    };
    return fn(tx);
  });
}

async function buildBus(db: unknown, stripeHolder: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      SetDefaultPaymentMethodHandler,
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
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "set_default_payment_method");
}

describe("SetDefaultPaymentMethodHandler", () => {
  beforeEach(() => testSpanExporter.reset());

  it("resolves to RoutineFailure.value ('not_found') for a payment method that does not belong to the caller, before any Stripe call", async () => {
    const update = vi.fn();
    const callOrder: string[] = [];
    const db = {
      stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), update: vi.fn() },
      user: { findUniqueOrThrow: vi.fn() },
      $transaction: fakeTransaction({ stripePaymentMethod: { updateMany: vi.fn(), update: vi.fn() } }, callOrder),
    };
    const stripeHolder = { enabled: true, client: { customers: { update } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    const result = await bus.execute(
      new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_other_user" }),
    );

    expect(result).toBe("not_found");
    expect(update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    await close();
  });

  it("resolves to RoutineFailure.value ('not_found') when the caller has no Stripe customer yet, before any Stripe call", async () => {
    const update = vi.fn();
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", stripeCustomerId: null }) },
      $transaction: vi.fn(),
    };
    const stripeHolder = { enabled: true, client: { customers: { update } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    const result = await bus.execute(
      new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }),
    );

    expect(result).toBe("not_found");
    expect(update).not.toHaveBeenCalled();
    await close();
  });

  it("keeps the workflow span reason=not_found matching the log, and never ERROR, for the routine miss", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn");
    const db = {
      stripePaymentMethod: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), update: vi.fn() },
      user: { findUniqueOrThrow: vi.fn() },
      $transaction: vi.fn(),
    };
    const stripeHolder = { enabled: true, client: { customers: { update: vi.fn() } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_x" }));

    const [fields] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("not_found");
    expect(workflowSpan()!.attributes.reason).toBe("not_found");
    expect(workflowSpan()!.status.code).not.toBe(SpanStatusCode.ERROR);
    warnSpy.mockRestore();
    await close();
  });

  it("locks the user row, calls Stripe, THEN flips isDefault — in that order, inside one interactive transaction", async () => {
    const update = vi.fn().mockResolvedValue({ id: "cus_1" });
    const callOrder: string[] = [];
    const updateMany = vi.fn(async () => {
      callOrder.push("unset_others");
      return { count: 1 };
    });
    const rowUpdate = vi.fn(async () => {
      callOrder.push("set_this");
      return {};
    });
    const stripeUpdateTracked = vi.fn(async (...args: unknown[]) => {
      callOrder.push("stripe_update");
      return update(...(args as [string, unknown]));
    });
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        updateMany,
        update: rowUpdate,
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", stripeCustomerId: "cus_1" }) },
      $transaction: fakeTransaction({ stripePaymentMethod: { updateMany, update: rowUpdate } }, callOrder),
    };
    const stripeHolder = { enabled: true, client: { customers: { update: stripeUpdateTracked } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    const result = await bus.execute(
      new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }),
    );

    expect(result).toBe("set_default");
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(stripeUpdateTracked).toHaveBeenCalledWith(
      "cus_1",
      { invoice_settings: { default_payment_method: "pm_1" } },
      { timeout: STRIPE_UPDATE_TIMEOUT_MS },
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: "usr_1", isDefault: true },
      data: { isDefault: false },
    });
    expect(rowUpdate).toHaveBeenCalledWith({ where: { id: "spm_1" }, data: { isDefault: true } });
    // Ordering: lock BEFORE the Stripe call, Stripe call BEFORE the flip.
    expect(callOrder).toEqual(["lock", "stripe_update", "unset_others", "set_this"]);

    const stripeSpan = testSpanExporter.getFinishedSpans().find((s) => s.name === "stripe.customer.update");
    expect(stripeSpan).toBeDefined();
    await close();
  });

  it("passes the transaction timeout to $transaction and a STRICTLY SMALLER timeout to the Stripe call", async () => {
    const update = vi.fn().mockResolvedValue({ id: "cus_1" });
    const callOrder: string[] = [];
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", stripeCustomerId: "cus_1" }) },
      $transaction: fakeTransaction({ stripePaymentMethod: { updateMany: vi.fn(), update: vi.fn() } }, callOrder),
    };
    const stripeHolder = { enabled: true, client: { customers: { update } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }));

    // $transaction's own timeout option (second arg to the callback form).
    const [, transactionOptions] = (db.$transaction as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      { timeout: number },
    ];
    expect(transactionOptions).toEqual({ timeout: TRANSACTION_TIMEOUT_MS });

    // The Stripe RequestOptions timeout (third arg to customers.update).
    const [, , stripeRequestOptions] = update.mock.calls[0] as [unknown, unknown, { timeout: number }];
    expect(stripeRequestOptions).toEqual({ timeout: STRIPE_UPDATE_TIMEOUT_MS });

    // The actual invariant: the Stripe call must fail before the transaction
    // can time out, never the other way around.
    expect(STRIPE_UPDATE_TIMEOUT_MS).toBeLessThan(TRANSACTION_TIMEOUT_MS);
    await close();
  });

  it("propagates a StripeInvalidRequestError AFTER ownership passed as an ordinary failure, NOT a 403 (Stripe-side drift, not bad input)", async () => {
    const err = new Stripe.errors.StripeInvalidRequestError({ message: "No such customer" });
    const update = vi.fn().mockRejectedValue(err);
    const callOrder: string[] = [];
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", stripeCustomerId: "cus_1" }) },
      $transaction: fakeTransaction({ stripePaymentMethod: { updateMany: vi.fn(), update: vi.fn() } }, callOrder),
    };
    const stripeHolder = { enabled: true, client: { customers: { update } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    const thrown = await bus
      .execute(new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }))
      .catch((e: unknown) => e);

    // The raw Stripe error propagates untouched — no ForbiddenException/403
    // wrapping. Ownership already passed, so this is Stripe-side drift.
    expect(thrown).toBe(err);
    expect((thrown as { statusCode?: number }).statusCode).not.toBe(403);
    await close();
  });

  it("logs reason=stripe_error (not stripe_invalid_request) for post-ownership Stripe drift, matching the workflow span", async () => {
    const errorSpy = vi.spyOn(appLogger, "error");
    const err = new Stripe.errors.StripeInvalidRequestError({ message: "No such customer" });
    const update = vi.fn().mockRejectedValue(err);
    const callOrder: string[] = [];
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", stripeCustomerId: "cus_1" }) },
      $transaction: fakeTransaction({ stripePaymentMethod: { updateMany: vi.fn(), update: vi.fn() } }, callOrder),
    };
    const stripeHolder = { enabled: true, client: { customers: { update } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus
      .execute(new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }))
      .catch(() => undefined);

    const [fields] = errorSpy.mock.calls[0] as [Record<string, unknown>];
    expect(fields.reason).toBe("stripe_error");
    expect(workflowSpan()!.attributes.reason).toBe("stripe_error");
    expect(workflowSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    errorSpy.mockRestore();
    await close();
  });

  it("throws StripeUnavailableException when the client is null", async () => {
    const { StripeUnavailableException } = await import(
      "../../src/shared/stripe/stripe-unavailable.exception.ts"
    );
    const db = {
      stripePaymentMethod: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      user: { findUniqueOrThrow: vi.fn() },
      $transaction: vi.fn(),
    };
    const stripeHolder = { enabled: true, client: null };

    const { bus, close } = await buildBus(db, stripeHolder);

    await expect(
      bus.execute(new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" })),
    ).rejects.toBeInstanceOf(StripeUnavailableException);
    await close();
  });

  it("logs app_event=payment_method_set_default on success", async () => {
    const infoSpy = vi.spyOn(appLogger, "info");
    const callOrder: string[] = [];
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue({ id: "spm_1", stripePaymentMethodId: "pm_1" }),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", stripeCustomerId: "cus_1" }) },
      $transaction: fakeTransaction({ stripePaymentMethod: { updateMany: vi.fn(), update: vi.fn() } }, callOrder),
    };
    const stripeHolder = { enabled: true, client: { customers: { update: vi.fn().mockResolvedValue({}) } } };

    const { bus, close } = await buildBus(db, stripeHolder);

    await bus.execute(new SetDefaultPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_1" }));

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "payment_method_set_default", user_id: "usr_1" }),
      expect.any(String),
    );
    infoSpy.mockRestore();
    await close();
  });
});
