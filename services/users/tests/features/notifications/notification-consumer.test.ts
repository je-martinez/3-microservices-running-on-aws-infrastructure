import { describe, it, expect, vi } from "vitest";
import { NotificationConsumer } from "#features/notifications/messaging/notification-consumer";
import { parseEnv } from "#shared/config/env";

const env = parseEnv({ ...process.env });

// Drives handleMessage directly: the point is the record-handling contract, not
// sqs-consumer's polling, which is the library's own tested behaviour.
function build(execute = vi.fn().mockResolvedValue("created")) {
  const consumer = new NotificationConsumer({
    sqsClient: {} as never,
    env,
    createNotificationCommand: { execute } as never,
  });
  return { consumer, execute };
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
  payload: { email: "a@b.c", fullName: "A B", userId: "usr_alice", createdAt: "2026-09-10T10:00:00.000Z" },
};

describe("NotificationConsumer acknowledgement", () => {
  // CONTRACT: sqs-consumer deletes a message only when the handler returns one
  // whose MessageId matches. A void return resolves to null, the delete never
  // happens, and the queue is redelivered forever while every log line still
  // reads "succeeded" — the drain silently makes no progress.
  it("returns the message so sqs-consumer deletes it", async () => {
    const { consumer } = build();
    const message = sqsMessage(ENVELOPE);

    // The wiring the library actually calls, reached through the private field
    // rather than re-implementing it in the test.
    const handler = (consumer as unknown as { consumer: { handleMessage: (m: unknown) => Promise<unknown> } })
      .consumer.handleMessage;

    await expect(handler(message)).resolves.toBe(message);
  });

  it("rejects rather than acknowledging when the command fails", async () => {
    const { consumer } = build(vi.fn().mockRejectedValue(new Error("database unreachable")));
    const handler = (consumer as unknown as { consumer: { handleMessage: (m: unknown) => Promise<unknown> } })
      .consumer.handleMessage;

    await expect(handler(sqsMessage(ENVELOPE))).rejects.toThrow("database unreachable");
  });
});

describe("NotificationConsumer.handleMessage", () => {
  it("hands a valid envelope to the command", async () => {
    const { consumer, execute } = build();

    await consumer.handleMessage(sqsMessage(ENVELOPE) as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ type: "USER_CREATED", user_id: "usr_alice" });
  });

  // CONTRACT: A permanent error must NOT throw — throwing keeps the message on the
  // queue until it reaches the DLQ, with no chance of ever succeeding.
  it("swallows a body that is not JSON", async () => {
    const { consumer, execute } = build();

    await expect(
      consumer.handleMessage({ MessageId: "msg-2", Body: "not json at all" } as never),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("swallows an envelope missing its required fields", async () => {
    const { consumer, execute } = build();

    await expect(
      consumer.handleMessage(sqsMessage({ type: "USER_CREATED" }) as never),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("swallows an empty body", async () => {
    const { consumer, execute } = build();

    await expect(consumer.handleMessage({ MessageId: "msg-3" } as never).then(() => undefined))
      .resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // CONTRACT: A TRANSIENT failure MUST throw, so the message becomes visible again
  // and is retried. Swallowing it would delete a message that could have succeeded.
  it("rethrows when the command fails unexpectedly", async () => {
    const { consumer } = build(vi.fn().mockRejectedValue(new Error("database unreachable")));

    await expect(consumer.handleMessage(sqsMessage(ENVELOPE) as never)).rejects.toThrow(
      "database unreachable",
    );
  });

  it("continues the trace from the traceparent attribute", async () => {
    const { consumer, execute } = build();
    const traceId = "0af7651916cd43dd8448eb211c80319c";

    await consumer.handleMessage(
      sqsMessage(ENVELOPE, `00-${traceId}-b7ad6b7169203331-01`) as never,
    );

    // The command ran inside the extracted context, so the active span at the
    // call site belongs to the producer's trace rather than a fresh one.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(consumer.lastTraceId).toBe(traceId);
  });
});
