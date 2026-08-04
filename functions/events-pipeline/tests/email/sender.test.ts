import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Unit-level cover for #email/sender's OWN behaviour. The handler tests mock
// this module, so without this file nothing exercises the code inside it —
// verified by mutation: flipping its TransientError to PermanentError left the
// entire suite green.
//
// What matters here is the CLASSIFICATION, which decides whether a failed send
// is retried through batchItemFailures or consumed and lost. It is asserted
// against a real failing send (an endpoint that refuses connections), not a
// stubbed SDK — the point is that whatever the SDK throws comes back out as
// TransientError.
beforeAll(() => {
  // env is Zod-validated at import time and demands the full set; these mirror
  // .env.local.events-pipeline. The endpoint deliberately points at a closed
  // port so every send fails fast at the transport layer.
  process.env.AWS_ENDPOINT_URL = "http://127.0.0.1:1";
  process.env.AWS_REGION ??= "us-east-1";
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  process.env.SES_FROM_ADDRESS ??= "no-reply@3mrai.local";
  process.env.DOCDB_HOST ??= "unused-by-this-suite";
  process.env.DOCDB_USERNAME ??= "unused";
  process.env.DOCDB_PASSWORD ??= "unused";
});

describe("sendEmail failure classification", () => {
  beforeEach(async () => {
    // The SES client is a module-scope singleton built lazily from env; reset
    // it so each case constructs one against the endpoint set above.
    const { resetSesClientForTests } = await import("#email/sender");
    resetSesClientForTests();
  });

  it("classifies an unreachable SES endpoint as TransientError, never PermanentError", async () => {
    const { sendEmail } = await import("#email/sender");
    const { TransientError, PermanentError } = await import("#pipeline/errors");

    const error = await sendEmail({
      to: "ada@example.com",
      subject: "Welcome to 3MRAI",
      html: "<p>hi</p>",
    }).catch((err: unknown) => err as Error);

    // Both assertions, deliberately: `instanceof TransientError` alone would
    // still pass if the classes were ever related by inheritance.
    expect(error).toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(PermanentError);
  }, 20000);

  it("is treated as retryable by isTransient (what puts the record in batchItemFailures)", async () => {
    const { sendEmail } = await import("#email/sender");
    const { isTransient } = await import("#pipeline/errors");

    const error = await sendEmail({
      to: "ada@example.com",
      subject: "Welcome to 3MRAI",
      html: "<p>hi</p>",
    }).catch((err: unknown) => err as Error);

    expect(isTransient(error)).toBe(true);
  }, 20000);

  // The error message is persisted on the FAILED event document and logged as
  // `reason` by src/handler.ts. A recipient address there is exactly the
  // plaintext-email leak docs/shared/conventions/logging-context.md forbids.
  it("does not leak the recipient address into the error message", async () => {
    const { sendEmail } = await import("#email/sender");

    const error = await sendEmail({
      to: "leaky-recipient@example.com",
      subject: "Welcome to 3MRAI",
      html: "<p>hi</p>",
    }).catch((err: unknown) => err as Error);

    expect(error.message).not.toContain("leaky-recipient@example.com");
    expect(error.message).not.toContain("leaky-recipient");
  }, 20000);
});
