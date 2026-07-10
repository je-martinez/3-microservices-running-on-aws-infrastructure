import { test, expect } from "@playwright/test";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

test("health is ok", async () => {
  const api = await apiClient();
  const res = await api.get("/v1/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("register marks the user as E2E Source", async () => {
  const api = await apiClient();
  const res = await api.post("/v1/users/register", { data: makeUser() });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.tags).toContain("E2E Source");
});

test("login returns Cognito tokens", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });
  const res = await api.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  expect((await res.json()).idToken).toBeTruthy();
});

test("GET /v1/users/me returns the caller's profile when x-user-id is present", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  // In production the API Gateway JWT authorizer validates the Cognito token
  // and injects `x-user-id` for the service to trust. The service itself does
  // not validate JWTs — it only reads this header (see routes.ts onRequest
  // hook) — so E2E specs simulate the authorizer's output directly.
  const me = await api.get("/v1/users/me", { headers: { "x-user-id": id } });
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.email).toBe(user.email);
  expect(body.fullName).toBe(user.fullName);
});

test("PATCH /v1/users/me updates the profile and the change is visible on a subsequent GET", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  const newFullName = `${user.fullName} Updated`;
  const patch = await api.patch("/v1/users/me", {
    headers: { "x-user-id": id },
    data: { fullName: newFullName },
  });
  expect(patch.status()).toBe(200);
  expect((await patch.json()).fullName).toBe(newFullName);

  const me = await api.get("/v1/users/me", { headers: { "x-user-id": id } });
  expect(me.status()).toBe(200);
  expect((await me.json()).fullName).toBe(newFullName);
});

// The old JE-37 spec (see origin/test/JE-37-e2e-specs) asserted a 401 from the
// API Gateway JWT authorizer when calling /v1/users/me without a token. That
// authorizer is NOT reachable on Floci — its HTTP_PROXY integration doesn't
// forward the request path (docs/lessons/floci-rds-apigw-limits.md) — so
// these specs drive the users service directly, bypassing the authorizer
// entirely. Without `x-user-id` the service has no `currentActor`, so
// `getMe` is skipped and the handler returns 404, not 401 (see routes.ts).
// This test documents that real behavior instead of faking authorizer
// coverage. Authorizer/401 coverage is deferred to a real-AWS environment.
test("GET /v1/users/me without x-user-id returns 404 (authorizer coverage unavailable on Floci)", async () => {
  const api = await apiClient();
  const res = await api.get("/v1/users/me");
  expect(res.status()).toBe(404);
});
