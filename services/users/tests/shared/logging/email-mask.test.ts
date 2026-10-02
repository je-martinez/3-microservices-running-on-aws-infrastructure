import { describe, it, expect } from "vitest";
import { maskEmail } from "#shared/logging/email-mask";

describe("maskEmail", () => {
  it("masks the local part and keeps the domain visible", () => {
    expect(maskEmail("john.doe@gmail.com")).toBe("jo*****e@gmail.com");
    expect(maskEmail("maria.garcia@empresa.com")).toBe("ma*********a@empresa.com");
  });

  it("is stable for the same input", () => {
    expect(maskEmail("john.doe@gmail.com")).toBe(maskEmail("john.doe@gmail.com"));
  });

  // The domain identifies no one on its own and is the operationally useful part,
  // so subdomains and multi-part suffixes survive untouched.
  it("keeps the domain intact whatever its shape", () => {
    expect(maskEmail("user@mail.corp.example.com")).toBe("us**@mail.corp.example.com");
    expect(maskEmail("john.doe@example.co.uk")).toBe("jo*****e@example.co.uk");
    expect(maskEmail("john.doe@localhost")).toBe("jo*****e@localhost");
    expect(maskEmail("john.doe@hi.com")).toBe("jo*****e@hi.com");
  });

  // CONTRACT: A naive "keep the first two" reveals a 2-character local part whole.
  // See [[logging-context]]
  it("never reveals a short local part in full", () => {
    expect(maskEmail("jo@gmail.com")).toBe("j*@gmail.com");
    expect(maskEmail("a@gmail.com")).toBe("a*@gmail.com");
  });

  it("masks the tail when prefix+suffix would cover the whole local part", () => {
    expect(maskEmail("abc@gmail.com")).toBe("ab*@gmail.com");
    expect(maskEmail("user@gmail.com")).toBe("us**@gmail.com");
  });

  it("handles a plus-addressed email", () => {
    expect(maskEmail("e2e+12345@example.com")).toBe("e2******5@example.com");
  });

  it("handles a long local part", () => {
    expect(maskEmail("john.doe.1784512821@gmail.com")).toBe("jo****************1@gmail.com");
  });

  // CONTRACT: This runs on unvalidated request bodies — anything not email-shaped is
  // masked wholesale so a malformed value never reaches the log stream as-is.
  // See [[logging-context]]
  it("masks a malformed value wholesale rather than passing it through", () => {
    expect(maskEmail("notanemail")).toBe("**********");
    expect(maskEmail("@gmail.com")).toBe("**********");
    expect(maskEmail("john@")).toBe("*****");
  });

  it("trims surrounding whitespace before masking", () => {
    expect(maskEmail("  john.doe@gmail.com  ")).toBe("jo*****e@gmail.com");
  });

  it("never emits the full local part", () => {
    const masked = maskEmail("john.doe@gmail.com");
    expect(masked).not.toContain("john.doe");
    expect(masked).not.toBe("john.doe@gmail.com");
  });

  it("returns something non-empty even for an empty input", () => {
    expect(maskEmail("").length).toBeGreaterThan(0);
  });
});
