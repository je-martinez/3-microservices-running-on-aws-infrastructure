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
const { StripeWebhookGate } = await import("../../src/payment-methods/webhooks/stripe-webhook-gate.ts");

const WEBHOOK_SECRET = "whsec_test_secret";
const URL_TOKEN = "tok_users_0123456789abcdef0123456789abcdef";
const WEBHOOK_URL = `/v1/users/stripe/webhook/${URL_TOKEN}`;
const STRIPE_IP = "3.18.12.63";

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

const BASE_CONFIG: Record<string, unknown> = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_WEBHOOK_URL_TOKEN: URL_TOKEN,
  STRIPE_WEBHOOK_ALLOWED_CIDRS: `${STRIPE_IP},10.0.0.0/8`,
  STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS: 0,
};

describe("StripeWebhookController", () => {
  let app: NestFastifyApplication;
  const commandBus = { execute: vi.fn(), register: vi.fn() };
  let stripeHolder: { enabled: boolean; client: Stripe | null };
  let config: Record<string, unknown> = { ...BASE_CONFIG };

  function post(opts: {
    url?: string;
    remoteAddress?: string;
    headers?: Record<string, string>;
    payload?: string;
  }) {
    return app.inject({
      method: "POST",
      url: opts.url ?? WEBHOOK_URL,
      remoteAddress: opts.remoteAddress ?? STRIPE_IP,
      headers: { "content-type": "application/json", ...opts.headers },
      payload: opts.payload ?? "{}",
    });
  }

  beforeAll(async () => {
    stripeHolder = { enabled: true, client: new Stripe("sk_test_123", { apiVersion: "2026-08-26.dahlia" }) };

    @Module({
      imports: [CqrsModule],
      controllers: [StripeWebhookController],
      providers: [
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
        { provide: AppConfigService, useValue: { get: (key: string) => config[key] } },
        StripeWebhookGate,
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
    config = { ...BASE_CONFIG };
  });

  describe("signature layer", () => {
    it("returns 400 and never dispatches a command when the signature is invalid", async () => {
      const { payload } = signedPayload(SAMPLE_EVENT);

      const response = await post({ headers: { "stripe-signature": "bad-signature" }, payload });

      expect(response.statusCode).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
      // The response body carries a fixed code, never the signature or Stripe's
      // own verification error message.
      expect(response.json()).toEqual({ error: "invalid_signature" });
      expect(response.body).not.toContain("bad-signature");
    });

    it("verifies a REAL signed payload via the real constructEvent and dispatches ReconcilePaymentMethodCommand", async () => {
      const { payload, signature } = signedPayload(SAMPLE_EVENT);

      const response = await post({ headers: { "stripe-signature": signature }, payload });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true });
      expect(commandBus.execute).toHaveBeenCalledTimes(1);
      const dispatched = commandBus.execute.mock.calls[0][0];
      expect(dispatched.event.id).toBe("evt_1");
      expect(dispatched.event.type).toBe("payment_method.attached");
    });

    it("does not dispatch a command for an event type outside the reconciled set", async () => {
      const { payload, signature } = signedPayload({ ...SAMPLE_EVENT, type: "charge.succeeded" });

      const response = await post({ headers: { "stripe-signature": signature }, payload });

      expect(response.statusCode).toBe(200);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it("logs stripe_webhook_received with reason=signature_verification_failed, never the signature or body", async () => {
      const warnSpy = vi.spyOn(appLogger, "warn");
      const { payload } = signedPayload(SAMPLE_EVENT);

      await post({ headers: { "stripe-signature": "bad-signature" }, payload });

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

      await post({ headers: { "stripe-signature": signature }, payload });

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

      const response = await post({ headers: { "stripe-signature": signature }, payload });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "stripe_unavailable" });
      expect(commandBus.execute).not.toHaveBeenCalled();
      stripeHolder.client = new Stripe("sk_test_123", { apiVersion: "2026-08-26.dahlia" });
    });
  });

  describe("source-IP allowlist layer", () => {
    it("answers 403 forbidden_source for a source outside the allowlist, even with a valid token and signature", async () => {
      const { payload, signature } = signedPayload(SAMPLE_EVENT);

      const response = await post({
        remoteAddress: "6.6.6.6",
        headers: { "stripe-signature": signature },
        payload,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden_source" });
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it("logs WARN stripe_webhook_received reason=source_ip_not_allowed with the source IP, never the token", async () => {
      const warnSpy = vi.spyOn(appLogger, "warn");

      await post({ remoteAddress: "6.6.6.6" });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          app_event: "stripe_webhook_received",
          reason: "source_ip_not_allowed",
          source_ip: "6.6.6.6",
        }),
        expect.any(String),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(URL_TOKEN);
      warnSpy.mockRestore();
    });

    it("accepts an IPv4-mapped IPv6 socket address that normalizes into the allowlist", async () => {
      const { payload, signature } = signedPayload(SAMPLE_EVENT);

      const response = await post({
        remoteAddress: `::ffff:${STRIPE_IP}`,
        headers: { "stripe-signature": signature },
        payload,
      });

      expect(response.statusCode).toBe(200);
    });

    it("ignores X-Forwarded-For when trusted hops = 0 (a spoofed header cannot pass)", async () => {
      const response = await post({ remoteAddress: "6.6.6.6", headers: { "x-forwarded-for": STRIPE_IP } });

      expect(response.statusCode).toBe(403);
    });

    it("reads the X-Forwarded-For entry `hops` from the right when hops > 0", async () => {
      config.STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS = 1;
      const { payload, signature } = signedPayload(SAMPLE_EVENT);

      const allowed = await post({
        remoteAddress: "172.31.0.2",
        headers: { "x-forwarded-for": `6.6.6.6, ${STRIPE_IP}`, "stripe-signature": signature },
        payload,
      });
      const spoofed = await post({
        remoteAddress: "172.31.0.2",
        headers: { "x-forwarded-for": `${STRIPE_IP}, 6.6.6.6` },
      });
      const missing = await post({ remoteAddress: "172.31.0.2" });

      expect(allowed.statusCode).toBe(200);
      expect(spoofed.statusCode).toBe(403);
      expect(missing.statusCode).toBe(403);
    });

    it("fails closed with 503 when the allowlist is unset", async () => {
      config.STRIPE_WEBHOOK_ALLOWED_CIDRS = undefined;

      const response = await post({});

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "stripe_unavailable" });
    });

    it("gates a percent-encoded path that Fastify routes to the same handler", async () => {
      const response = await post({
        url: `/v1/users/%73tripe/webhook/${URL_TOKEN}`,
        remoteAddress: "6.6.6.6",
      });

      expect(response.statusCode).toBe(403);
    });

    it("rejects the source BEFORE the body is parsed (malformed JSON still answers 403, not 400)", async () => {
      const response = await post({ remoteAddress: "6.6.6.6", payload: "{not json" });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("URL-token layer", () => {
    it.each([
      ["a wrong token", "/v1/users/stripe/webhook/tok_wrong"],
      ["a token one character short", WEBHOOK_URL.slice(0, -1)],
    ])("answers 404 with the unmapped-route body for %s", async (_label, url) => {
      const { payload, signature } = signedPayload(SAMPLE_EVENT);

      const response = await post({ url, headers: { "stripe-signature": signature }, payload });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        message: `Cannot POST ${url}`,
        error: "Not Found",
        statusCode: 404,
      });
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it.each(["/v1/users/stripe/webhook", "/v1/users/stripe/webhook/"])(
      "answers 404 for %s (no token segment)",
      async (url) => {
        const response = await post({ url });

        expect(response.statusCode).toBe(404);
      },
    );

    it("checks the IP BEFORE the token (a bad source with a wrong token is 403, not 404)", async () => {
      const response = await post({ url: "/v1/users/stripe/webhook/tok_wrong", remoteAddress: "6.6.6.6" });

      expect(response.statusCode).toBe(403);
    });

    it("checks the token BEFORE the body is parsed (malformed JSON with a wrong token is 404, not 400)", async () => {
      const response = await post({ url: "/v1/users/stripe/webhook/tok_wrong", payload: "{not json" });

      expect(response.statusCode).toBe(404);
    });

    it("checks the token BEFORE the signature (a bad signature with a wrong token is 404, not 400)", async () => {
      const response = await post({
        url: "/v1/users/stripe/webhook/tok_wrong",
        headers: { "stripe-signature": "bad-signature" },
      });

      expect(response.statusCode).toBe(404);
    });

    it.each([undefined, ""])("answers 503 when the token is unset (%j)", async (value) => {
      config.STRIPE_WEBHOOK_URL_TOKEN = value;

      const response = await post({});

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "stripe_unavailable" });
    });
  });
});
