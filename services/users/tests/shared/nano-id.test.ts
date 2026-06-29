import { describe, it, expect } from "vitest";
import { newUserId } from "../../src/shared/id/nano-id.js";

describe("newUserId", () => {
  it("returns a usr_-prefixed id", () => {
    const id = newUserId();
    expect(id.startsWith("usr_")).toBe(true);
    expect(id.length).toBeGreaterThan(10);
  });
  it("returns unique ids", () => {
    expect(newUserId()).not.toBe(newUserId());
  });
});
