import { describe, it, expect, vi } from "vitest";
import { createContainer, asValue } from "awilix";
import { buildApp } from "#features/users/http/routes";
import { CascadeFailedError, CascadeUnavailableError } from "#shared/http/cascade-client";

// A container carrying only what DELETE /v1/users/me touches. `db` is still
// required because routes.ts's onRequest hook builds a CurrentUser on every
// request regardless of which route is hit.
function makeApp(execute: ReturnType<typeof vi.fn>) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => null) } } as any),
    env: asValue({ E2E_TESTING_ENABLED: false } as any),
    deleteAccountCommand: asValue({ execute } as any),
  });
  return buildApp(container as any);
}

describe("DELETE /v1/users/me", () => {
  it("401s without x-user-id", async () => {
    const execute = vi.fn();
    const app = makeApp(execute);

    const res = await app.inject({ method: "DELETE", url: "/v1/users/me" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    // The guard must stop the request before any deletion is attempted — this is
    // what the route's absence from the public-routes allowlist buys.
    expect(execute).not.toHaveBeenCalled();
  });

  it("204s with no body when the account is deleted", async () => {
    const app = makeApp(vi.fn(async () => "deleted"));

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    expect(res.statusCode).toBe(204);
    // Nothing left to describe, and the deleted row must not be echoed back.
    expect(res.body).toBe("");
  });

  it("404s when the row is already gone", async () => {
    const app = makeApp(vi.fn(async () => "not_found"));

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("502s when a cascade leg fails", async () => {
    const app = makeApp(
      vi.fn(async () => {
        throw new CascadeFailedError("orders", "status 500");
      }),
    );

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    // 502, not 500: the failure is downstream and the correct action is a retry,
    // which is safe because both internal routes are idempotent.
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "cascade_failed" });
  });

  it("does not leak the failing service's detail to the client", async () => {
    const app = makeApp(
      vi.fn(async () => {
        throw new CascadeFailedError("tracking", "status 503");
      }),
    );

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    // The internal topology stays internal; the service name lives on the error
    // for logs, not in the response body.
    expect(JSON.stringify(res.json())).not.toContain("tracking");
  });

  it("502s when the cascade could not even be attempted", async () => {
    const app = makeApp(
      vi.fn(async () => {
        throw new CascadeUnavailableError("missing_cognito_sub");
      }),
    );

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    // Same status as a leg refusing: from the caller's side the fact is identical
    // — the deletion did not happen and the account is intact. The error handler
    // matches the BASE class, so a new cascade failure mode gets 502 by
    // subclassing rather than by editing the handler.
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "cascade_failed" });
  });
});
