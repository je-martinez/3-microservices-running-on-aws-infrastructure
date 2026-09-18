import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  TRACKING_EVENT_STATUSES,
  TRACKING_TITLES,
  placedCopy,
  trackingCopy,
  welcomeCopy,
  type TrackingEventStatus,
} from "#features/notifications/domain/notification-copy";

const ORDER_NUMBER = "ORD-3MRAI-10482";
// The instant the .pen's DELIVERED body quotes: "Delivered Aug 5, 3:31 pm."
const CHANGED_AT = "2026-08-05T15:31:55";

describe("welcomeCopy", () => {
  it("renders the WELCOME variant verbatim", () => {
    expect(welcomeCopy()).toEqual({
      title: "Welcome to 3MRAI!",
      body: "Your account is ready. Start exploring orders, tracking and more.",
    });
  });
});

// CONTRACT: PLACED is triggered by ORDER_CREATED, NOT by a tracking status
// transition — Tracking never emits PLACED. Its copy therefore has its own entry
// point, taking no timestamp because its body quotes none.
describe("placedCopy", () => {
  it("renders the PLACED variant with the order number prefix", () => {
    expect(placedCopy({ orderNumberFormatted: ORDER_NUMBER })).toEqual({
      title: "Order placed",
      body: `${ORDER_NUMBER} · Received and confirmed. We'll email your receipt.`,
    });
  });

  it("tolerates an absent order number", () => {
    const { title, body } = placedCopy({});
    expect(title).toBe("Order placed");
    expect(body).toBe("Received and confirmed. We'll email your receipt.");
    expect(body).not.toContain("undefined");
  });
});

describe("trackingCopy", () => {
  // The two static bodies, verbatim from the .pen's status-variants sheet.
  it.each([
    ["PROCESSING", "Your order is being prepared", "Being picked and packed for shipment."],
    ["SHIPPED", "Your order has shipped", "Handed to the carrier and on its way to you."],
  ] as const)("renders %s with the order number prefix", (status, title, tail) => {
    expect(trackingCopy({ status, orderNumberFormatted: ORDER_NUMBER, changedAt: CHANGED_AT }))
      .toEqual({ title, body: `${ORDER_NUMBER} · ${tail}` });
  });

  // CONTRACT: These two COMPOSE their body from the payload's timestamp rather
  // than using a static string — the .pen bodies quote a date/time.
  it("composes the OUT_FOR_DELIVERY body from the payload timestamp", () => {
    expect(
      trackingCopy({
        status: "OUT_FOR_DELIVERY",
        orderNumberFormatted: ORDER_NUMBER,
        changedAt: CHANGED_AT,
      }),
    ).toEqual({
      title: "Out for delivery",
      body: `${ORDER_NUMBER} · Arriving today, by 6:00 pm.`,
    });
  });

  it("composes the DELIVERED body from the payload timestamp", () => {
    expect(
      trackingCopy({
        status: "DELIVERED",
        orderNumberFormatted: ORDER_NUMBER,
        changedAt: CHANGED_AT,
      }),
    ).toEqual({
      title: "Delivered",
      body: `${ORDER_NUMBER} · Delivered Aug 5, 3:31 pm.`,
    });
  });

  // CONTRACT: `order_number.formatted` is OMITTED when the order has none (an
  // order predating the backfill), so the body must degrade to the bare sentence
  // rather than rendering "undefined · ".
  it.each([
    "PROCESSING",
    "SHIPPED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
  ] as const)("tolerates an absent order number for %s", (status) => {
    const { title, body } = trackingCopy({ status, changedAt: CHANGED_AT });
    expect(title).toBe(TRACKING_TITLES[status]);
    expect(body).not.toContain("undefined");
    expect(body).not.toMatch(/^\s*·/);
  });

  // The STORED domain is five wide (PLACED included, written by the ORDER_CREATED
  // path); the EVENT domain is the four transitions. Asserting both here is what
  // stops a later edit from quietly folding PLACED back into the event list.
  it("exposes all five stored titles", () => {
    expect(Object.keys(TRACKING_TITLES).sort()).toEqual(
      ["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"].sort(),
    );
  });

  it("exposes exactly the four event statuses, PLACED excluded", () => {
    const expected: TrackingEventStatus[] = [
      "PROCESSING",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ];
    expect([...TRACKING_EVENT_STATUSES].sort()).toEqual([...expected].sort());
    expect(TRACKING_EVENT_STATUSES).not.toContain("PLACED");
  });
});

describe("email template parity", () => {
  // CONTRACT: Read the pipeline's source off disk rather than importing it. The
  // two packages have separate dependency trees and this must not couple them at
  // build time — the same approach Tracking's zod_contract_test.go takes against
  // this very directory.
  const TEMPLATE_PATH = fileURLToPath(
    new URL(
      "../../../../../functions/events-pipeline/emails/tracking-status-changed.tsx",
      import.meta.url,
    ),
  );

  /** Pulls `STATUS: { heading: "…" }` pairs out of the template's COPY map. */
  function emailHeadings(): Record<string, string> {
    const source = readFileSync(TEMPLATE_PATH, "utf8");
    const headings: Record<string, string> = {};
    const pattern = /(\w+):\s*\{\s*\n?\s*heading:\s*"([^"]+)"/g;
    for (const match of source.matchAll(pattern)) {
      headings[match[1]!] = match[2]!;
    }
    return headings;
  }

  it("finds the five headings in the template", () => {
    // Guards the regex itself: a template refactor that breaks the match would
    // otherwise make the parity assertion below vacuously pass. The template still
    // declares five, PLACED included — it is provisioned but never rendered.
    const headings = emailHeadings();
    expect(Object.keys(headings).sort()).toEqual(
      ["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"].sort(),
    );
  });

  // CONTRACT: Parity is pinned for the FOUR transition statuses only. For each of
  // those one TRACKING_STATUS_CHANGED produces both the email and the
  // notification, so the two must read the same sentence.
  it("matches every transition title to its email heading", () => {
    const headings = emailHeadings();
    for (const status of TRACKING_EVENT_STATUSES) {
      expect(headings[status]).toBe(TRACKING_TITLES[status]);
    }
  });

  // CONTRACT: "Order placed" is an IN-APP string with no tracking-template
  // counterpart. Its trigger is ORDER_CREATED, whose email is the `order-created`
  // template with subject "Order confirmed"; the tracking-status-changed-placed
  // template is never rendered, because PLACED is never emitted as a tracking
  // status. Do NOT extend the loop above to cover it — that would pin a live
  // string to dead copy. See [[2026-09-10-in-app-notifications-design]]
  it("leaves the PLACED title intentionally unpinned", () => {
    expect(TRACKING_TITLES.PLACED).toBe("Order placed");
    expect(TRACKING_EVENT_STATUSES).not.toContain("PLACED");
  });
});
