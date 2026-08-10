import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";
import { waitForEmailTo, getMessage } from "../../support/mailpit-client.js";

// The password-reset flow through the GATEWAY — the URL a real client hits:
// JWT authorizer → njs sub-extraction → nginx routing → service.
//
// Why this layer is not redundant with tests/password-reset.spec.ts: the
// internal spec talks to the service directly and fakes `x-user-id`, so it
// cannot catch a route missing from the gateway, a method the gateway does not
// forward, or an authorizer misconfigured on the new paths. Two of these routes
// are PUBLIC (a user who forgot their password holds no token) and one is
// AUTHENTICATED — a gateway that got that split wrong would either lock users
// out of the reset or expose the password change to anonymous callers, and only
// this layer can tell.
//
// Every request path is RELATIVE (no leading slash) — see gateway-client.ts: a
// leading slash replaces the whole baseURL path under WHATWG URL joining, so
// the request would land on Floci's S3 root instead of the gateway integration.

//: The subject the events-pipeline's password-reset handler sends under. Tells
// the reset mail apart from the welcome email registration also triggers.
const RESET_SUBJECT = "Reset your password";

//: Pipeline latency (SQS → Lambda → SES → Mailpit), measured at 0.5-1.8s
// locally. Bounded so a broken pipeline fails the suite instead of hanging it.
const EMAIL_TIMEOUT_MS = 45_000;

// Reads the FULL message, never the search summary: the summary carries only a
// truncated `Snippet`, and a code past its edge would look like "no code in the
// email" while delivery was perfect.
async function extractResetCode(messageId: string): Promise<string> {
  const message = await getMessage(messageId);

  const body =
    message.Text && message.Text.trim().length > 0
      ? message.Text
      : message.HTML.replace(/<[^>]+>/g, " ");

  const match = body.match(/\b(\d{6})\b/);
  expect(match, `no 6-digit code found in the reset email:\n${body}`).toBeTruthy();
  return match![1]!;
}

test("POST v1/users/password/forgot is PUBLIC through the gateway (no token)", async () => {
  // The load-bearing assertion of this layer: a user who forgot their password
  // has no token. If the authorizer is applied to this route, the reset flow is
  // unreachable for exactly the people who need it.
  const api = await gatewayClient(); // no token on purpose
  const user = makeUser();
  await api.post("v1/users/register", { data: user });

  const res = await api.post("v1/users/password/forgot", { data: { email: user.email } });
  expect(res.status()).toBe(202);
  expect(await res.json()).toEqual({ status: "accepted" });
});

test("POST v1/users/password/forgot does not reveal whether the email exists", async () => {
  const api = await gatewayClient();
  const user = makeUser();
  await api.post("v1/users/register", { data: user });

  const known = await api.post("v1/users/password/forgot", { data: { email: user.email } });
  const unknown = await api.post("v1/users/password/forgot", {
    data: { email: `e2e+never-registered-${Date.now()}@example.com` },
  });

  expect(unknown.status()).toBe(known.status());
  expect(await unknown.json()).toEqual(await known.json());
});

test("POST v1/users/password/confirm is PUBLIC and rejects a wrong code with 401", async () => {
  const api = await gatewayClient(); // no token on purpose
  const user = makeUser();
  await api.post("v1/users/register", { data: user });
  await api.post("v1/users/password/forgot", { data: { email: user.email } });

  const res = await api.post("v1/users/password/confirm", {
    data: { email: user.email, code: "000000", newPassword: "N3wP@ssw0rd!" },
  });
  // 401 from the SERVICE (invalid_reset_code), not from the authorizer — the
  // body is what distinguishes the two, so it is asserted explicitly.
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("invalid_reset_code");
});

test("full reset through the gateway: emailed code sets a password that then logs in", async () => {
  test.setTimeout(EMAIL_TIMEOUT_MS + 60_000);

  const api = await gatewayClient(); // whole flow is public
  const user = makeUser();
  const reg = await api.post("v1/users/register", { data: user });
  expect(reg.status()).toBe(201);

  const forgot = await api.post("v1/users/password/forgot", { data: { email: user.email } });
  expect(forgot.status()).toBe(202);

  const [message] = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    matching: (m) => m.Subject === RESET_SUBJECT,
    description: `the "${RESET_SUBJECT}" email`,
  });
  const code = await extractResetCode(message!.ID);

  const newPassword = `N3w${user.password}`;
  const confirm = await api.post("v1/users/password/confirm", {
    data: { email: user.email, code, newPassword },
  });
  expect(confirm.status()).toBe(200);
  expect(await confirm.json()).toEqual({ status: "password_updated" });

  // The password really changed in Cognito, proven by authenticating with it.
  const login = await api.post("v1/users/login", {
    data: { email: user.email, password: newPassword },
  });
  expect(login.status()).toBe(200);
  expect((await login.json()).accessToken).toBeTruthy();

  // Single-use: the Redis key was deleted on success.
  const replay = await api.post("v1/users/password/confirm", {
    data: { email: user.email, code, newPassword: "An0th3rP@ss!" },
  });
  expect(replay.status()).toBe(401);
});

test("PATCH v1/users/me/password requires a token (401 without one)", async () => {
  // The sibling route that must NOT be public. A gateway that allowlisted this
  // one alongside the two reset routes would let anyone rewrite any password.
  const api = await gatewayClient(); // no token
  const res = await api.patch("v1/users/me/password", {
    data: { newPassword: "N3wP@ssw0rd!" },
  });
  expect(res.status()).toBe(401);
});

test("PATCH v1/users/me/password changes the password with a real JWT", async () => {
  const { token, email } = await getGatewayToken();
  const api = await gatewayClient(token);

  const newPassword = `Ch4ng3dP@ss${Date.now()}!`;
  const res = await api.patch("v1/users/me/password", { data: { newPassword } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.email).toBe(email);
  expect(body.mustChangePassword).toBe(false);

  const login = await api.post("v1/users/login", { data: { email, password: newPassword } });
  expect(login.status()).toBe(200);
});

test("PATCH v1/users/me/password does not accept profile fields", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const before = await api.get("v1/users/me");
  const { fullName } = await before.json();

  await api.patch("v1/users/me/password", {
    data: { newPassword: `Ch4ng3dP@ss${Date.now()}!`, fullName: "Should Not Apply" },
  });

  const after = await api.get("v1/users/me");
  expect((await after.json()).fullName).toBe(fullName);
});

test("GET v1/users/me exposes mustChangePassword through the gateway", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const res = await api.get("v1/users/me");
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty("mustChangePassword", false);
});
