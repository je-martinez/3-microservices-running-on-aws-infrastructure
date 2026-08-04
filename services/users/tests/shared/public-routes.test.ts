import { describe, it, expect } from "vitest";
import { isPublicRoute } from "#shared/http/public-routes";

describe("isPublicRoute", () => {
  it("exempts the fixed public routes (exact method+path)", () => {
    expect(isPublicRoute("GET", "/v1/health")).toBe(true);
    expect(isPublicRoute("POST", "/v1/users/login")).toBe(true);
    expect(isPublicRoute("POST", "/v1/users/register")).toBe(true);
    expect(isPublicRoute("POST", "/v1/users/refresh")).toBe(true);
  });
  it("exempts webhooks by prefix", () => {
    expect(isPublicRoute("POST", "/v1/webhooks/cognito")).toBe(true);
  });
  it("exempts the E2E cleanup route, which teardown calls with no identity", () => {
    // Regression: this route 401'd every call until it was added to the
    // allowlist, and the harness's teardown ignored the response — so E2E users
    // silently accumulated instead of being soft-deleted. The route only exists
    // under E2E_TESTING_ENABLED; this exemption only decides whether it needs an
    // x-user-id, which it cannot have (teardown holds no user session).
    expect(isPublicRoute("DELETE", "/v1/users/e2e-cleanup")).toBe(true);
  });
  it("exempts the cleanup route only for DELETE", () => {
    expect(isPublicRoute("GET", "/v1/users/e2e-cleanup")).toBe(false);
    expect(isPublicRoute("POST", "/v1/users/e2e-cleanup")).toBe(false);
  });
  it("protects everything else", () => {
    expect(isPublicRoute("GET", "/v1/users/me")).toBe(false);
    expect(isPublicRoute("PATCH", "/v1/users/me")).toBe(false);
    expect(isPublicRoute("GET", "/v1/users")).toBe(false);
  });
  it("does not exempt a protected path by loose prefix", () => {
    expect(isPublicRoute("GET", "/v1/users/login-history")).toBe(false);
  });
});
