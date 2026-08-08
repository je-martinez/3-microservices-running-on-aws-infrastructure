import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyCognitoToken = vi.fn();
vi.mock("../src/shared/jwt.js", () => ({ verifyCognitoToken }));

const EVENT = (token?: string) => ({
  methodArn: "arn:aws:execute-api:us-east-1:000000000000:abc/dev/$connect",
  queryStringParameters: token === undefined ? null : { token },
});

describe("$connect authorizer", () => {
  // Braces, no implicit return: `mockReset()` returns the mock itself, and a
  // value returned from `beforeEach` is treated by Vitest as a post-test
  // cleanup callback (Jest-style convention) — an implicit-return arrow here
  // would register verifyCognitoToken as that callback, causing it to be
  // invoked a second, uninstrumented time after each test and surfacing a
  // false "unhandled rejection" failure whenever mockRejectedValue was set.
  beforeEach(() => {
    verifyCognitoToken.mockReset();
  });

  it("allows a valid token and puts cognito_sub in the context", async () => {
    verifyCognitoToken.mockResolvedValue({ sub: "sub-abc" });
    const { handler } = await import("../src/authorizer.js");
    const res = await handler(EVENT("good") as never);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.context.cognito_sub).toBe("sub-abc");
  });

  it("denies when verification fails", async () => {
    verifyCognitoToken.mockRejectedValue(new Error("expired"));
    const { handler } = await import("../src/authorizer.js");
    const res = await handler(EVENT("bad") as never);
    expect(res.policyDocument.Statement[0].Effect).toBe("Deny");
  });

  it("denies when the token is absent entirely", async () => {
    const { handler } = await import("../src/authorizer.js");
    const res = await handler(EVENT() as never);
    expect(res.policyDocument.Statement[0].Effect).toBe("Deny");
    expect(verifyCognitoToken).not.toHaveBeenCalled();
  });
});
