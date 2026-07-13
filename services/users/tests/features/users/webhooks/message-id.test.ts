import { describe, it, expect } from "vitest";
import { deriveMessageId } from "#features/users/webhooks/message-id";

describe("deriveMessageId", () => {
  it("is deterministic — a Cognito retry hashes identically", () => {
    const a = deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp");
    const b = deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp");
    expect(a).toBe(b);
  });

  it("differs by sub", () => {
    expect(deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp"))
      .not.toBe(deriveMessageId("sub-2", "PostConfirmation_ConfirmSignUp"));
  });

  it("differs by triggerSource", () => {
    expect(deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp"))
      .not.toBe(deriveMessageId("sub-1", "PostConfirmation_ConfirmForgotPassword"));
  });

  it("returns a 64-char lowercase hex sha256", () => {
    expect(deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is injective across the delimiter — ('a:b','c') and ('a','b:c') must differ", () => {
    expect(deriveMessageId("a:b", "c")).not.toBe(deriveMessageId("a", "b:c"));
  });
});
