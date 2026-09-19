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
  E2E_TESTING_ENABLED: "true",
});

const { describe, expect, it, vi } = await import("vitest");
const { Module } = await import("@nestjs/common");
const { CommandBus, CqrsModule } = await import("@nestjs/cqrs");
const { Test } = await import("@nestjs/testing");
const { AppConfigService } = await import("#config/config.module");
const { SQS_CLIENT } = await import("#shared/messaging/messaging.module");
const { NotificationConsumerService } = await import(
  "../../src/notifications/messaging/notification-consumer.service.ts"
);
const { CreateNotificationCommand } = await import(
  "../../src/notifications/commands/create-notification.command.ts"
);

// Drives handleMessage directly: the point is the record-handling contract, not
// sqs-consumer's polling, which is the library's own tested behaviour.
async function build(execute = vi.fn().mockResolvedValue("created")) {
  const commandBus = { execute, register: vi.fn() };

  @Module({
    imports: [CqrsModule],
    providers: [
      NotificationConsumerService,
      {
        provide: AppConfigService,
        useValue: { get: (key: string) => (key === "NOTIFICATIONS_QUEUE_URL" ? process.env.NOTIFICATIONS_QUEUE_URL : undefined) },
      },
      { provide: SQS_CLIENT, useValue: {} },
    ],
  })
  class ConsumerTestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ConsumerTestModule] })
    .overrideProvider(CommandBus)
    .useValue(commandBus)
    .compile();

  const consumer = moduleRef.get(NotificationConsumerService);
  return {
    consumer,
    execute,
    close: () => moduleRef.close(),
  };
}

function sqsMessage(envelope: unknown, traceparent?: string) {
  return {
    MessageId: "msg-1",
    Body: JSON.stringify(envelope),
    ...(traceparent
      ? {
          MessageAttributes: {
            traceparent: { DataType: "String", StringValue: traceparent },
          },
        }
      : {}),
  };
}

const ENVELOPE = {
  event_id: "evt_1",
  type: "USER_CREATED",
  source: "users",
  user_id: "usr_alice",
  order_id: null,
  author: { actor: "users_api:register", user_id: "usr_alice" },
  payload: {
    email: "a@b.c",
    fullName: "A B",
    userId: "usr_alice",
    createdAt: "2026-09-10T10:00:00.000Z",
  },
};

describe("NotificationConsumerService acknowledgement", () => {
  // CONTRACT: sqs-consumer deletes a message only when the handler returns one
  // whose MessageId matches. A void return resolves to null, the delete never
  // happens, and the queue is redelivered forever while every log line still
  // reads "succeeded" — the drain silently makes no progress.
  it("returns the message so sqs-consumer deletes it", async () => {
    const { consumer, close } = await build();
    const message = sqsMessage(ENVELOPE);

    // The wiring the library actually calls, reached through the private field
    // rather than re-implementing it in the test.
    const handler = (
      consumer as unknown as { consumer: { handleMessage: (m: unknown) => Promise<unknown> } }
    ).consumer.handleMessage;

    await expect(handler(message)).resolves.toBe(message);
    await close();
  });

  it("rejects rather than acknowledging when the command fails", async () => {
    const { consumer, close } = await build(vi.fn().mockRejectedValue(new Error("database unreachable")));
    const handler = (
      consumer as unknown as { consumer: { handleMessage: (m: unknown) => Promise<unknown> } }
    ).consumer.handleMessage;

    await expect(handler(sqsMessage(ENVELOPE))).rejects.toThrow("database unreachable");
    await close();
  });
});

describe("NotificationConsumerService.handleMessage", () => {
  it("hands a valid envelope to the CommandBus as CreateNotificationCommand", async () => {
    const { consumer, execute, close } = await build();

    await consumer.handleMessage(sqsMessage(ENVELOPE) as never);

    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]![0];
    expect(command).toBeInstanceOf(CreateNotificationCommand);
    expect(command.envelope).toMatchObject({ type: "USER_CREATED", user_id: "usr_alice" });
    await close();
  });

  // CONTRACT: A permanent error must NOT throw — throwing keeps the message on the
  // queue until it reaches the DLQ, with no chance of ever succeeding.
  it("swallows a body that is not JSON", async () => {
    const { consumer, execute, close } = await build();

    await expect(
      consumer.handleMessage({ MessageId: "msg-2", Body: "not json at all" } as never),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    await close();
  });

  it("swallows an envelope missing its required fields", async () => {
    const { consumer, execute, close } = await build();

    await expect(
      consumer.handleMessage(sqsMessage({ type: "USER_CREATED" }) as never),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    await close();
  });

  it("swallows an empty body", async () => {
    const { consumer, execute, close } = await build();

    await expect(
      consumer.handleMessage({ MessageId: "msg-3" } as never).then(() => undefined),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    await close();
  });

  // CONTRACT: A TRANSIENT failure MUST throw, so the message becomes visible again
  // and is retried. Swallowing it would delete a message that could have succeeded.
  it("rethrows when the command fails unexpectedly", async () => {
    const { consumer, close } = await build(vi.fn().mockRejectedValue(new Error("database unreachable")));

    await expect(consumer.handleMessage(sqsMessage(ENVELOPE) as never)).rejects.toThrow(
      "database unreachable",
    );
    await close();
  });

  it("continues the trace from the traceparent attribute", async () => {
    const { consumer, execute, close } = await build();
    const traceId = "0af7651916cd43dd8448eb211c80319c";

    await consumer.handleMessage(
      sqsMessage(ENVELOPE, `00-${traceId}-b7ad6b7169203331-01`) as never,
    );

    // The command ran inside the extracted context, so the active span at the
    // call site belongs to the producer's trace rather than a fresh one.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(consumer.lastTraceId).toBe(traceId);
    await close();
  });
});

describe("NotificationConsumerService lifecycle", () => {
  // CONTRACT: Constructed by the module, STARTED from main.ts — never in a
  // constructor or onModuleInit. Compiling the module must leave the sqs-consumer
  // stopped; otherwise every Test.createTestingModule would long-poll and DELETE
  // real messages. See [[2026-09-10-in-app-notifications-design]]
  it("does NOT start polling when the module compiles", async () => {
    @Module({
      imports: [CqrsModule],
      providers: [
        NotificationConsumerService,
        {
          provide: AppConfigService,
          useValue: {
            get: (key: string) =>
              key === "NOTIFICATIONS_QUEUE_URL" ? process.env.NOTIFICATIONS_QUEUE_URL : undefined,
          },
        },
        { provide: SQS_CLIENT, useValue: {} },
      ],
    })
    class LifecycleTestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [LifecycleTestModule] })
      .overrideProvider(CommandBus)
      .useValue({ execute: vi.fn(), register: vi.fn() })
      .compile();
    await moduleRef.init();

    const service = moduleRef.get(NotificationConsumerService);
    // sqs-consumer exposes status.isRunning (see consumer.d.ts) — not a bare
    // isRunning on the Consumer instance.
    const inner = (service as unknown as { consumer: { status: { isRunning: boolean } } }).consumer;
    expect(inner.status.isRunning).toBe(false);

    await moduleRef.close();
  });
});
