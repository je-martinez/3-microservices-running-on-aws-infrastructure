import { describe, it, expect, vi, beforeEach } from "vitest";

// #shared/config/env parses process.env at MODULE LOAD (ADR-0014), so the schema
// must be satisfied before the module under test is imported.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");
vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");
vi.stubEnv("EVENTS_DLQ_URL", "http://sqs.test/000000000000/events-dlq");

// The SQS client is the process boundary, and the only thing mocked here.
const send = vi.fn(async () => ({}));
vi.mock("@aws-sdk/client-sqs", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-sqs")>("@aws-sdk/client-sqs");
  return {
    ...actual,
    SQSClient: class {
      send = send;
    },
  };
});

const { quarantine } = await import("#pipeline/quarantine");

describe("quarantine", () => {
  beforeEach(() => {
    send.mockClear();
    send.mockImplementation(async () => ({}));
  });

  /**
   * CONTRACT: The ORIGINAL body, byte for byte. An operator redriving this
   * message needs exactly what the producer sent — a body re-wrapped in an
   * envelope of our own would be rejected by the consumer on the way back.
   */
  it("sends the raw body to the DLQ, unmodified", async () => {
    const body = '{"not":"an envelope","trailing":[1,2,3]}';

    const landed = await quarantine({ body, messageId: "msg-1", reason: "invalid_envelope" });

    expect(landed).toBe(true);
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.MessageBody).toBe(body);
    expect(input.QueueUrl).toBe("http://sqs.test/000000000000/events-dlq");
  });

  /** The reason rides as an ATTRIBUTE so the DLQ is triageable without parsing bodies. */
  it("tags the message with why it was refused", async () => {
    await quarantine({ body: "{}", messageId: "msg-2", reason: "persist_failed" });

    const input = (send.mock.calls[0][0] as { input: Record<string, any> }).input;
    expect(input.MessageAttributes.quarantine_reason.StringValue).toBe("persist_failed");
    expect(input.MessageAttributes.original_message_id.StringValue).toBe("msg-2");
  });

  /**
   * CONTRACT: The whole point of the module. A DLQ that throws must NOT turn a
   * message we already decided to drop into a retry — that resurrects the exact
   * loop the ACK exists to prevent. This is the assertion that would fail if
   * someone "improved" quarantine by rethrowing.
   */
  it("never throws when the DLQ send fails", async () => {
    send.mockImplementation(async () => {
      throw new Error("sqs is down");
    });

    await expect(
      quarantine({ body: "{}", messageId: "msg-3", reason: "invalid_envelope" }),
    ).resolves.toBe(false);
  });

  /**
   * An environment without the variable is opting out of the copy, not
   * misconfigured: the ACK is still correct, so this degrades rather than
   * throwing at the call site.
   */
  it("degrades when no DLQ is configured", async () => {
    // UNSET, not "" — the schema validates this as a URL, so an empty string is
    // a config error rather than an absence and would fail at module load.
    vi.stubEnv("EVENTS_DLQ_URL", undefined);
    vi.resetModules();
    const fresh = await import("#pipeline/quarantine");

    const landed = await fresh.quarantine({
      body: "{}",
      messageId: "msg-4",
      reason: "invalid_envelope",
    });

    expect(landed).toBe(false);
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv("EVENTS_DLQ_URL", "http://sqs.test/000000000000/events-dlq");
    vi.resetModules();
  });
});
