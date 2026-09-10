import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { OrderNumberSchema } from "#domain/order-number";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { HandlerDeps } from "#pipeline/process-record";

// CONTRACT: The four money figures are four INDEPENDENT integers. Do NOT
// re-derive `total_cents` from the other three — the split was computed once by
// the code that priced the order, and a recomputed total can contradict the row
// the receipt describes.
// See [[money-representation]]

// CONTRACT: `shipping_address` is `.optional()`, never `.nullable()` — the
// producer omits the key rather than sending null, and accepting both gives the
// templates two spellings of "no address". It stays a permissive record because
// the snapshot's shape is owned by Users; a strict object rejects the whole
// envelope (PermanentError, no email at all) when an upstream field is added.
// See [[logging-context]]

// WARNING: PII. `email`, `full_name` and `shipping_address` are persisted on the
// event document by design but must never be logged.
const OrderCreatedPayloadSchema = z.object({
  order_id: z.string().min(1),
  // CONTRACT: OPTIONAL, for the same reason `request_id` is — a message published
  // before this field existed can still be on the queue at deploy time, and a
  // schema failure is a PermanentError whose email is never sent.
  // See [[friendly-order-number]]
  order_number: OrderNumberSchema.optional(),
  user_id: z.string().min(1),
  email: z.string().email(),
  full_name: z.string().min(1),
  subtotal_cents: z.number().int().nonnegative(),
  tax_cents: z.number().int().nonnegative(),
  shipping_cents: z.number().int().nonnegative(),
  total_cents: z.number().int().nonnegative(),
  shipping_address: z.record(z.string(), z.unknown()).optional(),
  // CONTRACT: A receipt line carries the product NAME, not its id, and no
  // per-line total — the template multiplies quantity by unit price, and a
  // second figure on the wire can contradict the two it came from.
  // See [[money-representation]]
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

// validate (Zod) → render the react-email template → SES SendEmail. The state
// machine records the status; this handler returns or throws.
export async function orderCreatedHandler(envelope: Envelope, deps: HandlerDeps = {}): Promise<void> {
  const result = OrderCreatedPayloadSchema.safeParse(envelope.payload);

  if (!result.success) {
    // PERMANENT: a redelivery cannot make this payload valid.
    // CONTRACT: Report FIELD PATHS only, never Zod's message — it echoes the
    // offending input, here the customer's plaintext email. This string is
    // persisted and logged as `reason`, so it must be PII-free by construction.
    // See [[logging-context]]
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new PermanentError(`invalid ORDER_CREATED payload: invalid fields: ${fields}`);
  }

  // WHY: Explicit mapping, not a spread — the wire names are the producer's
  // contract and the props are the template's, so either side can be renamed
  // without silently dropping a field. An absent `shippingAddress` stays
  // undefined, so a template branches on one absence marker.
  const html = await renderTemplate("order-created", {
    orderId: result.data.order_id,
    // CONTRACT: Pass the whole object through; the template renders `formatted`
    // verbatim and falls back to the id when it is absent. Do NOT build the
    // displayed form here — the server owns that rule.
    orderNumber: result.data.order_number,
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
    // No `code`: this template carries none.
    recordEmail: deps.recordEmail,
  });
}
