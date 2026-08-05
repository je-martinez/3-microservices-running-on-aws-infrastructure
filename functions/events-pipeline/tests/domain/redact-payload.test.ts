import { describe, it, expect } from "vitest";
import { redactPayload } from "#domain/redact-payload";

describe("redactPayload", () => {
  it("removes the code field from an AUTH_OTP_REQUESTED payload", () => {
    const result = redactPayload("AUTH_OTP_REQUESTED", {
      email: "user@example.com",
      code: "042817",
      ttlSeconds: 300,
    });

    expect(result).not.toHaveProperty("code");
    expect(result.email).toBe("user@example.com");
    expect(result.ttlSeconds).toBe(300);
  });

  // Asserting key absence off the SERIALIZED form, not just the property:
  // that is what catches the code surviving in some nested field a plain
  // `not.toHaveProperty("code")` would walk straight past.
  it("leaves no trace of the code anywhere in the serialized AUTH_OTP_REQUESTED payload", () => {
    const result = redactPayload("AUTH_OTP_REQUESTED", {
      email: "user@example.com",
      code: "042817",
      ttlSeconds: 300,
    });

    expect(JSON.stringify(result)).not.toContain("042817");
  });

  it("leaves a non-AUTH_OTP_REQUESTED payload untouched", () => {
    const payload = { email: "user@example.com", fullName: "Ada Lovelace" };
    const result = redactPayload("USER_CREATED", payload);

    expect(result).toEqual(payload);
  });

  // Redaction is per-type by design, never "strip any field named code": a
  // legitimate `code` on some future event type must survive.
  it("does not strip a same-named field from an unrelated event type", () => {
    const payload = { code: "PROMO2026", orderId: "ord_1" };
    const result = redactPayload("ORDER_CREATED", payload);

    expect(result).toEqual(payload);
    expect(result.code).toBe("PROMO2026");
  });

  // Own-property lookup: a naive `REDACTED_FIELDS[type]` would resolve
  // inherited members and treat them as a field list.
  it("does not resolve the redaction map through the prototype chain", () => {
    const payload = { code: "042817" };

    expect(redactPayload("toString", payload)).toEqual(payload);
    expect(redactPayload("constructor", payload)).toEqual(payload);
  });

  it("does not mutate the original payload object", () => {
    const original = { email: "user@example.com", code: "042817", ttlSeconds: 300 };
    redactPayload("AUTH_OTP_REQUESTED", original);

    expect(original.code).toBe("042817");
  });
});
