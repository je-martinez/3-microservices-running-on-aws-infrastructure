import { describe, it, expect } from "vitest";
import { cognitoWebhookPayloadSchema } from "#features/users/webhooks/cognito-payload";

const valid = {
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp",
  region: "us-east-1",
  userPoolId: "us-east-1_abc123",
  userName: "a@b.com",
  callerContext: { awsSdkVersion: "aws-sdk-unknown", clientId: "cli_1" },
  request: {
    userAttributes: {
      sub: "7904d681-f590-4b4d-bbce-15348a898873",
      email: "a@b.com",
      email_verified: "true",
    },
  },
};

describe("cognitoWebhookPayloadSchema", () => {
  it("accepts a real PostConfirmation event", () => {
    expect(cognitoWebhookPayloadSchema.parse(valid).request.userAttributes.sub)
      .toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("accepts ConfirmForgotPassword", () => {
    const p = { ...valid, triggerSource: "PostConfirmation_ConfirmForgotPassword" };
    expect(cognitoWebhookPayloadSchema.parse(p).triggerSource)
      .toBe("PostConfirmation_ConfirmForgotPassword");
  });

  it("rejects an unsupported trigger (spec D5)", () => {
    const p = { ...valid, triggerSource: "PostAuthentication_Authentication" };
    expect(() => cognitoWebhookPayloadSchema.parse(p)).toThrow();
  });

  it("rejects a non-uuid sub", () => {
    const p = { ...valid, request: { userAttributes: { ...valid.request.userAttributes, sub: "nope" } } };
    expect(() => cognitoWebhookPayloadSchema.parse(p)).toThrow();
  });

  it("keeps unknown custom attributes (raw_payload must retain everything)", () => {
    const p = {
      ...valid,
      request: { userAttributes: { ...valid.request.userAttributes, "custom:tier": "gold" } },
    };
    const parsed = cognitoWebhookPayloadSchema.parse(p);
    expect((parsed.request.userAttributes as Record<string, unknown>)["custom:tier"]).toBe("gold");
  });
});
