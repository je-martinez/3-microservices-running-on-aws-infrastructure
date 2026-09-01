import { test, expect } from "@playwright/test";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";
import {
  assertMailpitReachable,
  waitForEmailTo,
  getMessage,
} from "../../support/mailpit-client.js";
import { describeRecordedEmails } from "../../support/email-store-client.js";

// The passwordless email-OTP journey, through the gateway only, in the order a
// real client walks it:
//
//   request a code → READ IT OUT OF THE DELIVERED EMAIL → exchange it for
//   tokens → use those tokens on a protected route
//
// The load-bearing step is reading the code out of Mailpit. Every layer below
// this one can pass while the flow is broken for a real user: the Lambda unit
// tests assert what the triggers RETURN, and the service tests assert what
// Users does with a session id. Neither proves that a code ever reached an
// inbox, nor that the code sitting in that inbox is the one Cognito will
// accept. Only fetching the mail and authenticating with what it contains
// closes that gap — which is why this spec belongs at the gateway layer and
// cannot be faked with a direct service call.
//
// Every request path is RELATIVE (no leading slash) — see gateway-client.ts: a
// leading slash replaces the whole baseURL path under WHATWG URL joining, so
// the request would land on Floci's S3 root instead of the gateway integration.

//: How long to wait for the OTP email. The pipeline (Cognito trigger → SQS →
// Lambda → SES → Mailpit) was measured end-to-end at 0.5-1.8s locally, the
// upper figure on a cold Lambda. 45s is that with generous room, and BOUNDED
// on purpose: an unbounded wait on a broken pipeline would hang the suite
// instead of failing it with a diagnosis.
const EMAIL_TIMEOUT_MS = 45_000;

//: The subject the events-pipeline's auth-otp handler sends under. Used to tell
// the OTP mail apart from any other message reaching the same address — a
// passwordless registration also triggers a welcome email, and asserting on
// "the first email that arrives" would race the two.
const OTP_SUBJECT = "Your one-time code";

// Pulls the 6-digit code out of a delivered message.
//
// Reads the FULL message (`getMessage`), never the search summary: the summary
// carries only `Snippet`, a truncated flattened preview, and a code that fell
// outside it would fail here as "no code in the email" while the email was
// delivered perfectly. Verified against the rendered template — the code
// survives as a plain digit run in both the text and HTML parts.
//
// Prefers the plain-text part and falls back to HTML with tags stripped, so the
// extraction does not depend on which alternative the mailer put first.
async function extractOtpCode(messageId: string): Promise<string> {
  const message = await getMessage(messageId);

  const body =
    message.Text && message.Text.trim().length > 0
      ? message.Text
      : message.HTML.replace(/<[^>]+>/g, " ");

  const match = body.match(/\b(\d{6})\b/);

  if (!match) {
    throw new Error(
      `No 6-digit code found in the OTP email (subject "${message.Subject}"). ` +
        "The template is expected to render the code as plain visible text — " +
        "see functions/events-pipeline/emails/auth-otp.tsx. Body starts: " +
        `${body.slice(0, 200)}`,
    );
  }

  return match[1];
}

