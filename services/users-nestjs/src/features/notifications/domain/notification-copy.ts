// CONTRACT: This module is the SINGLE source of rendered notification copy, and it
// is deliberately pure — no db, no logger, no clock. Copy also exists in the
// pipeline's email templates (functions/events-pipeline/emails/), which is the
// accepted consequence of storing rendered text: a copy change here does not
// rewrite rows already stored, exactly as a sent email is not rewritten.
// The FOUR transition titles MATCH tracking-status-changed.tsx's headings; a test
// pins that. "Order placed" is independent — its trigger is ORDER_CREATED, whose
// email is the order-created template ("Order confirmed").
// See [[2026-09-10-in-app-notifications-design]]

/** Drives the toast eyebrow and the CTA. Stored as a column, not in metadata. */
export type NotificationType = "WELCOME" | "ORDER_STATUS";

/**
 * The STORED `metadata.status` domain, five wide. `PLACED` belongs here because a
 * placed notification persists identically to the four tracking-driven ones — only
 * its trigger differs.
 */
export type TrackingStatus =
  | "PLACED"
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

/**
 * What a TRACKING_STATUS_CHANGED EVENT can carry, four wide.
 *
 * CONTRACT: `PLACED` is EXCLUDED and must stay excluded. It is the status a
 * tracking row is created in, never a transition, and Tracking's publisher fires
 * only from the transition path — so no event ever carries it. The PLACED
 * notification is triggered by ORDER_CREATED instead.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export type TrackingEventStatus = Exclude<TrackingStatus, "PLACED">;

/** The four, as a value, so a parser narrows without re-listing them. */
export const TRACKING_EVENT_STATUSES: readonly TrackingEventStatus[] = [
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

export interface NotificationCopy {
  title: string;
  body: string;
}

export interface TrackingCopyInput {
  status: TrackingEventStatus;
  /**
   * The display form from the tracking payload's `order_number.formatted`.
   * CONTRACT: OPTIONAL. The producer omits the key entirely for an order
   * predating the backfill, so an absent value must degrade to the bare
   * sentence rather than rendering a stray separator.
   */
  orderNumberFormatted?: string;
  /** The transition's own timestamp, which two bodies quote. */
  changedAt: string;
}

/** The PLACED variant's input. No timestamp: its body quotes none. */
export interface PlacedCopyInput {
  /** `order_number.formatted` from ORDER_CREATED's payload, absent for an order with none. */
  orderNumberFormatted?: string;
}

/**
 * All five stored titles. The FOUR transition titles match the `COPY` headings in
 * functions/events-pipeline/emails/tracking-status-changed.tsx; "Order placed" is
 * an in-app string with no tracking-template counterpart, since its trigger is
 * ORDER_CREATED. Task 3.3's parity test pins the four and documents the one.
 */
export const TRACKING_TITLES: Readonly<Record<TrackingStatus, string>> = {
  PLACED: "Order placed",
  PROCESSING: "Your order is being prepared",
  SHIPPED: "Your order has shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
};

/** The two transition bodies that need no value from the payload. */
const STATIC_BODIES: Readonly<Record<"PROCESSING" | "SHIPPED", string>> = {
  PROCESSING: "Being picked and packed for shipment.",
  SHIPPED: "Handed to the carrier and on its way to you.",
};

/** The PLACED body, verbatim from the .pen. */
const PLACED_BODY = "Received and confirmed. We'll email your receipt.";

/** The delivery window the OUT_FOR_DELIVERY body promises. */
const DELIVERY_CUTOFF = "6:00 pm";

/**
 * `Aug 5, 3:31 pm` — the form the DELIVERED body quotes, no year.
 * CONTRACT: Formats in UTC. The producer sends a zone-less local timestamp
 * (`2006-01-02T15:04:05`), so the server's zone interpreting it renders a
 * different clock time per deployment for the same stored instant.
 */
function formatStamp(changedAt: string): string {
  // The producer's zone-less form needs an explicit Z, or JS reads it as local.
  const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(changedAt) ? changedAt : `${changedAt}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return changedAt;

  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(date)
      // Intl renders "PM"; the frames render "pm".
      .replace(/\b(AM|PM)\b/, (match) => match.toLowerCase())
      // CONTRACT: Normalise U+202F to a plain space. Some ICU builds separate the
      // time from the meridiem with a NARROW NO-BREAK SPACE, which reads as
      // "3:31 pm" yet fails an equality check against a plain-space expectation.
      .replace(/\u202f/g, " ")
  );
}

/** Prefixes the order number when there is one, and nothing when there is not. */
function withOrderNumber(sentence: string, orderNumberFormatted?: string): string {
  return orderNumberFormatted ? `${orderNumberFormatted} · ${sentence}` : sentence;
}

/** The WELCOME variant. Takes nothing: its copy quotes no value. */
export function welcomeCopy(): NotificationCopy {
  return {
    title: "Welcome to 3MRAI!",
    body: "Your account is ready. Start exploring orders, tracking and more.",
  };
}

/**
 * The PLACED ORDER_STATUS variant.
 *
 * CONTRACT: Triggered by ORDER_CREATED, NOT by a tracking status. Do NOT route it
 * through trackingCopy — no TRACKING_STATUS_CHANGED ever carries PLACED, and a
 * shared entry point invites a parser that accepts one.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export function placedCopy(input: PlacedCopyInput): NotificationCopy {
  return {
    title: TRACKING_TITLES.PLACED,
    body: withOrderNumber(PLACED_BODY, input.orderNumberFormatted),
  };
}

/** One of the four transition ORDER_STATUS variants. */
export function trackingCopy(input: TrackingCopyInput): NotificationCopy {
  const { status, orderNumberFormatted, changedAt } = input;
  const title = TRACKING_TITLES[status];

  if (status === "OUT_FOR_DELIVERY") {
    return {
      title,
      body: withOrderNumber(`Arriving today, by ${DELIVERY_CUTOFF}.`, orderNumberFormatted),
    };
  }

  if (status === "DELIVERED") {
    return {
      title,
      body: withOrderNumber(`Delivered ${formatStamp(changedAt)}.`, orderNumberFormatted),
    };
  }

  return { title, body: withOrderNumber(STATIC_BODIES[status], orderNumberFormatted) };
}
