import { describe, it, expect } from "vitest";
import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";

describe("MODEL_ID_PREFIXES", () => {
  it("registers the User model prefix", () => {
    expect(MODEL_ID_PREFIXES.User).toBe("usr_");
  });
});

describe("generateId", () => {
  it("returns an id prefixed with the given prefix", () => {
    const id = generateId(MODEL_ID_PREFIXES.User);
    expect(id.startsWith("usr_")).toBe(true);
    expect(id.length).toBeGreaterThan(10);
  });
  it("returns unique ids", () => {
    expect(generateId("usr_")).not.toBe(generateId("usr_"));
  });
});
