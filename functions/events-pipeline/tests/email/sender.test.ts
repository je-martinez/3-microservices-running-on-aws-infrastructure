import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { hashEmail } from "#shared/logging/email-hash";

// #email/sender logs both outcomes of a send, and the recipient is the one piece
// of PII this module unavoidably holds. Redirecting the logger into an array is
// what lets the assertions below read the SERIALIZED line — the exact bytes
// CloudWatch would receive — rather than trusting the call site. The real
// `buildLoggerOptions` is kept so the production formatter is the one under test.
const { rawLines } = vi.hoisted(() => ({ rawLines: [] as string[] }));

vi.mock("#shared/logging/app-logger", async () => {
  const { buildLoggerOptions } =
    await vi.importActual<typeof import("#shared/logging/logger")>("#shared/logging/logger");
  const { default: pinoActual } = await vi.importActual<typeof import("pino")>("pino");
  return {
    appLogger: pinoActual(
      { ...buildLoggerOptions({ serviceName: "events-pipeline", environment: "test" }), level: "debug" },
      { write: (s: string) => rawLines.push(s) },
    ),
  };
});

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
  // Required since the templates moved to remote images. Unused by this suite:
  // it asserts transport-layer failure classification and never renders a
  // template, so any schema-valid URL does.
  process.env.ASSETS_BASE_URL ??= "http://assets.test/bucket";
});

describe("sendEmail failure classification", () => {
  beforeEach(async () => {
    // The SES client is a module-scope singleton built lazily from env; reset
    // it so each case constructs one against the endpoint set above.
    const { resetSesClientForTests } = await import("#email/sender");
    resetSesClientForTests();
    rawLines.length = 0;
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

describe("sendEmail logging — the recipient reaches the log only as a hash", () => {
  beforeEach(async () => {
    const { resetSesClientForTests } = await import("#email/sender");
    resetSesClientForTests();
    rawLines.length = 0;
  });

  // The real leak path: `sendEmail` receives the plaintext address as `params.to`
  // and holds it for the whole call, so any line spreading `params` — or putting
  // `to` in for "debuggability" — would put a real recipient into CloudWatch.
  // The address here is one that could ONLY have come from that parameter.
  it("logs email_hash and never the plaintext address on a failed send", async () => {
    const { sendEmail } = await import("#email/sender");

    await sendEmail({
      to: "leaky-recipient@example.com",
      subject: "Welcome to 3MRAI",
      html: "<p>hi</p>",
    }).catch(() => {});

    const serialized = rawLines.join("\n");
    expect(serialized).not.toContain("leaky-recipient@example.com");
    expect(serialized).not.toContain("leaky-recipient");

    // Not merely absent: the hash IS there, so an operator can still trace every
    // failed send to one recipient. A sanitization that logged nothing would
    // pass the assertions above while destroying the diagnostic.
    const failed = rawLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.app_event === "email_send_failed");
    expect(failed?.email_hash).toBe(hashEmail("leaky-recipient@example.com"));
    expect(failed?.severity_text).toBe("ERROR");
    expect(failed?.reason).toBeDefined();
    expect(typeof failed?.duration_ms).toBe("number");
  });

  it("hashes the recipient the same way regardless of case or whitespace", async () => {
    const { sendEmail } = await import("#email/sender");

    await sendEmail({
      to: "  Leaky-Recipient@Example.COM  ",
      subject: "Welcome to 3MRAI",
      html: "<p>hi</p>",
    }).catch(() => {});

    // Normalization happens inside hashEmail, so the same person correlates
    // across services however the producer happened to spell the address.
    const failed = rawLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.app_event === "email_send_failed");
    expect(failed?.email_hash).toBe(hashEmail("leaky-recipient@example.com"));
  });

  it("does not log a SUCCESS severity — a sent email is INFO plus app_event", async () => {
    // Only the failing path is reachable here (the endpoint refuses
    // connections), so this asserts the invariant across whatever was emitted:
    // no line may claim a severity outside the OTel set.
    const { sendEmail } = await import("#email/sender");

    await sendEmail({ to: "ada@example.com", subject: "s", html: "<p>hi</p>" }).catch(() => {});

    for (const raw of rawLines) {
      const line = JSON.parse(raw) as Record<string, unknown>;
      expect(line.severity_text).not.toBe("SUCCESS");
      expect([5, 9, 13, 17]).toContain(line.severity_number);
    }
  });
}, 20000);
