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
  it("protects everything else", () => {
    expect(isPublicRoute("GET", "/v1/users/me")).toBe(false);
    expect(isPublicRoute("PATCH", "/v1/users/me")).toBe(false);
    expect(isPublicRoute("GET", "/v1/users")).toBe(false);
  });
  it("does not exempt a protected path by loose prefix", () => {
    expect(isPublicRoute("GET", "/v1/users/login-history")).toBe(false);
  });
});
