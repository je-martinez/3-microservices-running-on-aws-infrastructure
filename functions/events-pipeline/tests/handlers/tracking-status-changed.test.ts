import { describe, it, expect, vi, beforeEach } from "vitest";

// The sender is the ONLY mocked collaborator: it is the process boundary (SES
// over the network). The renderer and the catalog run for real, so a template
// that throws fails this test rather than passing against a stub. Same
// reasoning as tests/handlers/user-created.test.ts.
vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";
import { handlers } from "#handlers/index";
import { sendEmail } from "#email/sender";
import { renderTemplate } from "#email/renderer";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

function makeEnvelope(status: string, previousStatus: string, event_id?: string): Envelope {
  return {
    event_id: event_id ?? `evt_tracking_${status.toLowerCase()}`,
    type: "TRACKING_STATUS_CHANGED",
    source: "tracking",
    user_id: "usr_1",
    order_id: "ord_1",
    author: { actor: "tracking_api:carrier_status_update" },
    payload: {
      status,
      previous_status: previousStatus,
      changed_at: "2026-08-03T12:00:00.000Z",
      email: "ada@example.com",
    },
  };
}

describe("trackingStatusChangedHandler", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
  });

  it.each([
    ["SHIPPED", "null"],
    ["ON_THE_WAY", "SHIPPED"],
    ["OUT_FOR_DELIVERY", "ON_THE_WAY"],
    ["DELIVERED", "OUT_FOR_DELIVERY"],
  ])("selects the %s template variant and sends an email", async (status, previous) => {
    await trackingStatusChangedHandler(makeEnvelope(status, previous));

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
  });

  // Without this, the previous test would still pass against a handler that
  // sends a hardcoded/empty body — asserting only the recipient proves
  // nothing about the render actually reaching the transport, nor that each
  // status maps to ITS OWN copy rather than one shared/generic string.
  //
  // Comparing every pair (not just SHIPPED vs DELIVERED) matters: a handler
  // that collapses ON_THE_WAY/OUT_FOR_DELIVERY onto the SHIPPED template
  // still passes a two-variant check as long as DELIVERED stays distinct.
  it("renders status-specific copy into the html body for each of the four variants", async () => {
    const bodies: Record<string, string> = {};
    for (const [status, previous] of [
      ["SHIPPED", "null"],
      ["ON_THE_WAY", "SHIPPED"],
      ["OUT_FOR_DELIVERY", "ON_THE_WAY"],
      ["DELIVERED", "OUT_FOR_DELIVERY"],
    ] as const) {
      vi.mocked(sendEmail).mockClear();
      await trackingStatusChangedHandler(makeEnvelope(status, previous, `evt_copy_${status}`));
      const [params] = vi.mocked(sendEmail).mock.calls[0];
      expect(params.html).toContain("ord_1");
      bodies[status] = params.html;
    }

    expect(bodies.SHIPPED).toContain("shipped");
    expect(bodies.DELIVERED).toContain("Delivered");

    const statuses = Object.keys(bodies);
    for (let i = 0; i < statuses.length; i += 1) {
      for (let j = i + 1; j < statuses.length; j += 1) {
        expect(bodies[statuses[i]], `${statuses[i]} vs ${statuses[j]} rendered identically`).not.toEqual(
          bodies[statuses[j]],
        );
      }
    }
  });

  it("renders the DELIVERED variant distinctly (no transition is exempt from email)", async () => {
    await trackingStatusChangedHandler(makeEnvelope("DELIVERED", "OUT_FOR_DELIVERY"));

    const html = await renderTemplate("tracking-status-changed-delivered", {
      orderId: "ord_1",
      status: "DELIVERED",
      previousStatus: "OUT_FOR_DELIVERY",
    });
    expect(html).toContain("Delivered");
  });

  it("throws PermanentError on an unknown status, and sends nothing", async () => {
    await expect(
      trackingStatusChangedHandler(makeEnvelope("LOST_IN_TRANSIT", "SHIPPED")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws PermanentError on a payload missing required fields, naming those fields, and sends nothing", async () => {
    const envelope: Envelope = {
      event_id: "evt_tracking_bad",
      type: "TRACKING_STATUS_CHANGED",
      source: "tracking",
      user_id: "usr_1",
      order_id: "ord_1",
      author: { actor: "tracking_api:carrier_status_update" },
      payload: { status: "SHIPPED" }, // missing previous_status, changed_at, email
    };

    const error = await trackingStatusChangedHandler(envelope).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    // Pins the failure to the ACTUAL missing fields, not merely "it threw" —
    // a schema mutation that silently defaults one of the three away (e.g.
    // `.optional().default(...)`) still throws for the OTHER two but must
    // not be able to hide behind a loose `.rejects.toThrow(PermanentError)`.
    expect(error.message).toContain("previous_status");
    expect(error.message).toContain("changed_at");
    expect(error.message).toContain("email");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // Each field checked in isolation: a schema that defaults away exactly ONE
  // required field (leaving the other two intact) would still satisfy the
  // combined test above by accident if that test only checked "it throws".
  it.each(["previous_status", "changed_at", "email"])(
    "rejects a payload missing only %s",
    async (missingField) => {
      const fullPayload: Record<string, unknown> = {
        status: "SHIPPED",
        previous_status: "null",
        changed_at: "2026-08-03T12:00:00.000Z",
        email: "ada@example.com",
      };
      delete fullPayload[missingField];

      const envelope: Envelope = {
        event_id: `evt_missing_${missingField}`,
        type: "TRACKING_STATUS_CHANGED",
        source: "tracking",
        user_id: "usr_1",
        order_id: "ord_1",
        author: { actor: "tracking_api:carrier_status_update" },
        payload: fullPayload,
      };

      const error = await trackingStatusChangedHandler(envelope).catch(
        (err: unknown) => err as Error,
      );
      expect(error).toBeInstanceOf(PermanentError);
      expect(error.message).toContain(missingField);
      expect(sendEmail).not.toHaveBeenCalled();
    },
  );

  // The validation error must NOT echo the payload: it may carry the
  // recipient's plaintext email, and process-record persists this message on
  // the FAILED document and the entrypoint logs it as `reason`.
  it("does not leak the payload's email address in the PermanentError message", async () => {
    const envelope: Envelope = {
      event_id: "evt_tracking_leak",
      type: "TRACKING_STATUS_CHANGED",
      source: "tracking",
      user_id: "usr_1",
      order_id: "ord_1",
      author: { actor: "tracking_api:carrier_status_update" },
      payload: {
        status: "LOST_IN_TRANSIT",
        previous_status: "SHIPPED",
        changed_at: "2026-08-03T12:00:00.000Z",
        email: "leaky@example.com",
      },
    };

    const error = await trackingStatusChangedHandler(envelope).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).not.toContain("leaky@example.com");
  });

  // Scope, stated honestly: this covers only that the handler does NOT
  // swallow a transport failure — it must propagate so process-record can
  // persist FAILED and classify the record. It deliberately rejects with a
  // PLAIN Error rather than a TransientError: rejecting with a TransientError
  // and then asserting TransientError would only prove the mock returns what
  // it was configured to return (see tests/handlers/user-created.test.ts for
  // the fuller explanation). The real classification lives in sender.ts and
  // is covered against a real failing send in tests/email/sender.test.ts.
  it("does not swallow a transport failure — it propagates to the caller", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("transport exploded"));

    await expect(
      trackingStatusChangedHandler(makeEnvelope("SHIPPED", "null", "evt_transport")),
    ).rejects.toThrow("transport exploded");
  });
});

describe("handler registry", () => {
  // The dispatch-map claim from the design spec, mirror image of Task 11:
  // ONE event type fans out to FOUR rendered variants without a second
  // dispatch entry — the fan-out lives inside the handler (by payload.status),
  // not as four HandlerMap keys.
  it("registers TRACKING_STATUS_CHANGED against the tracking-status-changed handler", () => {
    expect(handlers.TRACKING_STATUS_CHANGED).toBe(trackingStatusChangedHandler);
  });
});
