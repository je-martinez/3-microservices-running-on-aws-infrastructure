import { describe, it, expect, vi, beforeEach } from "vitest";

// The sender is the ONLY mocked collaborator: it is the process boundary (SES
// over the network). The renderer and the catalog run for real, so the
// assertion that the rendered HTML carries the code actually proves the
// template surfaces it, rather than passing against a stub.
vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { authOtpRequestedHandler } from "#handlers/auth-otp-requested";
import { handlers } from "#handlers/index";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

// The payload EXACTLY as `infra/modules/cognito/otp-challenge-lambda/index.mjs`
// puts it on the wire: `{ email, full_name, code, ttlSeconds }` — `full_name` in
// the producer's snake_case spelling next to camelCase `ttlSeconds`, because that
// is literally what is published (see the handler's schema comment).
//
// `full_name` defaults to a real name here so the ordinary cases read naturally;
// the `""` case Cognito actually produces today has its own test below.
//
// A factory with defaults so each test overrides only the field it is about.
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "ada@example.com",
    full_name: "Ada Lovelace",
    code: "042817",
    ttlSeconds: 300,
    ...overrides,
  };
}

function envelope(payload: Record<string, unknown>, event_id = "evt_otp1"): Envelope {
  return {
    event_id,
    type: "AUTH_OTP_REQUESTED",
    source: "users",
    user_id: "usr_1",
    order_id: null,
    author: { actor: "users_api:start_otp_challenge", user_id: "usr_1", cognito_sub: "sub-1" },
    payload,
  };
}

describe("authOtpRequestedHandler", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("validates, renders, and sends the email to the payload's address", async () => {
    await authOtpRequestedHandler(envelope(validPayload()));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
  });

  // `full_name` is REQUIRED (a plain `z.string()`), so an omitted key is a
  // PermanentError even though an EMPTY one is fine. Both halves matter and are
  // asserted separately: the producer always sends the key and falls back to `""`
  // precisely so a nameless user still gets their login code.
  it("rejects a payload missing only full_name as a PermanentError, and sends nothing", async () => {
    const payload = validPayload();
    delete payload.full_name;

    const error = await authOtpRequestedHandler(
      envelope(payload, "evt_otp_missing_name"),
    ).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).toContain("full_name");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("accepts an EMPTY full_name — the producer's normal path — and still sends", async () => {
    // Cognito populates no `name` attribute today, so `""` is what the OTP
    // Lambda actually publishes. A schema that rejected it would cost the user
    // their login code over a missing greeting.
    await authOtpRequestedHandler(envelope(validPayload({ full_name: "" }), "evt_otp_noname"));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
  });

  // The load-bearing assertion for the gateway E2E: that spec extracts the code
  // from the delivered message body with a plain 6-digit match, so the rendered
  // HTML has to contain it as visible text. If the template ever stops
  // surfacing it (an image, an obfuscated span, a dropped prop), this fails
  // here instead of in a flaky browser test.
  it("renders the OTP code into the html body", async () => {
    await authOtpRequestedHandler(envelope(validPayload()));

    const [params] = vi.mocked(sendEmail).mock.calls[0];
    expect(params.html).toContain("<html");
    expect(params.html).toContain("042817");
    expect(params.subject.length).toBeGreaterThan(0);
  });

  it("renders the TTL in minutes, converted from the payload's seconds", async () => {
    await authOtpRequestedHandler(envelope(validPayload()));

    const [params] = vi.mocked(sendEmail).mock.calls[0];
    expect(params.html).toContain("5");
  });

  it("throws PermanentError on a payload missing required fields, and sends nothing", async () => {
    await expect(
      authOtpRequestedHandler(envelope({ email: "ada@example.com" }, "evt_otp2")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws PermanentError on a malformed email address, and sends nothing", async () => {
    await expect(
      authOtpRequestedHandler(envelope(validPayload({ email: "not-an-email" }), "evt_otp3")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Stricter than the USER_CREATED case: the payload carries a LIVE CREDENTIAL,
  // and process-record persists this message on the FAILED document while the
  // entrypoint logs it as `reason`. Zod's own message would echo the offending
  // input, so the handler reports field paths only.
  it("does not leak the OTP code in the PermanentError message", async () => {
    // `email` is malformed so the payload FAILS validation while still carrying
    // a well-formed code — the case where a naive `error.message` would echo
    // the whole offending input, code included.
    const error = await authOtpRequestedHandler(
      envelope(validPayload({ email: "not-an-email" }), "evt_otp4"),
    ).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).not.toContain("042817");
  });

  it("does not leak the recipient's email address in the PermanentError message", async () => {
    const error = await authOtpRequestedHandler(
      envelope(validPayload({ email: "leaky@example.com", code: "" }), "evt_otp5"),
    ).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).not.toContain("leaky@example.com");
  });

  // Scope, stated honestly: this covers only that the handler does NOT swallow
  // a transport failure — it must propagate so process-record can persist
  // FAILED and classify the record. The TransientError-vs-PermanentError
  // classification itself lives in sender.ts and is covered there.
  it("does not swallow a transport failure — it propagates to the caller", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("transport exploded"));

    await expect(
      authOtpRequestedHandler(envelope(validPayload(), "evt_otp6")),
    ).rejects.toThrow("transport exploded");
  });
});

describe("handler registry", () => {
  // The dispatch-map claim from the design spec: adding a type is ONE entry.
  it("registers AUTH_OTP_REQUESTED against the auth-otp-requested handler", () => {
    expect(handlers.AUTH_OTP_REQUESTED).toBe(authOtpRequestedHandler);
  });
});
