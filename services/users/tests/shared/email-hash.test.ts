import { describe, it, expect } from "vitest";
import { hashEmail } from "#shared/logging/email-hash";

describe("hashEmail", () => {
  it("is stable for the same email", () => {
    expect(hashEmail("user@example.com")).toBe(hashEmail("user@example.com"));
  });

  it("normalizes case and surrounding whitespace", () => {
    const canonical = hashEmail("user@example.com");
    expect(hashEmail("USER@example.com")).toBe(canonical);
    expect(hashEmail("  user@example.com  ")).toBe(canonical);
    expect(hashEmail("User@Example.COM")).toBe(canonical);
  });

  it("differs for different emails", () => {
    expect(hashEmail("a@example.com")).not.toBe(hashEmail("b@example.com"));
  });

  it("is 16 hex characters", () => {
    expect(hashEmail("user@example.com")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not leak the original address", () => {
    const hash = hashEmail("user@example.com");
    expect(hash).not.toContain("user");
    expect(hash).not.toContain("@");
    expect(hash).not.toContain("example");
  });

  // The cross-service contract, pinned. Orders' EmailHash.Compute asserts this
  // same literal; if either side changes its normalization or truncation, one
  // of the two tests fails loudly instead of filtering silently returning
  // nothing in production.
  it("matches the pinned cross-service value Orders also asserts", () => {
    expect(hashEmail("user@example.com")).toBe("b4c9a289323b21a0");
  });
});
