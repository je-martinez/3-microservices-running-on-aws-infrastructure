import { describe, it, expect, vi, beforeEach } from "vitest";

// #shared/config/env parses process.env at MODULE LOAD (ADR-0014). This file
// imports #handlers/index, which now (since the realtime fan-out landed in
// tracking-status-changed.ts) transitively pulls in
// #shared/realtime/websocket-publisher -> #shared/logging/app-logger ->
// #shared/config/env, so the schema must be satisfied even though this
// suite never exercises tracking-status-changed itself. Mirrors
// tests/handler.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");

// The sender is the ONLY mocked collaborator: it is the process boundary (SES
// over the network). The renderer and the catalog run for real, so a template
// that throws fails this test rather than passing against a stub.
vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

// Dynamic import, AFTER the vi.stubEnv calls above: static imports are
// hoisted above all other module code (including vi.stubEnv), so importing
// #handlers/user-created or #handlers/index at the top of the file would
// evaluate #shared/config/env before the stubs exist. Mirrors
// tests/handler.test.ts.
const { userCreatedHandler } = await import("#handlers/user-created");
const { handlers } = await import("#handlers/index");

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

    await expect(
      userCreatedHandler(envelope({ fullName: "Ada", email: "ada@example.com" }, "evt_4")),
    ).rejects.toThrow("transport exploded");
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
