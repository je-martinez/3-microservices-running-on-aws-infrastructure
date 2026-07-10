import { describe, it, expect } from "vitest";
import { verifyWebhookSecret } from "#features/users/webhooks/verify-secret";

describe("verifyWebhookSecret", () => {
  it("accepts an exact match", () => {
    expect(verifyWebhookSecret("s3cret", "s3cret")).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(verifyWebhookSecret("wrong", "s3cret")).toBe(false);
  });
  it("rejects a missing header without throwing", () => {
    expect(verifyWebhookSecret(undefined, "s3cret")).toBe(false);
  });
  it("rejects a different-length value without throwing", () => {
    expect(verifyWebhookSecret("s", "s3cret")).toBe(false);
  });

  it("rejects a repeated header (string[]) without throwing", () => {
    expect(verifyWebhookSecret(["s3cret", "s3cret"] as unknown as string[], "s3cret")).toBe(false);
  });
});
