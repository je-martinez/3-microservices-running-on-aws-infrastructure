import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

// Payload contract — snake_case, matching the envelope and the persisted
// event document (see the events-pipeline design spec's Data Model section
// and this service's CLAUDE.md §6): `order_id`, `user_id`, `email`,
// `total_cents`, `created_at`.
//
// The payload grew from a bare confirmation into a RECEIPT — greeting, money
// breakdown, address and line items — because this service holds no connection
// to the Orders database and can look none of it up. Whatever the email prints
// has to travel on the wire. Verified field-by-field against the producer,
// `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs`
// (its `OrderCreatedPayload` record declares these exact JSON names).
//
// The four money figures are validated as four INDEPENDENT integers and are
// never re-derived from one another. The split was computed once, by the code
// that priced the order; a consumer that recomputed `total` from the other
// three could disagree with the order row it is describing — and the receipt
// would fail the reader's own arithmetic.
//
// `shipping_address` is the one OPTIONAL key, and it is `.optional()` rather
// than `.nullable()` deliberately: the producer serializes with
// `JsonIgnoreCondition.WhenWritingNull`, so a buyer with no address on file
// yields an OMITTED key, never `"shipping_address": null`. Accepting null too
// would give the templates two spellings of "no address" to branch on, against
// the repo-wide "omitted, never null" rule ([[logging-context]]). It is typed
// as a permissive record because the column is a point-in-time SNAPSHOT whose
// shape is owned by Users' `Address` message — a strict object here would
// reject the whole envelope (PermanentError: no email at all) the day an
// upstream field is added, for data this service only forwards to a template.
//
// PII: `email`, `full_name` and `shipping_address` are all personal data. They
// are persisted verbatim on the event document (the audit trail, by design) but
// must NEVER be logged — see the error path below, which reports field PATHS
// only, and this service's CLAUDE.md ("never log `payload`").
const OrderCreatedPayloadSchema = z.object({
  order_id: z.string().min(1),
  user_id: z.string().min(1),
  email: z.string().email(),
  full_name: z.string().min(1),
  subtotal_cents: z.number().int().nonnegative(),
  tax_cents: z.number().int().nonnegative(),
  shipping_cents: z.number().int().nonnegative(),
  total_cents: z.number().int().nonnegative(),
  shipping_address: z.record(z.string(), z.unknown()).optional(),
  // One receipt line. Carries the product's NAME, not its id — an id printed on
  // a customer's receipt is not a receipt. There is deliberately no per-line
  // total on the wire: the template multiplies quantity by unit price, and a
  // second figure could contradict the two it was derived from.
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price_cents: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  created_at: z.string().min(1),
});

// The flow from the milestone design spec's "Email" section, mirroring
// #handlers/user-created: validate payload (Zod) → render the react-email
// template to HTML → SES SendEmail → COMPLETED (the state machine records the
// status; this handler only has to return or throw).
export async function orderCreatedHandler(envelope: Envelope): Promise<void> {
  const result = OrderCreatedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: the payload will not become valid on a redelivery, so the
    // message is consumed and the document recorded FAILED.
    //
    // Only the FIELD PATHS are reported, never Zod's own message — it echoes
    // the offending input, which here is the customer's plaintext email
    // address. This string is persisted on the event document and logged as
    // `reason` (see src/handler.ts), so it must be PII-free by construction.
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid ORDER_CREATED payload: invalid fields: ${fields}`);
  }

  // snake_case wire → camelCase props. The mapping is explicit rather than a
  // spread: the payload's names are the PRODUCER's contract and the props are
  // the TEMPLATE's, and keeping the translation in one visible place is what
  // lets either side be renamed without silently dropping a field.
  //
  // `shippingAddress` stays undefined when the key was absent — the prop is
  // optional for the same reason the wire field is, so a template branches on
  // one absence marker instead of two.
  const html = await renderTemplate("order-created", {
    orderId: result.data.order_id,
    fullName: result.data.full_name,
    subtotalCents: result.data.subtotal_cents,
    taxCents: result.data.tax_cents,
    shippingCents: result.data.shipping_cents,
    totalCents: result.data.total_cents,
    shippingAddress: result.data.shipping_address,
    items: result.data.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
    })),
    createdAt: result.data.created_at,
  });

  // sendEmail classifies its own failures as TransientError, so a SES outage
  // propagates as transient and the record is retried rather than consumed.
  await sendEmail({
    to: result.data.email,
    subject: "Order confirmed",
    html,
    templateKey: "order-created",
  });
}
