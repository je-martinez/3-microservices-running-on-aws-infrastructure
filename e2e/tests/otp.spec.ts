import { test, expect } from "@playwright/test";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { assertMailpitReachable, waitForEmailTo, getMessage } from "../support/mailpit-client.js";

// The OTP endpoints against the service URL directly (the "internal" project).
// This layer sits below the gateway spec (tests/gateway/otp-flow.spec.ts) and
// answers a different question: it exercises the service's own contract —
// status codes, the shape of what comes back, the passwordless guard — without
// the JWT authorizer, njs, or nginx in the path.
//
// It still crosses into Cognito and the events pipeline for real: `otp/start`
// hits AdminInitiateAuth and the challenge Lambda genuinely emails a code. What
// it does NOT prove is that the gateway routes exist and forward correctly —
// only the gateway spec can, which is why an endpoint needs both.

const EMAIL_TIMEOUT_MS = 45_000;
const OTP_SUBJECT = "Your one-time code";

// Same extraction the gateway spec uses, and for the same reason: the search
// summary carries only a truncated `Snippet`, so the full message is fetched
// and the code read out of the real body.
async function codeFrom(messageId: string): Promise<string> {
  const message = await getMessage(messageId);
  const body =
    message.Text && message.Text.trim().length > 0
      ? message.Text
      : message.HTML.replace(/<[^>]+>/g, " ");
  const match = body.match(/\b(\d{6})\b/);
  if (!match) {
    throw new Error(
      `No 6-digit code in the OTP email (subject "${message.Subject}"). ` +
        `Body starts: ${body.slice(0, 200)}`,
    );
  }
  return match[1];
}

test.beforeAll(async () => {
  await assertMailpitReachable();
});

test("POST /v1/users/otp/start returns an opaque session for an existing user", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  const res = await api.post("/v1/users/otp/start", { data: { email: user.email } });
  expect(res.status()).toBe(200);

  const body = await res.json();
  expect(body.session).toBeTruthy();

  // The response carries the session and nothing else. Asserting the ABSENCE of
  // a code is the point: the code travels by email, and a response that also
  // contained it would make the whole email round-trip decorative — and would
  // hand it to anyone who can see the response.
  expect(JSON.stringify(body)).not.toMatch(/\b\d{6}\b/);
});

test("the emailed code exchanges for tokens at POST /v1/users/otp/verify", async () => {
  // Must exceed EMAIL_TIMEOUT_MS, or Playwright's 30s default aborts the test
  // WHILE waitForEmailTo is still polling — replacing its diagnosis with a bare
  // "Test timeout of 30000ms exceeded". Under a parallel run the mail genuinely
  // takes longer than 30s to land, so without this the 45s wait never runs out.
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  const start = await api.post("/v1/users/otp/start", { data: { email: user.email } });
  expect(start.status()).toBe(200);
  const { session } = await start.json();

  const [message] = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    matching: (m) => m.Subject === OTP_SUBJECT,
    description: `the "${OTP_SUBJECT}" email`,
  });

  const res = await api.post("/v1/users/otp/verify", {
    data: { email: user.email, session, code: await codeFrom(message.ID) },
  });
  expect(res.status()).toBe(200);

  const tokens = await res.json();
  expect(tokens.idToken).toBeTruthy();
  expect(tokens.accessToken).toBeTruthy();
  expect(tokens.refreshToken).toBeTruthy();
});

// ANTI-FALSE-PASS GUARD: without this, a flow that issued tokens for any input
// would satisfy the happy path above and look completely healthy.
test("a wrong code is rejected with 401 invalid_otp", async () => {
  // Same headroom as the test above: this one waits on the real email too.
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  const start = await api.post("/v1/users/otp/start", { data: { email: user.email } });
  const { session } = await start.json();

  const [message] = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    matching: (m) => m.Subject === OTP_SUBJECT,
    description: `the "${OTP_SUBJECT}" email`,
  });
  const real = await codeFrom(message.ID);

  // Well-formed but wrong, so the rejection can only come from the comparison
  // rather than from shape validation.
  const wrong = String((Number(real) + 1) % 1_000_000).padStart(6, "0");
  expect(wrong).not.toBe(real);

  const res = await api.post("/v1/users/otp/verify", {
    data: { email: user.email, session, code: wrong },
  });
  expect(res.status()).toBe(401);
  // `invalid_otp`, not the generic `invalid_credentials` login returns. Being
  // specific here leaks nothing: reaching this endpoint at all requires a valid
  // session from a challenge that was already started, so the response confirms
  // nothing about whether an account exists — unlike a login failure, which is
  // deliberately generic for exactly that reason (see auth-error-mapping.md).
  expect((await res.json()).error).toBe("invalid_otp");
});

test("passwordless registration marks the user PASSWORDLESS and as E2E Source", async () => {
  const api = await apiClient();
  const { email, fullName } = makeUser();

  const res = await api.post("/v1/users/register/passwordless", { data: { email, fullName } });
  expect(res.status()).toBe(201);

  const body = await res.json();
  expect(body.authType).toBe("PASSWORDLESS");
  // Without the tag, global-teardown never cleans these users and they
  // accumulate in the database run after run.
  expect(body.tags).toContain("E2E Source");
});

// ANTI-FALSE-PASS GUARD: Cognito still holds a random password for a
// passwordless account, so this property is enforced by the service, not by
// Cognito. 401 (not 403) is deliberate — see auth-error-mapping.md.
test("password login is refused for a passwordless user, with the generic 401", async () => {
  const api = await apiClient();
  const { email, fullName, password } = makeUser();

  await api.post("/v1/users/register/passwordless", { data: { email, fullName } });

  const res = await api.post("/v1/users/login", { data: { email, password } });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("invalid_credentials");
});
