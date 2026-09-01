import { describe, it, expect, vi, beforeEach } from "vitest";

// FILE-WIDE and BEFORE the import: the sender imports #shared/config/env, which
// Zod-parses process.env at module load (ADR-0014). Same pattern as
// tests/handler.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "docdb-test");
vi.stubEnv("DOCDB_PASSWORD", "docdb-test");
vi.stubEnv("SES_FROM_ADDRESS", "no-reply@3mrai.local");
vi.stubEnv("ASSETS_BASE_URL", "http://localhost:4566/assets");

const send = vi.fn(async () => ({}));
vi.mock("@aws-sdk/client-ses", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-ses")>("@aws-sdk/client-ses");
  return { ...actual, SESClient: vi.fn(() => ({ send })) };
});

vi.mock("#shared/metrics/cloudwatch-metrics", () => ({
  SERVICE_DIMENSION: "events-pipeline",
  publishMetric: vi.fn(async () => {}),
  publishEmailMetric: vi.fn(async () => {}),
}));

const { sendEmail, resetSesClientForTests } = await import("#email/sender");

beforeEach(() => {
  vi.clearAllMocks();
  resetSesClientForTests();
});

describe("sendEmail with a recorder", () => {
  it("records the email it just sent, including the html and code", async () => {
    const recordEmail = vi.fn(async () => {});
    await sendEmail({
      to: "e2e+uuid@example.com",
      subject: "Your one-time code",
      html: "<html>123456</html>",
      templateKey: "auth-otp",
      code: "123456",
      recordEmail,
    });
    expect(recordEmail).toHaveBeenCalledWith({
      to: "e2e+uuid@example.com",
      subject: "Your one-time code",
      html: "<html>123456</html>",
      templateKey: "auth-otp",
      code: "123456",
    });
  });

  it("records AFTER the send, so a failed send records nothing", async () => {
    // The store answers "what was delivered". Recording before the send would
    // make it answer "what was attempted", and a spec reading it during a SES
    // outage would see mail that never left.
    send.mockRejectedValueOnce(new Error("SES is down"));
    const recordEmail = vi.fn(async () => {});
    await expect(
      sendEmail({
        to: "a@b.com",
        subject: "s",
        html: "<p>h</p>",
        templateKey: "auth-otp",
        recordEmail,
      }),
    ).rejects.toThrow();
    expect(recordEmail).not.toHaveBeenCalled();
  });

  it("does not fail the record when recording throws", async () => {
    // A broken test fixture must never fail a real email. The record is
    // best-effort by construction.
    const recordEmail = vi.fn(async () => {
      throw new Error("mongo is down");
    });
    await expect(
      sendEmail({
        to: "a@b.com",
        subject: "s",
        html: "<p>h</p>",
        templateKey: "auth-otp",
        recordEmail,
      }),
    ).resolves.toBeUndefined();
  });

  it("sends normally when no recorder is supplied", async () => {
    await sendEmail({ to: "a@b.com", subject: "s", html: "<p>h</p>", templateKey: "auth-otp" });
    expect(send).toHaveBeenCalledOnce();
  });
});
