import { describe, it, expect } from "vitest";
import { EmailRecordSchema, E2E_EMAILS_COLLECTION } from "#e2e/email-record";

// A valid record, spelled out so a reader sees the whole shape at once.
const valid = {
  run_id: "run_2026-08-29T12-00-00_abc123",
  to: "e2e+uuid@example.com",
  subject: "Your one-time code",
  template_key: "auth-otp",
  html: "<html><body>123456</body></html>",
  code: "123456",
  event_id: "evt_abc",
  trace_id: "1fe7e1b6afff0da2990ff65247a85ee2",
  created_at: new Date("2026-08-29T12:00:00.000Z"),
  expires_at: new Date("2026-08-29T13:00:00.000Z"),
};

describe("EmailRecordSchema", () => {
  it("accepts a fully populated record", () => {
    expect(EmailRecordSchema.parse(valid)).toMatchObject({ to: valid.to, code: "123456" });
  });

  it("accepts a record with no code, because most emails carry none", () => {
    // user-created, order-created and the five tracking templates have no code.
    // Absent, NOT null — the repo's logging convention omits unknown fields
    // rather than writing null, and the same rule applies to what we persist.
    const { code: _code, ...withoutCode } = valid;
    const parsed = EmailRecordSchema.parse(withoutCode);
    expect(parsed).not.toHaveProperty("code");
  });

  it("accepts a record with no trace_id, because a span is not always active", () => {
    const { trace_id: _traceId, ...withoutTrace } = valid;
    expect(() => EmailRecordSchema.parse(withoutTrace)).not.toThrow();
  });

  it("rejects a record with no run_id", () => {
    // run_id is the whole point: a record that cannot be attributed to a run
    // is noise in a shared collection.
    const { run_id: _runId, ...withoutRun } = valid;
    expect(() => EmailRecordSchema.parse(withoutRun)).toThrow();
  });

  it("rejects an empty html body", () => {
    // An empty string would silently pass a truthiness check downstream while
    // proving nothing about what was rendered.
    expect(() => EmailRecordSchema.parse({ ...valid, html: "" })).toThrow();
  });

  it("names the collection separately from the production one", () => {
    expect(E2E_EMAILS_COLLECTION).toBe("e2e_emails");
    expect(E2E_EMAILS_COLLECTION).not.toBe("events");
  });
});
