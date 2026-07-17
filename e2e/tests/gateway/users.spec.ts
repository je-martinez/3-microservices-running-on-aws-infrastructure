import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";

// Full gateway coverage of every current Users endpoint: JWT authorizer → njs
// sub-extraction → nginx routing → service, end to end (not faked, unlike the
// "internal" project). Each authed spec uses its own isolated E2E user via
// getGatewayToken() to avoid cross-test data bleed.

test("POST v1/users/register is public and returns 201 with the created profile", async () => {
  const api = await gatewayClient(); // no token — public route
  const user = makeUser();
  const res = await api.post("v1/users/register", { data: user });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.email).toBe(user.email);
  expect(body.id).toMatch(/^usr_/);
});

test("POST v1/users/login is public and returns Cognito tokens", async () => {
  const api = await gatewayClient(); // no token — public route
  const user = makeUser();
  const reg = await api.post("v1/users/register", { data: user });
  expect(reg.status()).toBe(201);

  const res = await api.post("v1/users/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.idToken).toBeTruthy();
  expect(body.accessToken).toBeTruthy();
  expect(body.refreshToken).toBeTruthy();
});

test("POST v1/users/refresh exchanges a refresh token for new tokens", async () => {
  const api = await gatewayClient(); // no token — public route
  const user = makeUser();
  await api.post("v1/users/register", { data: user });
  const login = await api.post("v1/users/login", { data: { email: user.email, password: user.password } });
  expect(login.status()).toBe(200);
  const { refreshToken } = await login.json();
  expect(refreshToken).toBeTruthy();

  const res = await api.post("v1/users/refresh", { data: { refreshToken } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.idToken).toBeTruthy();
  expect(body.accessToken).toBeTruthy();
});

test("GET v1/users/health is public and returns 200 with no auth", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("v1/users/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET v1/users/me returns 200 with a valid Bearer token", async () => {
  const { token, email } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.get("v1/users/me");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.email).toBe(email);
  expect(body.id).toMatch(/^usr_/);
});

test("GET v1/users/me is 401 without a Bearer token", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("v1/users/me");
  expect(res.status()).toBe(401);
});

test("PATCH v1/users/me updates the profile and the change is visible on GET", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const before = await api.get("v1/users/me");
  expect(before.status()).toBe(200);
  const newFullName = `${(await before.json()).fullName} Updated`;

  const patch = await api.patch("v1/users/me", { data: { fullName: newFullName } });
  expect(patch.status()).toBe(200);
  expect((await patch.json()).fullName).toBe(newFullName);

  const after = await api.get("v1/users/me");
  expect(after.status()).toBe(200);
  expect((await after.json()).fullName).toBe(newFullName);
});
