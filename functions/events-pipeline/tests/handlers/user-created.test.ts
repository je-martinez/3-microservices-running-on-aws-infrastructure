import { describe, it, expect, vi, beforeEach } from "vitest";

// The sender is the ONLY mocked collaborator: it is the process boundary (SES
// over the network). The renderer and the catalog run for real, so a template
// that throws fails this test rather than passing against a stub.
vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { userCreatedHandler } from "#handlers/user-created";
import { handlers } from "#handlers/index";
import { sendEmail } from "#email/sender";
import { PermanentError, TransientError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

function envelope(payload: Record<string, unknown>, event_id = "evt_1"): Envelope {
  return {
    event_id,
    type: "USER_CREATED",
    source: "users",
    user_id: "usr_1",
    order_id: null,
    payload,
  };
}

describe("userCreatedHandler", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("validates, renders, and sends an email to the payload's address", async () => {
    await userCreatedHandler(envelope({ fullName: "Ada Lovelace", email: "ada@example.com" }));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com" }),
    );
  });

  // Without this the previous test would still pass against a handler that
  // sends a hardcoded/empty body — asserting only the recipient proves nothing
  // about the render actually reaching the transport.
  it("sends the RENDERED template as the html body, personalised with the payload", async () => {
    await userCreatedHandler(envelope({ fullName: "Ada Lovelace", email: "ada@example.com" }));

    const [params] = vi.mocked(sendEmail).mock.calls[0];
    expect(params.html).toContain("<html");
    expect(params.html).toContain("Ada Lovelace");
    expect(params.html).toContain("ada@example.com");
    expect(params.subject.length).toBeGreaterThan(0);
  });

  it("throws PermanentError on a payload missing required fields, and sends nothing", async () => {
    await expect(userCreatedHandler(envelope({ fullName: "No Email" }, "evt_2"))).rejects.toThrow(
      PermanentError,
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws PermanentError on a malformed email address, and sends nothing", async () => {
    await expect(
      userCreatedHandler(envelope({ fullName: "Ada", email: "not-an-email" }, "evt_3")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Classification is the whole point of the error split: a SES outage must
  // stay TRANSIENT so the record is retried, not swallowed as a permanent
  // failure that consumes the message and loses the user's email.
  it("propagates a transport failure as TransientError, not PermanentError", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new TransientError("SES send failed: boom"));

    await expect(
      userCreatedHandler(envelope({ fullName: "Ada", email: "ada@example.com" }, "evt_4")),
    ).rejects.toThrow(TransientError);
  });

  // The validation error must NOT echo the payload: it carries the user's
  // plaintext email, and process-record persists this message on the FAILED
  // document and the entrypoint logs it as `reason`.
  it("does not leak the payload's email address in the PermanentError message", async () => {
    // `fullName` is empty so the payload FAILS validation while still carrying
    // a real address — the case where a naive `error.message` would echo the
    // whole offending input, address included.
    const error = await userCreatedHandler(
      envelope({ fullName: "", email: "leaky@example.com" }, "evt_5"),
    ).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).not.toContain("leaky@example.com");
  });
});

describe("handler registry", () => {
  // The dispatch-map claim from the design spec: adding a type is ONE entry.
  // Task 11 adds ORDER_CREATED to the same map.
  it("registers USER_CREATED against the user-created handler", () => {
    expect(handlers.USER_CREATED).toBe(userCreatedHandler);
  });
});
