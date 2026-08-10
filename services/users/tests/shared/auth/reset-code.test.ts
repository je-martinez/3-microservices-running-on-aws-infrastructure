import { describe, it, expect } from "vitest";
import {
  generateResetCode,
  hashResetCode,
  resetCodeMatches,
  RESET_CODE_LENGTH,
  RESET_CODE_TTL_SECONDS,
} from "#shared/auth/reset-code";

describe("reset-code", () => {
  describe("generateResetCode", () => {
    it("always produces exactly six digits, including for small numbers", () => {
      // 200 draws: enough that a missing zero-pad (which only shows for values
      // below 100000, i.e. 10% of the space) is essentially certain to appear.
      for (let i = 0; i < 200; i++) {
        expect(generateResetCode()).toMatch(/^\d{6}$/);
      }
    });

    it("does not repeat itself across draws", () => {
      // Not a randomness test — it cannot be, from 50 samples. It catches the
      // one failure mode that matters and is cheap to detect: a constant or a
      // seeded-once generator, which would make every reset code identical.
      const codes = new Set(Array.from({ length: 50 }, generateResetCode));
      expect(codes.size).toBeGreaterThan(40);
    });
  });

  describe("hashResetCode", () => {
    it("never returns the plaintext code", () => {
      const code = "042817";
      const hash = hashResetCode(code);
      // The whole point of hashing: the row must not be replayable as a
      // credential by whoever can read it.
      expect(hash).not.toBe(code);
      expect(hash).not.toContain(code);
    });

    it("is deterministic, so the same code verifies against a stored hash", () => {
      expect(hashResetCode("042817")).toBe(hashResetCode("042817"));
    });

    it("produces a 64-character hex digest (sha256)", () => {
      expect(hashResetCode("042817")).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("resetCodeMatches", () => {
    it("accepts the code that produced the hash", () => {
      expect(resetCodeMatches("042817", hashResetCode("042817"))).toBe(true);
    });

    it("rejects a different code", () => {
      expect(resetCodeMatches("000000", hashResetCode("042817"))).toBe(false);
    });

    it("rejects a code whose hash is a different length instead of throwing", () => {
      // `timingSafeEqual` throws on mismatched buffer lengths; a truncated or
      // garbage stored hash (a bad migration, a manual edit) must come back
      // false, not blow up the request with a 500.
      expect(resetCodeMatches("042817", "deadbeef")).toBe(false);
      expect(resetCodeMatches("042817", "")).toBe(false);
    });
  });

  it("pins the TTL to the 10 minutes the email template renders", () => {
    // The forgot-password template prints `ttlMinutes: 10`. This value is what
    // produces that number (it is divided by 60 in the pipeline handler), so a
    // change here silently changes what the user reads. Pinned deliberately.
    expect(RESET_CODE_TTL_SECONDS).toBe(600);
    expect(RESET_CODE_LENGTH).toBe(6);
  });
});
