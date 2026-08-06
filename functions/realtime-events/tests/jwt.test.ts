import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVerify = vi.fn();
vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify: mockVerify }) },
}));

describe("verifyCognitoToken", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
    process.env.COGNITO_CLIENT_ID = "testclient";
  });

  it("returns the sub for a valid token", async () => {
    mockVerify.mockResolvedValue({ sub: "abc-123", token_use: "access" });
    const { verifyCognitoToken } = await import("../src/shared/jwt.js");
    await expect(verifyCognitoToken("good")).resolves.toEqual({ sub: "abc-123" });
  });

  it("rejects when the verifier rejects", async () => {
    mockVerify.mockRejectedValue(new Error("expired"));
    const { verifyCognitoToken } = await import("../src/shared/jwt.js");
    await expect(verifyCognitoToken("bad")).rejects.toThrow();
  });

  it("rejects an empty token without calling the verifier", async () => {
    const { verifyCognitoToken } = await import("../src/shared/jwt.js");
    await expect(verifyCognitoToken("")).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
