import { describe, it, expect } from "vitest";
import { NanoIdConfig, MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";

// The id format is a CROSS-SERVICE CONTRACT: ids travel in headers, SQS
// envelopes and foreign keys, so Orders and Tracking pin the same three values
// (alphabet, length, prefix width) in their own suites. A change here that is
// not mirrored there produces ids the other services reject.
describe("nano-id", () => {
  describe("the alphabet", () => {
    it("contains only letters and digits", () => {
      expect(NanoIdConfig.ALPHABET).toMatch(/^[A-Za-z0-9]+$/);
    });

    it("excludes the two characters nanoid adds by default", () => {
      // `-` reads as a flag when an id is pasted into a shell; `_` disappears
      // against an underscored column name. Dropping them is the whole point of
      // the custom alphabet.
      expect(NanoIdConfig.ALPHABET).not.toContain("_");
      expect(NanoIdConfig.ALPHABET).not.toContain("-");
    });

    it("has no duplicate characters", () => {
      // A repeated character biases the distribution toward it, silently
      // reducing entropy below what the length implies.
      expect(new Set(NanoIdConfig.ALPHABET).size).toBe(NanoIdConfig.ALPHABET.length);
    });

    it("covers all 62 alphanumerics", () => {
      expect(NanoIdConfig.ALPHABET.length).toBe(62);
    });
  });

  describe("generateId", () => {
    it("produces prefix + 24 characters from the alphabet", () => {
      const id = generateId("usr_");
      expect(id).toMatch(/^usr_[A-Za-z0-9]{24}$/);
      expect(id).toHaveLength(NanoIdConfig.TOTAL_LENGTH);
    });

    it("never emits a character outside the alphabet", () => {
      // 500 ids ≈ 12k characters: enough that a stray `_`/`-` from a default
      // alphabet would show up rather than hiding behind a lucky sample.
      const chars = new Set(
        Array.from({ length: 500 }, () => generateId("usr_").slice(4)).join(""),
      );
      for (const c of chars) expect(NanoIdConfig.ALPHABET).toContain(c);
    });

    it("does not collide across a large sample", () => {
      const ids = new Set(Array.from({ length: 10_000 }, () => generateId("usr_")));
      expect(ids.size).toBe(10_000);
    });

    it("fits the width every id column is sized for", () => {
      // 28. MySQL truncates a too-long value silently rather than erroring, so
      // this number and the column width must agree.
      expect(NanoIdConfig.TOTAL_LENGTH).toBe(28);
    });
  });

  describe("prefixes", () => {
    it("are all three characters and an underscore", () => {
      for (const prefix of Object.values(MODEL_ID_PREFIXES)) {
        expect(prefix).toMatch(/^[a-z]{3}_$/);
        expect(prefix).toHaveLength(NanoIdConfig.PREFIX_LENGTH);
      }
    });

    it("are unique per model, so an id names its own type", () => {
      const values = Object.values(MODEL_ID_PREFIXES);
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe("pattern()", () => {
    it("accepts what the generator produces", () => {
      expect(NanoIdConfig.pattern("usr_").test(generateId("usr_"))).toBe(true);
    });

    it("rejects the previous 21-character format", () => {
      // The regression this refactor could cause: a service still minting the
      // old shape would be silently rejected at every boundary.
      expect(NanoIdConfig.pattern("usr_").test("usr_V1StGXR8Z5jdHi6B-myT")).toBe(false);
    });
  });
});
