import { describe, it, expect } from "vitest";
import { PermanentError, TransientError, isTransient } from "#pipeline/errors";

describe("error classification", () => {
  it("PermanentError is not transient", () => {
    expect(isTransient(new PermanentError("invalid payload"))).toBe(false);
  });

  it("TransientError is transient", () => {
    expect(isTransient(new TransientError("DocumentDB unreachable"))).toBe(true);
  });

  it("an unclassified error is treated as transient (safe default)", () => {
    expect(isTransient(new Error("something unexpected"))).toBe(true);
  });

  it("a non-Error thrown value is treated as transient", () => {
    expect(isTransient("a string was thrown")).toBe(true);
  });
});
