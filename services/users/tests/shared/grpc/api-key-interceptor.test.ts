import { describe, it, expect } from "vitest";
import { apiKeyMatches } from "#shared/grpc/api-key-interceptor";

describe("apiKeyMatches", () => {
  it("returns true for identical keys", () => {
    expect(apiKeyMatches("secret-key", "secret-key")).toBe(true);
  });
  it("returns false for a mismatch", () => {
    expect(apiKeyMatches("wrong", "secret-key")).toBe(false);
  });
  it("returns false when the key is missing", () => {
    expect(apiKeyMatches(undefined, "secret-key")).toBe(false);
  });
  it("returns false for different lengths without throwing", () => {
    expect(apiKeyMatches("short", "a-much-longer-key")).toBe(false);
  });
});
