import { describe, it, expect, vi } from "vitest";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SqsEventPublisher } from "#shared/messaging/event-publisher";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";

const QUEUE_URL = "http://localhost:4566/000000000000/events";

// A hand-rolled double instead of vi.mock("@aws-sdk/client-sqs"): the real
// SendMessageCommand must stay real so the assertions below inspect the command
// the publisher actually built, not a stub of our own making.
function fakeClient(send = vi.fn(async () => ({ MessageId: "m1" }))) {
  return { send } as unknown as SQSClient & { send: ReturnType<typeof vi.fn> };
}

function sentCommand(client: ReturnType<typeof fakeClient>): SendMessageCommand {
  return client.send.mock.calls[0]![0] as SendMessageCommand;
}

const PAYLOAD = {
  id: "usr_1",
  email: "a@example.com",
  fullName: "Ada Lovelace",
  cognitoSub: "a1b2-c3d4",
};

describe("SqsEventPublisher", () => {
  it("sends exactly one SendMessageCommand to the configured queue URL", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    expect(client.send).toHaveBeenCalledOnce();
    const command = sentCommand(client);
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input.QueueUrl).toBe(QUEUE_URL);
  });

  it("sets type and source as SQS message attributes so the queue is inspectable without deserializing", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const attributes = sentCommand(client).input.MessageAttributes!;
    expect(attributes.type).toEqual({ DataType: "String", StringValue: "USER_CREATED" });
    expect(attributes.source).toEqual({ DataType: "String", StringValue: "users" });
  });

  it("builds the snake_case envelope the pipeline validates, with order_id present and null", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(body.type).toBe("USER_CREATED");
    expect(body.source).toBe("users");
    expect(body.user_id).toBe("usr_1");
    // The pipeline's EnvelopeSchema declares order_id nullable, NOT optional —
    // a missing key is rejected, so the key must be present and null.
    expect(Object.keys(body)).toContain("order_id");
    expect(body.order_id).toBeNull();
  });

  it("carries the fullName and email the USER_CREATED handler's payload schema requires", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(body.payload).toEqual({ email: "a@example.com", fullName: "Ada Lovelace" });
  });

  it("stamps the author block naming WHO originated the event, not just who it is about", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The whole object, so a stray extra key fails here rather than reaching
    // the consumer. `actor` is the same semantic AuditActor value the audit
    // columns carry for this write path.
    expect(body.author).toEqual({
      actor: "users_api:register",
      user_id: "usr_1",
      cognito_sub: "a1b2-c3d4",
    });
  });

  it("does not duplicate the producing service inside author — the root source owns it", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // AuthorSchema has no `source`. Two copies of a per-publisher constant
    // carry no information and can only drift; the root one stays.
    expect(body.author).not.toHaveProperty("source");
    expect(body.source).toBe("users");
  });

  it("OMITS cognito_sub from the serialized author when the caller supplied none", async () => {
    const client = fakeClient();
    const { cognitoSub: _omitted, ...withoutSub } = PAYLOAD;
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(withoutSub);

    // Read back off the SERIALIZED body, not the object: the rule is about the
    // JSON on the wire. `"cognito_sub": null` would satisfy a `?.toBeFalsy()`
    // assertion and violate the contract, so the key's ABSENCE is what is
    // pinned.
    const raw = sentCommand(client).input.MessageBody!;
    const body = JSON.parse(raw);
    expect(Object.keys(body.author)).toEqual(["actor", "user_id"]);
    expect(raw).not.toContain("cognito_sub");
  });

  it("keeps the author's user_id as the real id, never the actor label", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The subject and the author coincide on a self-registration; the point is
    // that `author.user_id` is an id, not the `users_api:register` label — a
    // consumer joining on it must get a joinable value.
    expect(body.author.user_id).toBe(body.user_id);
    expect(body.author.user_id).not.toContain(":");
  });

  it("does not leak the user's id into the payload the pipeline emails from", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(body.payload).not.toHaveProperty("id");
  });

  it("generates the event_id itself, prefixed evt_, so the caller's signature stays unchanged", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(body.event_id).toMatch(/^evt_.+/);
  });

  it("generates a distinct event_id per publish (it is the pipeline's idempotency key)", async () => {
    const client = fakeClient();
    const publisher = new SqsEventPublisher(client, QUEUE_URL);
    await publisher.publishUserCreated(PAYLOAD);
    await publisher.publishUserCreated(PAYLOAD);

    const first = JSON.parse((client.send.mock.calls[0]![0] as SendMessageCommand).input.MessageBody!);
    const second = JSON.parse((client.send.mock.calls[1]![0] as SendMessageCommand).input.MessageBody!);
    expect(first.event_id).not.toBe(second.event_id);
  });

  it("swallows a send failure so a queue outage cannot fail an otherwise successful registration", async () => {
    const client = fakeClient(
      vi.fn(async () => {
        throw new Error("queue unreachable");
      }),
    );

    await expect(new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD)).resolves.toBeUndefined();
  });

  it("reports the swallowed failure as an alertable *_failed error log", async () => {
    const { fields, message } = await captureFailureLog();

    expect(fields.app_event).toBe("user_created_publish_failed");
    expect(fields.user_id).toBe("usr_1");
    expect(message).toBeTruthy();
  });

  it("never puts the plaintext email in the failure log line — only its hash", async () => {
    const { fields, message } = await captureFailureLog();

    // Serialize everything the log call carries (the `err` included) and scan
    // it: the address must not appear anywhere in the emitted line.
    const emitted = JSON.stringify(fields) + message;
    expect(emitted).not.toContain("a@example.com");
    expect(fields.email).toBeUndefined();
    expect(fields.email_hash).toBe(hashEmail("a@example.com"));
  });
});

// Drives a real publish against a failing client and returns what the publisher
// actually handed the logger. The logger is spied on rather than injected —
// `appLogger` is a module singleton by design (no logger is threaded through
// constructors in this service).
async function captureFailureLog(): Promise<{ fields: Record<string, any>; message: string }> {
  const client = fakeClient(
    vi.fn(async () => {
      throw new Error("queue unreachable");
    }),
  );
  const calls: Array<[Record<string, any>, string]> = [];
  const spy = vi.spyOn(appLogger, "error").mockImplementation(((fields: any, message: any) => {
    calls.push([fields, message]);
  }) as never);

  try {
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);
  } finally {
    // mockRestore() clears the spy's own call history in vitest 2, so the calls
    // are captured into `calls` above rather than read back off the spy.
    spy.mockRestore();
  }

  expect(calls).toHaveLength(1);
  const [fields, message] = calls[0]!;
  return { fields, message };
}