// Requests a code for `email` and returns the session plus the code that was
// actually delivered. Shared by the specs below so each one states only what it
// is asserting.
async function requestCode(
  api: Awaited<ReturnType<typeof gatewayClient>>,
  email: string,
): Promise<{ session: string; code: string }> {
  const start = await api.post("v1/users/otp/start", { data: { email } });
  expect(start.status()).toBe(200);
  const { session } = await start.json();
  expect(session).toBeTruthy();

  // The ASSERTION IS UNCHANGED — this still fails when no email arrives, and the
  // code still comes out of the real message. The wrapper only appends the
  // record store's verdict, which separates "the pipeline never sent it" from
  // "it sent it and the mail was late" — indistinguishable from Mailpit alone,
  // and fixed in completely different places.
  let message;
  try {
    [message] = await waitForEmailTo(email, {
      timeoutMs: EMAIL_TIMEOUT_MS,
      matching: (m) => m.Subject === OTP_SUBJECT,
      description: `the "${OTP_SUBJECT}" email`,
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}${await describeRecordedEmails(email)}`);
  }

  return { session, code: await extractOtpCode(message.ID) };
}

test.beforeAll(async () => {
  await assertMailpitReachable();
});

test("a password user can obtain tokens with an emailed OTP code", async () => {
  // Must exceed EMAIL_TIMEOUT_MS, or Playwright's 30s default aborts the test
  // WHILE requestCode is still polling Mailpit — replacing its diagnosis
  // ("nothing arrived; check the Lambda, the queue url, the mailpit
  // container") with a bare "Test timeout of 30000ms exceeded". Under a
  // parallel run the mail genuinely takes longer than 30s to land, so without
  // this the 45s wait can never actually run out.
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await gatewayClient(); // no token — these are public routes
  const user = makeUser();

  const reg = await api.post("v1/users/register", { data: user });
  expect(reg.status()).toBe(201);

  const { session, code } = await requestCode(api, user.email);

  const verify = await api.post("v1/users/otp/verify", {
    data: { email: user.email, session, code },
  });
  expect(verify.status()).toBe(200);

  const tokens = await verify.json();
  expect(tokens.idToken).toBeTruthy();
  expect(tokens.accessToken).toBeTruthy();
  expect(tokens.refreshToken).toBeTruthy();

  // The tokens are not merely well-formed — they authenticate. This is what
  // makes the whole chain real: a token the gateway's JWT authorizer rejects
  // would satisfy every assertion above and still be useless.
  const authed = await gatewayClient(tokens.accessToken ?? tokens.idToken);
  const me = await authed.get("v1/users/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).email).toBe(user.email);
});

// MANDATORY ANTI-FALSE-PASS GUARD #1.
//
// Without this test the suite cannot tell a working challenge from a bypassed
// one: a flow that issued tokens for ANY input would satisfy the happy path
// above completely. That is not hypothetical here — Cognito's native
// USER_AUTH/EMAIL_OTP flow does exactly that on Floci (returns tokens with no
// challenge issued at all), which is precisely why this design uses
// CUSTOM_AUTH. This assertion is what proves the code is actually checked.
test("a wrong OTP code is rejected", async () => {
  // Same headroom as the happy path: this one waits on the real email too, so
  // it needs a budget larger than its own wait (see above).
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await gatewayClient();
  const user = makeUser();

  const reg = await api.post("v1/users/register", { data: user });
  expect(reg.status()).toBe(201);

  const { session, code } = await requestCode(api, user.email);

  // A code that is well-formed (6 digits) but not the delivered one, so the
  // rejection can only come from comparing it — not from failing validation on
  // its shape. Derived from the real code so it can never collide with it.
  const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  expect(wrongCode).not.toBe(code);

  const verify = await api.post("v1/users/otp/verify", {
    data: { email: user.email, session, code: wrongCode },
  });

  expect(verify.status()).toBe(401);
  // `invalid_otp`, not the generic `invalid_credentials` login returns. Being
  // specific is safe here: reaching this endpoint requires a session from an
  // already-started challenge, so the response confirms nothing about whether
  // an account exists — which is precisely why login must stay generic and
  // this need not (see auth-error-mapping.md).
  expect((await verify.json()).error).toBe("invalid_otp");
});

test("a passwordless user registers and signs in entirely without a password", async () => {
  // Passwordless registration also sends a welcome email, so this address gets
  // two messages; the wait is still a single EMAIL_TIMEOUT_MS one (it matches
  // on OTP_SUBJECT), hence the same budget as the tests above.
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await gatewayClient();
  const { email, fullName } = makeUser();

  const reg = await api.post("v1/users/register/passwordless", {
    data: { email, fullName },
  });
  expect(reg.status()).toBe(201);

  const created = await reg.json();
  expect(created.email).toBe(email);
  expect(created.authType).toBe("PASSWORDLESS");

  const { session, code } = await requestCode(api, email);

  const verify = await api.post("v1/users/otp/verify", {
    data: { email, session, code },
  });
  expect(verify.status()).toBe(200);
  expect((await verify.json()).accessToken).toBeTruthy();
});

// MANDATORY ANTI-FALSE-PASS GUARD #2.
//
// Cognito requires SOME password, so a passwordless account is created with a
// random one that is never revealed. That leaves the password flow technically
// available at the Cognito level — the guarantee is enforced in the SERVICE, and
// this is the test that proves it rather than trusting it.
//
// The expected status is 401 `invalid_credentials`, NOT 403: per
// docs/domains/users/decisions/auth-error-mapping.md, login failures stay
// deliberately indistinguishable so an attacker cannot use them to discover
// which accounts exist. A 403 here would confirm the account is real. The
// actual cause is recorded only in the service log as reason=passwordless_user.
test("login with a password is rejected for a passwordless user, indistinguishably", async () => {
  const api = await gatewayClient();
  const { email, fullName, password } = makeUser();

  const reg = await api.post("v1/users/register/passwordless", {
    data: { email, fullName },
  });
  expect(reg.status()).toBe(201);

  const res = await api.post("v1/users/login", { data: { email, password } });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe("invalid_credentials");

  // Indistinguishable from an account that does not exist at all — that
  // equivalence IS the anti-enumeration property, so it is asserted, not
  // assumed.
  const unknown = await api.post("v1/users/login", {
    data: { email: makeUser().email, password },
  });
  expect(unknown.status()).toBe(res.status());
  expect(await unknown.json()).toEqual(await res.json());
});
