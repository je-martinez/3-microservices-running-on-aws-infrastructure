import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../../../../src/features/users/http/routes.js";

function fakeDeps(e2eEnabled: boolean) {
  return {
    env: { E2E_TESTING_ENABLED: e2eEnabled },
    registerUser: vi.fn(async (_d: any, input: any) => ({ id: "usr_1", tags: input.e2eSource ? ["E2E Source"] : [] })),
    loginUser: vi.fn(),
    getMe: vi.fn(),
    updateProfile: vi.fn(),
    softDeleteE2EUsers: vi.fn(async () => ({ count: 3 })),
  } as any;
}

describe("routes", () => {
  it("GET /v1/health returns ok", async () => {
    const app = buildApp(fakeDeps(false));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("register honors X-E2E-Source only when flag enabled", async () => {
    const app = buildApp(fakeDeps(true));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.c", password: "P!1", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tags).toContain("E2E Source");
  });

  it("register ignores X-E2E-Source when flag disabled", async () => {
    const app = buildApp(fakeDeps(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.c", password: "P!1", fullName: "A" },
    });
    expect(res.json().tags).toEqual([]);
  });

  it("e2e-cleanup returns 404 when flag disabled", async () => {
    const app = buildApp(fakeDeps(false));
    const res = await app.inject({ method: "DELETE", url: "/v1/users/e2e-cleanup" });
    expect(res.statusCode).toBe(404);
  });

  it("e2e-cleanup soft-deletes when flag enabled", async () => {
    const app = buildApp(fakeDeps(true));
    const res = await app.inject({ method: "DELETE", url: "/v1/users/e2e-cleanup" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
  });
});
