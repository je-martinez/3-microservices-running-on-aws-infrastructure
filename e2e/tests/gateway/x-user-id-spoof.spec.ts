import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";

// Users trusts `x-user-id` as the caller's identity, so the gateway must OVERWRITE
// it from the verified token on authed routes and strip it on public ones. These
// specs send a forged value from the client and assert it never wins.

test("GET v1/users/me ignores a forged x-user-id and answers the token's own user", async () => {
  const { token, email } = await getGatewayToken();
  const api = await gatewayClient(token);

  const res = await api.get("v1/users/me", { headers: { "x-user-id": `forged-${randomUUID()}` } });

  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.email).toBe(email);
  expect(body.id).toMatch(/^usr_/);
});

test("GET v1/users/me ignores x-user-id naming another real user", async () => {
  const victim = await getGatewayToken();
  const victimId = (await (await (await gatewayClient(victim.token)).get("v1/users/me")).json()).id;
  expect(victimId).toMatch(/^usr_/);

  const attacker = await getGatewayToken();
  const api = await gatewayClient(attacker.token);
  const res = await api.get("v1/users/me", { headers: { "x-user-id": victimId } });

  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.email).toBe(attacker.email);
  expect(body.id).not.toBe(victimId);
});

test("POST v1/users/login with bad credentials and a forged x-user-id is a normal bad login", async () => {
  const api = await gatewayClient(); // no token — public route
  const user = makeUser();
  expect((await api.post("v1/users/register", { data: user })).status()).toBe(201);

  const res = await api.post("v1/users/login", {
    data: { email: user.email, password: `${user.password}-wrong` },
    headers: { "x-user-id": "forged" },
  });

  expect(res.status(), await res.text()).toBe(401);
  const body = await res.json();
  expect(body.accessToken).toBeUndefined();
  expect(body.idToken).toBeUndefined();
});
