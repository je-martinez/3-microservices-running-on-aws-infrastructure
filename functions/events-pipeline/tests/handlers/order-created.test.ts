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
// Required by the schema since the templates moved to remote images. The
// renderer reads it to build every <img src>, so it must be a valid absolute
// URL with no trailing slash; nothing here fetches it.
vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");

// The sender is the ONLY mocked collaborator: it is the process boundary (SES
// over the network). The renderer and the catalog run for real, so a template
// that throws fails this test rather than passing against a stub. Mirrors
// tests/handlers/user-created.test.ts.
vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

// Dynamic import, AFTER the vi.stubEnv calls above: static imports are
// hoisted above all other module code (including vi.stubEnv), so importing
// #handlers/order-created or #handlers/index at the top of the file would
// evaluate #shared/config/env before the stubs exist. Mirrors
// tests/handler.test.ts.
const { orderCreatedHandler } = await import("#handlers/order-created");
const { handlers } = await import("#handlers/index");

function envelope(payload: Record<string, unknown>, event_id = "evt_order_1"): Envelope {
  return {
    event_id,
    type: "ORDER_CREATED",
    source: "orders",
    user_id: "usr_1",
    order_id: "ord_1",
    author: { actor: "orders_api:create_order", user_id: "usr_1", cognito_sub: "sub-1" },
    payload,
  };
}

// The shape SqsEventPublisher actually puts on the wire — the receipt the
// confirmation email renders, not just the acknowledgement it used to be.
// Figures balance: 2×1200 + 1×599 = 2999 subtotal, +240 tax +1500 shipping =
// 4739. A fixture whose arithmetic did not add up would let a handler that
// crossed two of the four figures pass.
const validPayload = {
  order_id: "ord_1",
  user_id: "usr_1",
  email: "ada@example.com",
  full_name: "Ada Lovelace",
  subtotal_cents: 2999,
  tax_cents: 240,
  shipping_cents: 1500,
  total_cents: 4739,
  shipping_address: {
    line1: "1 Ada Way",
    city: "San Juan",
    country: "PR",
    postal_code: "00901",
  },
  items: [
    { name: "Mechanical Keyboard", quantity: 2, unit_price_cents: 1200 },
    { name: "USB-C Cable", quantity: 1, unit_price_cents: 599 },
  ],
  created_at: "2026-08-03T12:00:00.000Z",
};

describe("orderCreatedHandler", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it("validates, renders, and sends an order confirmation email to the payload's address", async () => {
    await orderCreatedHandler(envelope(validPayload));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
  });

  // Without this the previous test would still pass against a handler that
  // sends a hardcoded/empty body — asserting only the recipient proves nothing
  // about the render actually reaching the transport.
  it("sends the RENDERED template as the html body, personalised with the payload", async () => {
    await orderCreatedHandler(envelope(validPayload));

    const [params] = vi.mocked(sendEmail).mock.calls[0];
    expect(params.html).toContain("<html");
    expect(params.html).toContain("ord_1");
    expect(params.subject.length).toBeGreaterThan(0);
  });

  // total_cents is an integer of cents (4739 = $47.39). Pinning the exact
  // formatted string means a future change to the conversion (e.g. dropping
  // the divide-by-100, or a locale change) fails this test loudly instead of
  // silently mailing "$4739" for forty-seven dollars and thirty-nine cents.
  it("renders total_cents as a human-readable dollar amount", async () => {
    await orderCreatedHandler(envelope(validPayload));

    const [params] = vi.mocked(sendEmail).mock.calls[0];
    expect(params.html).toContain("$47.39");
  });

  it("throws PermanentError on a payload missing required fields, and sends nothing", async () => {
    await expect(
      orderCreatedHandler(envelope({ order_id: "ord_2" }, "evt_order_2")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws PermanentError on a malformed email address, and sends nothing", async () => {
    await expect(
      orderCreatedHandler(
        envelope({ ...validPayload, email: "not-an-email" }, "evt_order_3"),
      ),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws PermanentError on a negative total_cents, and sends nothing", async () => {
    await expect(
      orderCreatedHandler(envelope({ ...validPayload, total_cents: -1 }, "evt_order_4")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Scope, stated honestly: this covers only that the handler does NOT swallow
  // a transport failure — it must propagate so process-record can persist
  // FAILED and classify the record. It deliberately rejects with a PLAIN
  // Error, not a TransientError — see the comment in
  // tests/handlers/user-created.test.ts for why asserting a mock's own
  // configured rejection proves nothing about real classification.
  it("does not swallow a transport failure — it propagates to the caller", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("transport exploded"));

    await expect(
      orderCreatedHandler(envelope(validPayload, "evt_order_5")),
    ).rejects.toThrow("transport exploded");
  });

  // The validation error must NOT echo the payload: it carries the user's
  // plaintext email, and process-record persists this message on the FAILED
  // document and the entrypoint logs it as `reason`.
  it("does not leak the payload's email address in the PermanentError message", async () => {
    // `email` itself is the field that fails validation here (malformed, not
    // missing) so the payload FAILS validation while still carrying a real
    // address — the case where a naive `error.message` would echo the whole
    // offending input, address included. Mirrors
    // tests/handlers/user-created.test.ts's equivalent case.
    const leakyEmail = "leaky-order-recipient@example.com";
    const error = await orderCreatedHandler(
      envelope({ ...validPayload, email: `${leakyEmail}-not-an-email` }, "evt_order_6"),
    ).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).not.toContain(leakyEmail);
  });
});

describe("handler registry", () => {
  // The dispatch-map claim from the design spec: adding a type is ONE entry.
  // Task 10 registered USER_CREATED; this asserts Task 11 registered
  // ORDER_CREATED the same way, with no change to process-record.ts.
  it("registers ORDER_CREATED against the order-created handler", () => {
    expect(handlers.ORDER_CREATED).toBe(orderCreatedHandler);
  });
});
