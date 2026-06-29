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

test("GET /v1/users/me requires a JWT (authorizer) and returns the profile", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });
  const login = await api.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  const { idToken } = await login.json();

  // Without a token → 401 from the API Gateway authorizer.
  const unauth = await api.get("/v1/users/me");
  expect(unauth.status()).toBe(401);

  // With a token → 200.
  const me = await api.get("/v1/users/me", { headers: { Authorization: `Bearer ${idToken}` } });
  expect(me.status()).toBe(200);
  expect((await me.json()).email).toBe(user.email);
});
