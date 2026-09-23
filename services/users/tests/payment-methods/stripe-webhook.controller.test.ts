import "reflect-metadata";

// CONTRACT: Seed env BEFORE any import of #config/config.module — the
// controller imports AppConfigService, and ConfigModule.forRoot parses env at
// import time. See [[env-files]]
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

const { afterAll, beforeAll, beforeEach, describe, expect, it, vi } = await import("vitest");
const { Module } = await import("@nestjs/common");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { CommandBus, CqrsModule } = await import("@nestjs/cqrs");
const Stripe = (await import("stripe")).default;
const { appLogger } = await import("#shared/logging/app-logger");
const { AppConfigService } = await import("#config/config.module");
const { STRIPE_CLIENT } = await import("#shared/tokens");
const { StripeWebhookController } = await import(
  "../../src/payment-methods/webhooks/stripe-webhook.controller.ts"
);

const WEBHOOK_SECRET = "whsec_test_secret";

// A real Stripe instance, used ONLY to sign fixtures and to run the real
// constructEvent verification — never mocked, so the raw-body wiring is
// proven end to end rather than assumed.
const signingStripe = new Stripe("sk_test_signing_only", { apiVersion: "2026-08-26.dahlia" });

function signedPayload(eventBody: object) {
  const payload = JSON.stringify(eventBody);
  const signature = signingStripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

const SAMPLE_EVENT = {
  id: "evt_1",
  object: "event",
  type: "payment_method.attached",
  data: { object: { id: "pm_1", object: "payment_method", customer: "cus_1" } },
};

describe("StripeWebhookController", () => {
  let app: NestFastifyApplication;
  const commandBus = { execute: vi.fn(), register: vi.fn() };
  let stripeHolder: { enabled: boolean; client: Stripe | null };

  beforeAll(async () => {
    stripeHolder = { enabled: true, client: new Stripe("sk_test_123", { apiVersion: "2026-08-26.dahlia" }) };

    @Module({
      imports: [CqrsModule],
      controllers: [StripeWebhookController],
      providers: [
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
        {
          provide: AppConfigService,
          useValue: { get: (key: string) => (key === "STRIPE_WEBHOOK_SECRET" ? WEBHOOK_SECRET : undefined) },
        },
      ],
    })
    class TestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestModule] })
      .overrideProvider(CommandBus)
      .useValue(commandBus)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
      rawBody: true,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    commandBus.execute.mockReset();
  });

  it("returns 400 and never dispatches a command when the signature is invalid", async () => {
    const { payload } = signedPayload(SAMPLE_EVENT);

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "bad-signature" },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(commandBus.execute).not.toHaveBeenCalled();
    // The response body carries a fixed code, never the signature or Stripe's
    // own verification error message.
    expect(response.json()).toEqual({ error: "invalid_signature" });
    expect(response.body).not.toContain("bad-signature");
  });

  it("verifies a REAL signed payload via the real constructEvent and dispatches ReconcilePaymentMethodCommand", async () => {
    const { payload, signature } = signedPayload(SAMPLE_EVENT);

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    const dispatched = commandBus.execute.mock.calls[0][0];
    expect(dispatched.event.id).toBe("evt_1");
    expect(dispatched.event.type).toBe("payment_method.attached");
  });

  it("does not dispatch a command for an event type outside the reconciled set", async () => {
    const body = { ...SAMPLE_EVENT, type: "charge.succeeded" };
    const { payload, signature } = signedPayload(body);

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it("logs stripe_webhook_received with reason=signature_verification_failed, never the signature or body", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn");
    const { payload } = signedPayload(SAMPLE_EVENT);

    await app.inject({
      method: "POST",
      url: "/v1/users/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "bad-signature" },
      payload,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "stripe_webhook_received", reason: "signature_verification_failed" }),
      expect.any(String),
    );
    const loggedPayload = JSON.stringify(warnSpy.mock.calls[0]);
    expect(loggedPayload).not.toContain("bad-signature");
    expect(loggedPayload).not.toContain("pm_1");
    warnSpy.mockRestore();
  });

  it("logs stripe_webhook_received INFO with event type + id on a valid signature", async () => {
    const infoSpy = vi.spyOn(appLogger, "info");
    const { payload, signature } = signedPayload(SAMPLE_EVENT);

    await app.inject({
      method: "POST",
      url: "/v1/users/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        app_event: "stripe_webhook_received",
        event_type: "payment_method.attached",
        event_id: "evt_1",
      }),
      expect.any(String),
    );
    infoSpy.mockRestore();
  });

  it("answers 503 when the Stripe client is unavailable, before touching the body", async () => {
    stripeHolder.client = null;
    const { payload, signature } = signedPayload(SAMPLE_EVENT);

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "stripe_unavailable" });
    expect(commandBus.execute).not.toHaveBeenCalled();
    stripeHolder.client = new Stripe("sk_test_123", { apiVersion: "2026-08-26.dahlia" });
  });
});
