import { test, expect } from "@playwright/test";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { waitForEmailTo, getMessage } from "../support/mailpit-client.js";

// The self-owned password-reset flow, driven against the users service
// DIRECTLY (port 3000), with `x-user-id` standing in for the gateway
// authorizer's output. The gateway layer is covered separately in
// tests/gateway/password-reset-flow.spec.ts.
//
// What this layer is for: proving the flow works against the REAL Redis store.
// The unit tests exercise `ResetCodeStore` against an in-memory fake, so they
// cannot catch a wrong `EX` argument, a client that never connects, or a
// REDIS_HOST that resolves to the container itself — the exact failure the env
// comment warns about. Only a request that mints a code and a second request
// that verifies it proves the round trip through Redis.

//: The subject the events-pipeline's password-reset handler sends under. Used
// to tell the reset mail apart from the welcome email that registration also
// triggers to the same address — "the first email that arrives" would race the two.
const RESET_SUBJECT = "Reset your password";

//: Pipeline latency (SQS → Lambda → SES → Mailpit), measured at 0.5-1.8s
// locally. Bounded on purpose: an unbounded wait on a broken pipeline would
// hang the suite instead of failing it with a diagnosis.
const EMAIL_TIMEOUT_MS = 45_000;

// Pulls the 6-digit code out of the delivered reset email.
//
// Reads the FULL message, never the search summary: the summary carries only a
// truncated `Snippet`, and a code that fell outside it would fail here as "no
// code in the email" while the email was delivered perfectly.
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

test("POST /v1/users/password/forgot returns 202 for a registered email", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  const res = await api.post("/v1/users/password/forgot", { data: { email: user.email } });
  expect(res.status()).toBe(202);
  expect(await res.json()).toEqual({ status: "accepted" });
});

// ==== NO USER ENUMERATION ====
// The security property of the endpoint, asserted end to end: an address with
// no account must be answered EXACTLY as one with an account. If this fails,
// the endpoint has become an "is this person a customer?" oracle.
test("POST /v1/users/password/forgot answers identically for an unknown email", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  const known = await api.post("/v1/users/password/forgot", { data: { email: user.email } });
  const unknown = await api.post("/v1/users/password/forgot", {
    data: { email: `e2e+never-registered-${Date.now()}@example.com` },
  });

  expect(unknown.status()).toBe(known.status());
  expect(await unknown.json()).toEqual(await known.json());
});

test("a wrong code is rejected with 401 invalid_reset_code", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });
  await api.post("/v1/users/password/forgot", { data: { email: user.email } });

  const res = await api.post("/v1/users/password/confirm", {
    data: { email: user.email, code: "000000", newPassword: "N3wP@ssw0rd!" },
  });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("invalid_reset_code");
});

// A code for an email that was never registered must fail the SAME way a wrong
// code does — the confirm endpoint must not undo what /forgot protects.
test("an unknown email is rejected with the same 401 as a wrong code", async () => {
  const api = await apiClient();

  const res = await api.post("/v1/users/password/confirm", {
    data: {
      email: `e2e+never-registered-${Date.now()}@example.com`,
      code: "123456",
      newPassword: "N3wP@ssw0rd!",
    },
  });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("invalid_reset_code");
});

// The full round trip, and the only test that proves Redis is actually storing
// and returning the code: mint → read the real email → confirm → log in with
// the NEW password.
test("full reset: the emailed code sets a new password that then logs in", async () => {
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  const forgot = await api.post("/v1/users/password/forgot", { data: { email: user.email } });
  expect(forgot.status()).toBe(202);

  const [message] = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    matching: (m) => m.Subject === RESET_SUBJECT,
    description: `the "${RESET_SUBJECT}" email`,
  });
  const code = await extractResetCode(message!.ID);

  const newPassword = `N3w${user.password}`;
  const confirm = await api.post("/v1/users/password/confirm", {
    data: { email: user.email, code, newPassword },
  });
  expect(confirm.status()).toBe(200);
  expect(await confirm.json()).toEqual({ status: "password_updated" });

  // The password actually changed in Cognito — the point of the whole flow.
  const login = await api.post("/v1/users/login", {
    data: { email: user.email, password: newPassword },
  });
  expect(login.status()).toBe(200);
  expect((await login.json()).idToken).toBeTruthy();

  // SINGLE USE: the store deletes the key on success, so replaying the same
  // code must fail. A pass here with a 200 would mean a reset code stayed live
  // for its full TTL after being used.
  const replay = await api.post("/v1/users/password/confirm", {
    data: { email: user.email, code, newPassword: "An0th3rP@ss!" },
  });
  expect(replay.status()).toBe(401);
});

// A second /forgot must invalidate the first code — one key per email. Two live
// codes would double the guessing surface for no benefit.
test("requesting a second code invalidates the first", async () => {
  test.setTimeout(EMAIL_TIMEOUT_MS * 2 + 30_000);

  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  await api.post("/v1/users/password/forgot", { data: { email: user.email } });
  const [first] = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    matching: (m) => m.Subject === RESET_SUBJECT,
    description: `the first "${RESET_SUBJECT}" email`,
  });
  const firstCode = await extractResetCode(first!.ID);

  await api.post("/v1/users/password/forgot", { data: { email: user.email } });
  // `minCount: 2` is load-bearing: the first reset email is ALREADY in the
  // inbox, so a plain "wait for a matching message" would return instantly and
  // the assertion below would race the second code being stored.
  const resets = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    minCount: 2,
    matching: (m) => m.Subject === RESET_SUBJECT,
    description: `a second "${RESET_SUBJECT}" email`,
  });
  expect(resets.length).toBeGreaterThanOrEqual(2);

  // The superseded code must no longer work — one Redis key per email means the
  // second SET overwrote the first hash.
  const stale = await api.post("/v1/users/password/confirm", {
    data: { email: user.email, code: firstCode, newPassword: "N3wP@ssw0rd!" },
  });
  expect(stale.status()).toBe(401);
});

test("PATCH /v1/users/me/password changes the password and clears mustChangePassword", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  const newPassword = `Ch4ng3d${user.password}`;
  const res = await api.patch("/v1/users/me/password", {
    headers: { "x-user-id": id },
    data: { newPassword },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).mustChangePassword).toBe(false);

  const login = await api.post("/v1/users/login", {
    data: { email: user.email, password: newPassword },
  });
  expect(login.status()).toBe(200);
});

// The dedicated endpoint must NOT double as a profile update.
test("PATCH /v1/users/me/password ignores profile fields in the body", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  await api.patch("/v1/users/me/password", {
    headers: { "x-user-id": id },
    data: { newPassword: `Ch4ng3d${user.password}`, fullName: "Should Not Apply" },
  });

  const me = await api.get("/v1/users/me", { headers: { "x-user-id": id } });
  expect((await me.json()).fullName).toBe(user.fullName);
});

test("GET /v1/users/me exposes mustChangePassword", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  const me = await api.get("/v1/users/me", { headers: { "x-user-id": id } });
  expect(me.status()).toBe(200);
  expect(await me.json()).toHaveProperty("mustChangePassword", false);
});
