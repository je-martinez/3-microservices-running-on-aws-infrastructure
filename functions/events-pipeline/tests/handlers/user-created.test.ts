import { describe, it, expect, vi, beforeEach } from "vitest";

// The sender is the ONLY mocked collaborator: it is the process boundary (SES
// over the network). The renderer and the catalog run for real, so a template
// that throws fails this test rather than passing against a stub.
vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { userCreatedHandler } from "#handlers/user-created";
import { handlers } from "#handlers/index";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

// The payload EXACTLY as `services/users/src/shared/messaging/event-publisher.ts`
// puts it on the wire: `{ email, fullName, userId, createdAt }`, camelCase (that
// payload's own convention — the envelope around it is snake_case), with
// `createdAt` already serialized to ISO-8601 by the publisher.
//
// Declared as a factory with defaults so each test overrides ONLY the field it is
// about. Pasting the whole enriched payload at every call site is what let the
// fixtures drift from the producer in the first place: a test about a transport
// failure has no business restating four unrelated fields.
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "ada@example.com",
    fullName: "Ada Lovelace",
    userId: "usr_1",
    createdAt: "2026-08-05T12:00:00.000Z",
    ...overrides,
  };
}

function envelope(payload: Record<string, unknown>, event_id = "evt_1"): Envelope {
  return {
    event_id,
    type: "USER_CREATED",
    source: "users",
    user_id: "usr_1",
    order_id: null,
    author: { actor: "users_api:register", user_id: "usr_1", cognito_sub: "sub-1" },
    payload,
  };
}

describe("userCreatedHandler", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("validates, renders, and sends an email to the payload's address", async () => {
    await userCreatedHandler(envelope(validPayload()));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com" }),
    );
  });

  // Without this the previous test would still pass against a handler that
  // sends a hardcoded/empty body — asserting only the recipient proves nothing
  // about the render actually reaching the transport.
  it("sends the RENDERED template as the html body, personalised with the payload", async () => {
    await userCreatedHandler(envelope(validPayload()));

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

  // One case per ENRICHMENT field, each checked in isolation. The combined test
  // above cannot distinguish "the schema requires all four" from "the schema
  // requires the two it always did": a payload missing everything throws either
  // way. These pin that a payload otherwise complete but missing exactly ONE of
  // the fields the producer now publishes is rejected as a PermanentError — the
  // regression the widened schema exists to catch.
  it.each(["userId", "createdAt"])(
    "rejects a payload missing only %s as a PermanentError, and sends nothing",
    async (missingField) => {
      const payload = validPayload();
      delete payload[missingField];

      const error = await userCreatedHandler(envelope(payload, `evt_missing_${missingField}`)).catch(
        (err: unknown) => err as Error,
      );

      expect(error).toBeInstanceOf(PermanentError);
      expect(error.message).toContain(missingField);
      expect(sendEmail).not.toHaveBeenCalled();
    },
  );

  it("throws PermanentError on a malformed email address, and sends nothing", async () => {
    await expect(
      userCreatedHandler(envelope(validPayload({ email: "not-an-email" }), "evt_3")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Scope, stated honestly: this covers only that the handler does NOT swallow
  // a transport failure — it must propagate so process-record can persist
  // FAILED and classify the record.
  //
  // It deliberately rejects with a PLAIN Error. Rejecting with a TransientError
  // and then asserting TransientError would only prove that the mock returns
  // what the mock was configured to return: no change to sender.ts could ever
  // fail it. The actual TransientError-vs-PermanentError classification lives
  // in sender.ts and is covered against a real failing send in
  // tests/email/sender.test.ts — which exists precisely because a mutation of
  // that classification left this file green.
  it("does not swallow a transport failure — it propagates to the caller", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("transport exploded"));

    await expect(userCreatedHandler(envelope(validPayload(), "evt_4"))).rejects.toThrow(
      "transport exploded",
    );
  });

  // The validation error must NOT echo the payload: it carries the user's
  // plaintext email, and process-record persists this message on the FAILED
  // document and the entrypoint logs it as `reason`.
  it("does not leak the payload's email address in the PermanentError message", async () => {
    // `fullName` is empty so the payload FAILS validation while still carrying
    // a real address — the case where a naive `error.message` would echo the
    // whole offending input, address included.
    const error = await userCreatedHandler(
      envelope(validPayload({ fullName: "", email: "leaky@example.com" }), "evt_5"),
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
