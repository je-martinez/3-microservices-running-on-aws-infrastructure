import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVerify = vi.fn();
vi.mock("aws-jwt-verify", () => ({
  JwtRsaVerifier: { create: () => ({ verify: mockVerify }) },
}));
// jwt.ts also imports SimpleJwksCache at module scope to build the JWKS
// cache (with a plain-HTTP-capable fetcher when AWS_ENDPOINT_URL is set —
// see jwt.ts's LocalHttpJsonFetcher). The cache itself is never exercised
// here because `verify` is mocked above; the constructor only needs to not
// throw when jwt.ts calls `new SimpleJwksCache(...)`.
vi.mock("aws-jwt-verify/jwk", () => ({
  SimpleJwksCache: vi.fn().mockImplementation(() => ({})),
}));
// validateCognitoJwtFields runs inside the REAL customJwtCheck passed to
// JwtRsaVerifier.create — but since `create` itself is mocked above to
// return a bare { verify: mockVerify }, customJwtCheck is never invoked, so
// this only needs to exist as an importable no-op.
vi.mock("aws-jwt-verify/cognito-verifier", () => ({
  validateCognitoJwtFields: vi.fn(),
}));

describe("verifyCognitoToken", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
    process.env.COGNITO_CLIENT_ID = "testclient";
    // Required by env.ts's getEnv() (see jwt.ts, which calls getEnv() at
    // module scope) — the same CONFIGURATION-not-derived issuer this fix
    // introduces. A fixed test value is fine here: jwksUri/issuer are never
    // actually fetched, since JwtRsaVerifier.create() itself is mocked.
    process.env.COGNITO_ISSUER = "http://localhost:4566/us-east-1_test";
    // getEnv() is a single shared bag validated in full regardless of which
    // fields a given caller actually reads — jwt.ts never reads tableName,
    // but getEnv() still requires WS_CONNECTIONS_TABLE to be present (same
    // reasoning as connections-repository.test.ts setting COGNITO_* for a
    // module that never reads them).
    process.env.WS_CONNECTIONS_TABLE = "conns";
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
