import "reflect-metadata";

// CONTRACT: Seed env BEFORE any import of #config/config.module. ConfigModule.forRoot
// parses env at import time. See [[env-files]]
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
const { Test } = await import("@nestjs/testing");
const { CqrsModule, CommandBus } = await import("@nestjs/cqrs");
const { testSpanExporter } = await import("../setup.ts");
const { DB, STRIPE_CLIENT } = await import("#shared/tokens");
const { CreateSetupIntentCommand, CreateSetupIntentHandler } = await import(
  "#payment-methods/commands/create-setup-intent.command"
);

describe("CreateSetupIntentHandler", () => {
  beforeEach(() => testSpanExporter.reset());

  it("ensures the customer then creates a SetupIntent and returns its client_secret", async () => {
    const create = vi.fn().mockResolvedValue({ id: "seti_1", client_secret: "seti_123_secret_abc" });
    const stripeHolder = {
      enabled: true,
      client: {
        customers: { create: vi.fn().mockResolvedValue({ id: "cus_1" }) },
        setupIntents: { create },
      },
    };
    const user = {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", email: "a@b.com", stripeCustomerId: "cus_1" }),
      updateMany: vi.fn(),
    };
    const db = { user, $primary: () => ({ user }) };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        CreateSetupIntentHandler,
        { provide: DB, useValue: db },
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
      ],
    }).compile();
    await moduleRef.init();

    const commandBus = moduleRef.get(CommandBus);
    const result = await commandBus.execute(
      new CreateSetupIntentCommand({ userId: "usr_1", e2eSource: false }),
    );

    expect(result).toEqual({ clientSecret: "seti_123_secret_abc" });
    expect(create).toHaveBeenCalledWith({ customer: "cus_1" });
  });

  it("creates the Stripe customer with the user's cognito_sub in its metadata", async () => {
    const customersCreate = vi.fn().mockResolvedValue({ id: "cus_new" });
    const stripeHolder = {
      enabled: true,
      client: {
        customers: { create: customersCreate },
        setupIntents: { create: vi.fn().mockResolvedValue({ id: "seti_3", client_secret: "seti_3_secret" }) },
      },
    };
    const user = {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "usr_1",
        email: "a@b.com",
        cognitoSub: "sub-abc",
        stripeCustomerId: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const db = { user, $primary: () => ({ user }) };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        CreateSetupIntentHandler,
        { provide: DB, useValue: db },
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
      ],
    }).compile();
    await moduleRef.init();

    await moduleRef.get(CommandBus).execute(new CreateSetupIntentCommand({ userId: "usr_1", e2eSource: false }));

    expect(customersCreate).toHaveBeenCalledWith(
      { email: "a@b.com", metadata: { user_id: "usr_1", cognito_sub: "sub-abc" } },
      { idempotencyKey: "stripe-customer-create-usr_1" },
    );
  });

  it("does not call Stripe again when the user already has a stripeCustomerId", async () => {
    const create = vi.fn().mockResolvedValue({ id: "seti_2", client_secret: "seti_456_secret_xyz" });
    const customersCreate = vi.fn();
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: customersCreate }, setupIntents: { create } },
    };
    const user = {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", email: "a@b.com", stripeCustomerId: "cus_existing" }),
      updateMany: vi.fn(),
    };
    const db = { user, $primary: () => ({ user }) };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        CreateSetupIntentHandler,
        { provide: DB, useValue: db },
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
      ],
    }).compile();
    await moduleRef.init();

    const commandBus = moduleRef.get(CommandBus);
    await commandBus.execute(new CreateSetupIntentCommand({ userId: "usr_1", e2eSource: false }));

    expect(customersCreate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ customer: "cus_existing" });
  });

  it("throws StripeUnavailableException when the client is null", async () => {
    const { StripeUnavailableException } = await import(
      "../../src/shared/stripe/stripe-unavailable.exception.ts"
    );
    const db = { user: { findUniqueOrThrow: vi.fn() } };
    const stripeHolder = { enabled: true, client: null };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        CreateSetupIntentHandler,
        { provide: DB, useValue: db },
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
      ],
    }).compile();
    await moduleRef.init();

    const commandBus = moduleRef.get(CommandBus);
    await expect(
      commandBus.execute(new CreateSetupIntentCommand({ userId: "usr_1", e2eSource: false })),
    ).rejects.toBeInstanceOf(StripeUnavailableException);
  });

  it("exports a real stripe.setup_intent.create span and never carries the client_secret", async () => {
    const create = vi.fn().mockResolvedValue({ id: "seti_3", client_secret: "seti_secret_should_not_be_logged" });
    const stripeHolder = {
      enabled: true,
      client: { customers: { create: vi.fn() }, setupIntents: { create } },
    };
    const user = {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", email: "a@b.com", stripeCustomerId: "cus_1" }),
      updateMany: vi.fn(),
    };
    const db = { user, $primary: () => ({ user }) };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        CreateSetupIntentHandler,
        { provide: DB, useValue: db },
        { provide: STRIPE_CLIENT, useValue: stripeHolder },
      ],
    }).compile();
    await moduleRef.init();

    const commandBus = moduleRef.get(CommandBus);
    await commandBus.execute(new CreateSetupIntentCommand({ userId: "usr_1", e2eSource: false }));

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "stripe.setup_intent.create");
    expect(span).toBeDefined();
    expect(JSON.stringify(span!.attributes)).not.toContain("secret");
  });
});
