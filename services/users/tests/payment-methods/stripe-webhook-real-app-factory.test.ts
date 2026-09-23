import "reflect-metadata";

// CONTRACT: Seed env, INCLUDING STRIPE_ENABLED=true, BEFORE any import of
// #config/config.module or main.ts — both are evaluated at import time
// (ConfigModule.forRoot parses env; app.module.ts's `@Module` reads
// process.env.STRIPE_ENABLED to decide whether to import PaymentMethodsModule).
// This boots through the REAL `createNestApp()` factory (main.ts) rather than
// a bespoke Test.createTestingModule wiring, so the assertions below prove the
// mount, `@Public()` under the global AuthGuard, `rawBody: true`, and Stripe
// signature verification all compose correctly together — not just each in
// isolation. See [[2026-09-19-stripe-payments-design]]
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
  STRIPE_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_real_factory_test",
  STRIPE_WEBHOOK_URL_TOKEN: "tok_real_factory_5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f",
  STRIPE_WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8",
  STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS: "0",
});

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { symbols } = await import("pino");
const Stripe = (await import("stripe")).default;
const { createNestApp } = await import("../../src/main.ts");
const { appLogger } = await import("#shared/logging/app-logger");

const WEBHOOK_SECRET = "whsec_real_factory_test";
const URL_TOKEN = "tok_real_factory_5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f";
const WEBHOOK_URL = `/v1/users/stripe/webhook/${URL_TOKEN}`;

// Signs fixtures only — never used as the app's own client, so the signature
// exercises the SAME verification path a real Stripe delivery would.
const signingStripe = new Stripe("sk_test_signing_only", { apiVersion: "2026-08-26.dahlia" });

function signedPayload(eventBody: object) {
  const payload = JSON.stringify(eventBody);
  const signature = signingStripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

describe("Stripe webhook through the real createNestApp() factory", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createNestApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts a real signed, non-reconciled event under the global AuthGuard with no x-user-id (mount + @Public + rawBody + signature all compose)", async () => {
    // "charge.succeeded" is deliberately NOT in RECONCILED_TYPES — this proves
    // the route accepts and acks an event type it does not act on, rather than
    // only ever exercising the reconciled path.
    const { payload, signature } = signedPayload({
      id: "evt_real_factory_1",
      object: "event",
      type: "charge.succeeded",
      data: { object: { id: "ch_1", object: "charge" } },
    });

    const response = await app.inject({
      method: "POST",
      url: WEBHOOK_URL,
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
  });

  it("still 401s a user-scoped payment-methods route with no x-user-id (the global AuthGuard is active, not bypassed wholesale)", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/users/me/payment-methods" });
    expect(response.statusCode).toBe(401);
  });

  it("answers a wrong token with exactly the body of a genuinely unmapped route", async () => {
    const wrongToken = await app.inject({ method: "POST", url: "/v1/users/stripe/webhook/tok_guess", payload: {} });
    const unmapped = await app.inject({ method: "POST", url: "/v1/users/stripe/hooks/tok_guess", payload: {} });

    expect(wrongToken.statusCode).toBe(404);
    expect(unmapped.statusCode).toBe(404);
    expect(wrongToken.json()).toEqual({
      ...unmapped.json(),
      message: unmapped.json().message.replace("/hooks/", "/webhook/"),
    });
  });

  it("no longer serves the bare /v1/users/stripe/webhook path", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/users/stripe/webhook", payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it("never writes the URL token to any log line, across accepted and rejected deliveries", async () => {
    const lines: string[] = [];
    const loggers = [appLogger, app.getHttpAdapter().getInstance().log] as unknown as Record<symbol, unknown>[];
    const originals = loggers.map((l) => l[symbols.streamSym]);
    for (const l of loggers) l[symbols.streamSym] = { write: (s: string) => lines.push(s) };

    try {
      const { payload, signature } = signedPayload({
        id: "evt_real_factory_2",
        object: "event",
        type: "charge.succeeded",
        data: { object: { id: "ch_2", object: "charge" } },
      });
      const headers = { "content-type": "application/json" };
      const accepted = await app.inject({
        method: "POST",
        url: WEBHOOK_URL,
        headers: { ...headers, "stripe-signature": signature },
        payload,
      });
      const badSignature = await app.inject({
        method: "POST",
        url: WEBHOOK_URL,
        headers: { ...headers, "stripe-signature": "bad" },
        payload,
      });
      const badSource = await app.inject({
        method: "POST",
        url: WEBHOOK_URL,
        remoteAddress: "6.6.6.6",
        headers,
        payload,
      });
      const badJson = await app.inject({ method: "POST", url: WEBHOOK_URL, headers, payload: "{not json" });

      expect([accepted, badSignature, badSource, badJson].map((r) => r.statusCode)).toEqual([200, 400, 403, 400]);
    } finally {
      loggers.forEach((l, i) => (l[symbols.streamSym] = originals[i]));
    }

    // Guards against a vacuous pass: the capture really saw the request lines.
    expect(lines.some((l) => l.includes("/v1/users/stripe/webhook"))).toBe(true);
    const leaking = lines.filter((l) => l.includes(URL_TOKEN));
    expect(leaking, leaking.join("\n")).toEqual([]);
  });
});
