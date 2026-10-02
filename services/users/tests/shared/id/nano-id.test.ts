import { describe, it, expect } from "vitest";
import { NanoIdConfig, MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";

// CONTRACT: The id format is a cross-service contract — Orders and Tracking pin the
// same alphabet, length and prefix width. A change not mirrored there produces ids
// the other services reject at headers, envelopes and foreign keys. See [[nano-id]]
describe("nano-id", () => {
  describe("the alphabet", () => {
    it("contains only letters and digits", () => {
      expect(NanoIdConfig.ALPHABET).toMatch(/^[A-Za-z0-9]+$/);
    });

    // WHY: `-` reads as a flag when pasted into a shell; `_` disappears against an
    // underscored column name. Excluding them is the point of the custom alphabet.
    it("excludes the two characters nanoid adds by default", () => {
      expect(NanoIdConfig.ALPHABET).not.toContain("_");
      expect(NanoIdConfig.ALPHABET).not.toContain("-");
    });

    // A repeated character biases the distribution, reducing entropy below what the
    // length implies.
    it("has no duplicate characters", () => {
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

    // 500 ids ≈ 12k characters: enough that a stray `_`/`-` shows up rather than
    // hiding behind a lucky sample.
    it("never emits a character outside the alphabet", () => {
      const chars = new Set(
        Array.from({ length: 500 }, () => generateId("usr_").slice(4)).join(""),
      );
      for (const c of chars) expect(NanoIdConfig.ALPHABET).toContain(c);
    });

    it("does not collide across a large sample", () => {
      const ids = new Set(Array.from({ length: 10_000 }, () => generateId("usr_")));
      expect(ids.size).toBe(10_000);
    });

    // CONTRACT: Every id column is sized for 28. MySQL truncates a longer value
    // silently rather than erroring. See [[nano-id]]
    it("fits the width every id column is sized for", () => {
      expect(NanoIdConfig.TOTAL_LENGTH).toBe(28);
    });
  });

  describe("prefixes", () => {
    it("are all three characters and an underscore", () => {
      for (const prefix of Object.values(NanoIdConfig.PREFIXES)) {
        expect(prefix).toMatch(/^[a-z]{3}_$/);
        expect(prefix).toHaveLength(NanoIdConfig.PREFIX_LENGTH);
      }
    });

    it("are unique, so an id names its own type", () => {
      const values = Object.values(NanoIdConfig.PREFIXES);
      expect(new Set(values).size).toBe(values.length);
    });

    // CONTRACT: The Prisma extension stamps `id` by looking the model NAME up here. A
    // missing model inserts a row with no id and fails on the primary key at runtime.
    it("map every Prisma model to its prefix", () => {
      expect(MODEL_ID_PREFIXES).toEqual({
        User: "usr_",
        UsersCognitoData: "ucd_",
        UsersCognitoEvent: "cge_",
        Notification: "ntf_",
        StripePaymentMethod: "spm_",
      });
    });

    // CONTRACT: Non-model ids stay out of MODEL_ID_PREFIXES; handing Prisma a
    // non-model key is a silent no-op. See [[nano-id]]
    it("keep the non-persisted request and event ids out of the model map", () => {
      expect(MODEL_ID_PREFIXES).not.toHaveProperty("Request");
      expect(MODEL_ID_PREFIXES).not.toHaveProperty("Event");
    });
  });

  describe("typed factories", () => {
    it.each([
      ["newUserId", "usr_"],
      ["newUsersCognitoDataId", "ucd_"],
      ["newUsersCognitoEventId", "cge_"],
      ["newNotificationId", "ntf_"],
      ["newStripePaymentMethodId", "spm_"],
      ["newRequestId", "req_"],
      ["newEventId", "evt_"],
    ] as const)("%s mints a %s id of the shared width", (factory, prefix) => {
      const id = NanoIdConfig[factory]();
      expect(id).toMatch(NanoIdConfig.pattern(prefix));
      expect(id).toHaveLength(NanoIdConfig.TOTAL_LENGTH);
    });
  });

  describe("pattern()", () => {
    it("accepts what the generator produces", () => {
      expect(NanoIdConfig.pattern("usr_").test(generateId("usr_"))).toBe(true);
    });

    // CONTRACT: A 21-character nanoid with `-` is not one of ours; accepting it lets a
    // service minting the wrong shape pass every boundary check.
    it("rejects nanoid's default 21-character format", () => {
      expect(NanoIdConfig.pattern("usr_").test("usr_V1StGXR8Z5jdHi6B-myT")).toBe(false);
    });

    it("rejects another prefix", () => {
      expect(NanoIdConfig.pattern("usr_").test(NanoIdConfig.newNotificationId())).toBe(false);
    });
  });
});
