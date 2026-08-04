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
// ANTICIPATED CONTRACT, not yet emitted by Orders: as of this task, Orders'
// publisher seam (`services/orders/src/Orders.Infrastructure/Messaging/
// NoopEventPublisher.cs`, `IEventPublisher.PublishOrderCreatedAsync`) only
// carries `orderId, userId, totalCents, createdAt` — no email. `email` is
// added here because Orders already resolves it on every order creation via
// `GetUserById` (see `proto/users.proto`'s `UserResponse.email`) when
// building `CallerProfile`
// (`services/orders/src/Orders.Application/Identity/CallerProfile.cs`), which
// today only snapshots the delivery address and does not carry email.
//
// Whoever implements Task 13 (wiring Orders' real SQS publisher) must extend
// `CallerProfile` to carry `Email` and thread it through
// `PublishOrderCreatedAsync` into the message body, mapping the C#
// camelCase/PascalCase parameters onto these snake_case wire fields — exactly
// as Users' publisher already does for USER_CREATED. Until then, this handler
// cannot be exercised against Orders' real output; only USER_CREATED can end
// to end.
const OrderCreatedPayloadSchema = z.object({
  order_id: z.string().min(1),
  user_id: z.string().min(1),
  email: z.string().email(),
  total_cents: z.number().int().nonnegative(),
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

  const html = await renderTemplate("order-created", {
    orderId: result.data.order_id,
    totalCents: result.data.total_cents,
  });

  // sendEmail classifies its own failures as TransientError, so a SES outage
  // propagates as transient and the record is retried rather than consumed.
  await sendEmail({
    to: result.data.email,
    subject: "Order confirmed",
    html,
  });
}
