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

const { describe, expect, it, vi } = await import("vitest");
const { Test } = await import("@nestjs/testing");
const { CqrsModule, QueryBus } = await import("@nestjs/cqrs");
const { DB } = await import("#shared/tokens");
const { ListPaymentMethodsQuery, ListPaymentMethodsHandler } = await import(
  "#payment-methods/queries/list-payment-methods.query"
);

describe("ListPaymentMethodsHandler", () => {
  it("reads only the local table, never Stripe, and maps rows to the view shape", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        stripePaymentMethodId: "pm_1",
        type: "card",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
      },
      {
        stripePaymentMethodId: "pm_2",
        type: "card",
        brand: "mastercard",
        last4: "4444",
        expMonth: 1,
        expYear: 2029,
        isDefault: false,
      },
      {
        stripePaymentMethodId: "pm_link_1",
        type: "link",
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
        isDefault: false,
      },
    ]);
    const db = { stripePaymentMethod: { findMany } };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [ListPaymentMethodsHandler, { provide: DB, useValue: db }],
    }).compile();
    await moduleRef.init();

    const queryBus = moduleRef.get(QueryBus);
    const result = await queryBus.execute(new ListPaymentMethodsQuery("usr_1"));

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "usr_1", deletedAt: null },
      orderBy: { isDefault: "desc" },
    });
    expect(result).toEqual([
      { id: "pm_1", type: "card", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030, isDefault: true },
      { id: "pm_2", type: "card", brand: "mastercard", last4: "4444", expMonth: 1, expYear: 2029, isDefault: false },
      {
        id: "pm_link_1",
        type: "link",
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
        isDefault: false,
      },
    ]);
  });

  it("returns an empty list when the user has no payment methods", async () => {
    const db = { stripePaymentMethod: { findMany: vi.fn().mockResolvedValue([]) } };

    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [ListPaymentMethodsHandler, { provide: DB, useValue: db }],
    }).compile();
    await moduleRef.init();

    const queryBus = moduleRef.get(QueryBus);
    const result = await queryBus.execute(new ListPaymentMethodsQuery("usr_1"));
    expect(result).toEqual([]);
  });
});
