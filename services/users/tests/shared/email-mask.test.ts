import { describe, it, expect } from "vitest";
import { maskEmail } from "#shared/logging/email-mask";

describe("maskEmail", () => {
  it("masks the local part and domain name, keeping the TLD", () => {
    expect(maskEmail("john.doe@gmail.com")).toBe("jo******@gm***.com");
  });

  it("is stable for the same input", () => {
    expect(maskEmail("john.doe@gmail.com")).toBe(maskEmail("john.doe@gmail.com"));
  });

  it("never reveals a short local part in full", () => {
    // A 2-char local part would be fully visible under a naive "keep 2" rule.
    expect(maskEmail("jo@gmail.com")).toBe("j*@gm***.com");
    expect(maskEmail("a@gmail.com")).toBe("a*@gm***.com");
  });

  it("never reveals a short domain name in full", () => {
    expect(maskEmail("john.doe@hi.com")).toBe("jo******@h*.com");
  });

  it("treats only the last label as the TLD on a multi-part suffix", () => {
    // "example.co" is masked as one unit and only ".uk" is kept. Splitting a
    // public suffix properly would need the PSL; that is not worth a dependency
    // here, and masking MORE than necessary is the safe direction to err in.
    expect(maskEmail("john.doe@example.co.uk")).toBe("jo******@ex********.uk");
  });

  it("handles a plus-addressed email", () => {
    expect(maskEmail("e2e+12345@example.com")).toBe("e2*******@ex*****.com");
  });

  it("masks a malformed value wholesale rather than passing it through", () => {
    // Runs on unvalidated request bodies, so anything email-shaped-ish that
    // isn't must not leak.
    expect(maskEmail("notanemail")).toBe("**********");
    expect(maskEmail("@gmail.com")).toBe("**********");
    expect(maskEmail("john@")).toBe("*****");
  });

  it("masks a domain with no dot", () => {
    expect(maskEmail("john.doe@localhost")).toBe("jo******@lo*******");
  });

  it("trims surrounding whitespace before masking", () => {
    expect(maskEmail("  john.doe@gmail.com  ")).toBe("jo******@gm***.com");
  });

  it("never emits the full address", () => {
    const raw = "john.doe@gmail.com";
    const masked = maskEmail(raw);
    expect(masked).not.toBe(raw);
    expect(masked).not.toContain("john.doe");
    expect(masked).not.toContain("gmail");
  });

  it("returns something non-empty even for an empty input", () => {
    expect(maskEmail("").length).toBeGreaterThan(0);
  });
});
