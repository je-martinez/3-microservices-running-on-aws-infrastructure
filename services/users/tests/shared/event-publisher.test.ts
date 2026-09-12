import { describe, it, expect } from "vitest";
import { PublishCommand } from "@aws-sdk/client-sns";
import { NoopEventPublisher, SnsEventPublisher } from "#shared/messaging/event-publisher";

const TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic";

// Records what was published without reaching a transport. Typed as the narrow
// shape the publisher actually uses, so the fake cannot drift from the real client.
function recordingClient() {
  const sent: PublishCommand[] = [];
  return {
    sent,
    client: {
      send: async (command: PublishCommand) => {
        sent.push(command);
        return {};
      },
    } as never,
  };
}

describe("SnsEventPublisher", () => {
  it("publishes USER_CREATED to the topic with the envelope and attributes intact", async () => {
    const { sent, client } = recordingClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await publisher.publishUserCreated({
      id: "usr_a",
      email: "a@b.c",
      fullName: "A B",
      createdAt: new Date("2026-01-15T10:30:00.000Z"),
      cognitoSub: "sub-123",
    });

    expect(sent).toHaveLength(1);
    const input = sent[0]!.input;

    // TopicArn replaces QueueUrl; Message replaces MessageBody.
    expect(input.TopicArn).toBe(TOPIC_ARN);
    expect((input as Record<string, unknown>).QueueUrl).toBeUndefined();

    // CONTRACT: The envelope is preserved byte-for-byte across the transport
    // change. Asserting the parsed OBJECT (not a substring) is what catches a
    // dropped or renamed key.
    const envelope = JSON.parse(input.Message as string);
    expect(envelope).toMatchObject({
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_a",
      order_id: null,
      author: { actor: "users_api:register", user_id: "usr_a", cognito_sub: "sub-123" },
      payload: {
        email: "a@b.c",
        fullName: "A B",
        userId: "usr_a",
        createdAt: "2026-01-15T10:30:00.000Z",
      },
    });
    expect(envelope.event_id).toMatch(/^evt_/);

    // CONTRACT: `request_id` is OMITTED outside a request, never null — the
    // pipeline declares it .optional().min(1), so a null is a PermanentError.
    expect("request_id" in envelope).toBe(false);

    expect(input.MessageAttributes).toMatchObject({
      type: { DataType: "String", StringValue: "USER_CREATED" },
      source: { DataType: "String", StringValue: "users" },
    });
  });

  it("omits author.cognito_sub when the caller has none", async () => {
    const { sent, client } = recordingClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await publisher.publishUserCreated({
      id: "usr_b",
      email: "b@c.d",
      fullName: "B C",
      createdAt: new Date("2026-01-15T10:30:00.000Z"),
    });

    const envelope = JSON.parse(sent[0]!.input.Message as string);
    expect("cognito_sub" in envelope.author).toBe(false);
  });

  it("publishes PASSWORD_RESET_REQUESTED without leaking the code into attributes", async () => {
    const { sent, client } = recordingClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await publisher.publishPasswordResetRequested({
      userId: "usr_c",
      email: "c@d.e",
      fullName: "C D",
      code: "042817",
      ttlSeconds: 600,
    });

    const input = sent[0]!.input;
    const envelope = JSON.parse(input.Message as string);
    expect(envelope.type).toBe("PASSWORD_RESET_REQUESTED");
    expect(envelope.payload).toMatchObject({
      email: "c@d.e",
      full_name: "C D",
      code: "042817",
      ttlSeconds: 600,
    });
    // WARNING: the code is a live credential — it rides the body only.
    expect(JSON.stringify(input.MessageAttributes)).not.toContain("042817");
  });

  it("swallows a publish failure rather than failing the caller", async () => {
    const failing = {
      send: async () => {
        throw new Error("topic unreachable");
      },
    } as never;
    const publisher = new SnsEventPublisher(failing, TOPIC_ARN);

    // The user row and Cognito account already exist, so a throw here would
    // report an error for a registration that succeeded.
    await expect(
      publisher.publishUserCreated({
        id: "usr_d",
        email: "d@e.f",
        fullName: "D E",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("NoopEventPublisher", () => {
  it("resolves without throwing", async () => {
    const pub = new NoopEventPublisher();
    await expect(
      pub.publishUserCreated({
        id: "usr_a",
        email: "a@b.c",
        fullName: "A B",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });
});
