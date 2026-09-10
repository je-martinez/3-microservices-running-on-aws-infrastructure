import { describe, it, expect, vi } from "vitest";
import { createContainer, asValue } from "awilix";
import { buildApp, bearerToken } from "#features/users/http/routes";

// A container carrying only what POST /v1/users/logout touches. `db` is still
// required because routes.ts's onRequest hook builds a CurrentUser on every
// request regardless of which route is hit.
function makeApp(execute: ReturnType<typeof vi.fn>) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => null) } } as any),
    env: asValue({ E2E_TESTING_ENABLED: false } as any),
    signOutCommand: asValue({ execute } as any),
  });
  return buildApp(container as any);
}

const AUTHED = { "x-user-id": "sub-1", authorization: "Bearer access-token" };

describe("POST /v1/users/logout", () => {
  it("401s without x-user-id", async () => {
    const execute = vi.fn();
    const app = makeApp(execute);

    const res = await app.inject({
      method: "POST",
      url: "/v1/users/logout",
      headers: { authorization: "Bearer access-token" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    // The guard must stop the request before any revocation is attempted — this is
    // what the route's absence from the public-routes allowlist buys.
    expect(execute).not.toHaveBeenCalled();
  });

  it("204s with no body once the session is revoked", async () => {
    const app = makeApp(vi.fn(async () => undefined));

    const res = await app.inject({ method: "POST", url: "/v1/users/logout", headers: AUTHED });

    expect(res.statusCode).toBe(204);
    // A revoked session has nothing to describe, and echoing the token back would
    // put a credential in the response body.
    expect(res.body).toBe("");
  });

  it("passes the bearer token to the command without the scheme prefix", async () => {
    const execute = vi.fn(async () => undefined);
    const app = makeApp(execute);

    await app.inject({ method: "POST", url: "/v1/users/logout", headers: AUTHED });

    expect(execute).toHaveBeenCalledWith({ accessToken: "access-token" });
  });

  // The idempotency contract end to end: the provider swallows an already-revoked
  // token, so a second sign-out is a 204 exactly like the first. A 401 here would
  // fail the second of two clicks for a client that already dropped its tokens.
  it("204s again when the session was already revoked", async () => {
    const app = makeApp(vi.fn(async () => undefined));

    const first = await app.inject({ method: "POST", url: "/v1/users/logout", headers: AUTHED });
    const second = await app.inject({ method: "POST", url: "/v1/users/logout", headers: AUTHED });

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
  });

  it("401s when the caller sends no Authorization header", async () => {
    const execute = vi.fn();
    const app = makeApp(execute);

    const res = await app.inject({
      method: "POST",
      url: "/v1/users/logout",
      headers: { "x-user-id": "sub-1" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
    // There is no token to revoke, so this must not reach Cognito at all.
    expect(execute).not.toHaveBeenCalled();
  });

  it("401s when the Authorization header is not a Bearer token", async () => {
    const execute = vi.fn();
    const app = makeApp(execute);

    const res = await app.inject({
      method: "POST",
      url: "/v1/users/logout",
      headers: { "x-user-id": "sub-1", authorization: "Basic dXNlcjpwYXNz" },
    });

    expect(res.statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("bearerToken", () => {
  it("extracts the token regardless of the scheme's case", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
  });

  it("returns null for anything that is not a bearer token", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
